import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  AttachmentBuilder,
  AuditLogEvent,
  AutoModerationRuleTriggerType,
  ChannelType,
  ContextMenuCommandBuilder,
  GuildMember,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  Role,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type UserContextMenuCommandInteraction,
  type MessageContextMenuCommandInteraction
} from "discord.js";
import { type CommandModule } from "../Modules/commandRegistry.js";
import { buildInspectModal } from "../Internals/Modals/inspectModal.js";
import {
  buildInspectPayload,
  buildContextInspectPayload,
  sanitizeInspectFilename,
  toRawInspectData
} from "../Internals/Messages/inspectMessage.js";

type InspectKind = "user" | "role" | "channel" | "automod" | "logs" | "message";

const contextTargetCache = new Map<string, unknown>();

function getMention(interaction: ChatInputCommandInteraction): string | undefined {
  const mentionable = interaction.options.getMentionable("mention");
  if (!mentionable) return undefined;
  if (!("id" in mentionable)) return undefined;
  return mentionable instanceof Role
    ? `<@&${mentionable.id}>`
    : `<@${mentionable.id}>`;
}

/**
 * Resolves inspected user data differently by interaction context.
 *
 * Inside a guild, member fields such as nickname, roles, joined state, and
 * guild permissions are the primary payload. Outside a guild, the global
 * Discord user object is used. OAuth user-install data is not required.
 *
 * @param interaction Chat or context interaction.
 * @param userId Discord user snowflake.
 * @returns A guild member or global user object.
 */
async function resolveInspectUser(
  interaction:
    | ChatInputCommandInteraction
    | UserContextMenuCommandInteraction
    | ModalSubmitInteraction,
  userId: string
): Promise<{ id: string; name: string; data: unknown } | null> {
  if (interaction.inGuild() && interaction.guild) {
    switch (true) {
      case Boolean(interaction.guild.members.cache.has(userId)):
        return {
          id: userId,
          name: interaction.guild.members.cache.get(userId)?.displayName ?? userId,
          data: interaction.guild.members.cache.get(userId)
        };
      default: {
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (member) {
          return {
            id: member.id,
            name: member.displayName,
            data: member
          };
        }
      }
    }
  }

  const user = await interaction.client.users.fetch(userId).catch(() => null);
  if (!user) return null;
  return { id: user.id, name: user.username, data: user };
}

/**
 * Determines public versus ephemeral delivery for slash and context actions.
 * A missing Use External Apps permission forces ephemeral delivery.
 */
async function canSendPublicly(
  interaction:
    | ChatInputCommandInteraction
    | UserContextMenuCommandInteraction
    | MessageContextMenuCommandInteraction
    | ModalSubmitInteraction
): Promise<boolean> {
  if (!interaction.inGuild()) return true;
  if (!interaction.guild) return false;

  const channel = interaction.channel;
  if (!channel || !("guild" in channel)) return false;

  const member = interaction.member instanceof GuildMember
    ? interaction.member
    : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return false;

  const channelPermissions = member.permissionsIn(channel);
  return channelPermissions.has([
    PermissionFlagsBits.UseExternalApps,
    PermissionFlagsBits.SendMessages
  ]);
}

async function resolveEphemeral(
  interaction: ChatInputCommandInteraction
): Promise<boolean> {
  const requested = interaction.options.getBoolean("ephemeral");
  if (requested === null) return true;
  if (requested === true) return true;
  return !(await canSendPublicly(interaction));
}

async function fetchInspectData(
  interaction: ChatInputCommandInteraction,
  kind: InspectKind
): Promise<{ id: string; name: string; data: unknown } | null> {
  if (kind === "user") {
    const id = interaction.options.getString("id", true).trim();
    if (!/^\d{17,20}$/.test(id)) throw new Error("Provide a valid Discord user ID.");
    const result = await resolveInspectUser(interaction, id);
    if (!result) throw new Error("Could not find that user or guild member.");
    return result;
  }

  if (kind === "role") {
    if (!interaction.guild) throw new Error("Roles can only be inspected inside a server.");
    const role = interaction.options.getRole("target", true);
    return { id: role.id, name: role.name, data: role };
  }

  if (kind === "channel") {
    if (!interaction.guild) throw new Error("Channels can only be inspected inside a server.");
    const channel = interaction.options.getChannel("target", true);
    const channelData = channel as unknown as { id: string; name?: string };
    return { id: channelData.id, name: channelData.name ?? channelData.id, data: channel };
  }

  if (kind === "automod") {
    if (!interaction.guild) throw new Error("AutoMod rules can only be inspected inside a server.");
    const id = interaction.options.getString("rule", true);
    const rule = await interaction.guild.autoModerationRules.fetch(id).catch(() => null);
    if (!rule) throw new Error("Could not find that AutoMod rule.");
    return { id: rule.id, name: rule.name, data: rule };
  }

  if (kind === "logs") {
    if (!interaction.guild) throw new Error("Audit logs can only be inspected inside a server.");
    const botMember = interaction.guild.members.me;
    if (!botMember?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      throw new Error("The bot needs View Audit Log permission.");
    }
    const entryId = interaction.options.getString("logging");
    const logs = await interaction.guild.fetchAuditLogs({
      limit: entryId ? 100 : 100
    });
    if (entryId) {
      const entry = logs.entries.get(entryId);
      if (!entry) throw new Error("Could not find that audit log entry.");
      return { id: entry.id, name: `audit-log-${entry.id}`, data: entry };
    }
    const entries = [...logs.entries.values()].slice(0, 25);
    return {
      id: "recent",
      name: "recent-audit-logs",
      data: entries
    };
  }

  if (kind === "message") {
    if (!interaction.channel || !("messages" in interaction.channel)) {
      throw new Error("This message cannot be inspected.");
    }
    const id = interaction.options.getString("target", true);
    const message = await interaction.channel.messages.fetch(id).catch(() => null);
    if (!message) throw new Error("Could not find that message.");
    return { id: message.id, name: `message-${message.id}`, data: message };
  }

  return null;
}

async function sendInspectReply(
  interaction: ChatInputCommandInteraction,
  kind: InspectKind
): Promise<void> {
  const resolved = await fetchInspectData(interaction, kind);
  if (!resolved) throw new Error("Could not inspect that object.");

  const ephemeral = await resolveEphemeral(interaction);
  const json = JSON.stringify(
    toRawInspectData(resolved.data),
    (_key, value) => typeof value === "bigint" ? value.toString() : value,
    2
  );
  const jsonFile = new AttachmentBuilder(Buffer.from(json), {
    name: `${sanitizeInspectFilename(resolved.name)}.json`
  });
  const txtFile = new AttachmentBuilder(Buffer.from(json), {
    name: `${sanitizeInspectFilename(resolved.name)}.txt`
  });

  if (ephemeral) {
    await interaction.editReply({
      content: "-# Previewing assets or human-readable information? Use </info:1433219473036542114>",
      files: [jsonFile, txtFile]
    });
    return;
  }

  const mention = getMention(interaction);
  const payload = buildInspectPayload(interaction, kind, resolved);
  const components = payload.components;
  if (mention) components.push({ type: 10, content: mention });

  await interaction.editReply({
    components,
    files: [jsonFile],
    flags: MessageFlags.IsComponentsV2
  });
}

function universalInspectBuilder() {
  return new SlashCommandBuilder()
    .setName("inspect")
    .setDescription("Inspect a Discord user, role, or channel.")
    .setIntegrationTypes(
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall
    )
    .setContexts(
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("user")
        .setDescription("Inspect a user by ID.")
        .addStringOption((option) =>
          option.setName("id").setDescription("The Discord user ID").setRequired(true))
        .addBooleanOption((option) =>
          option.setName("ephemeral").setDescription("Send only to you").setRequired(false))
        .addMentionableOption((option) =>
          option.setName("mention").setDescription("Mention a user or role").setRequired(false))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("role")
        .setDescription("Inspect a role.")
        .addRoleOption((option) =>
          option.setName("target").setDescription("The role to inspect").setRequired(true))
        .addBooleanOption((option) =>
          option.setName("ephemeral").setDescription("Send only to you").setRequired(false))
        .addMentionableOption((option) =>
          option.setName("mention").setDescription("Mention a user or role").setRequired(false))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("channel")
        .setDescription("Inspect a channel.")
        .addChannelOption((option) =>
          option
            .setName("target")
            .setDescription("The channel to inspect")
            .setRequired(true)
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
              ChannelType.GuildVoice,
              ChannelType.GuildStageVoice,
              ChannelType.PublicThread,
              ChannelType.PrivateThread
            ))
        .addBooleanOption((option) =>
          option.setName("ephemeral").setDescription("Send only to you").setRequired(false))
        .addMentionableOption((option) =>
          option.setName("mention").setDescription("Mention a user or role").setRequired(false))
    );
}

const inspectUniversal: CommandModule = {
  category: "guild",
  requiredBotPermissions: [],
  guard: { guildOnly: false },
  data: universalInspectBuilder(),
  async execute(interaction) {
    const chatInteraction = interaction as ChatInputCommandInteraction;
    const subcommand = chatInteraction.options.getSubcommand() as InspectKind;
    const ephemeral = await resolveEphemeral(chatInteraction);
    await chatInteraction.deferReply({
      flags: ephemeral
        ? MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
        : MessageFlags.IsComponentsV2
    });
    try {
      await sendInspectReply(chatInteraction, subcommand);
    } catch (error) {
      await chatInteraction.editReply({
        content: `<:Cross:1425291759952593066> ${error instanceof Error ? error.message : "Inspection failed."}`
      });
    }
  },
  async autocomplete(interaction: AutocompleteInteraction) {
    await interaction.respond([]);
  },
  async component(interaction: MessageComponentInteraction) {
    await handleInspectButton(interaction);
  },
  async modalSubmit(interaction: ModalSubmitInteraction) {
    const [, , kind, id] = interaction.customId.split(":");
    if (kind !== "user" && kind !== "message") {
      await interaction.reply({
        content: "Unknown inspection type.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const selectedMentionables = interaction.fields.getSelectedMentionables(
      "inspect_mentions"
    );
    let ephemeral = interaction.fields.getCheckboxGroup("ephemeral").includes("true");
    if (selectedMentionables &&
        (selectedMentionables.users.size > 0 ||
         selectedMentionables.roles.size > 0 ||
         selectedMentionables.members.size > 0) &&
        !ephemeral) {
      ephemeral = false;
    }
    if (!ephemeral && interaction.inGuild()) {
      const member = interaction.member;
      if (!(member instanceof GuildMember) ||
          !member.permissions.has(PermissionFlagsBits.UseExternalApps)) {
        ephemeral = true;
      }
    }
    await interaction.deferReply({
      flags: ephemeral
        ? MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
        : MessageFlags.IsComponentsV2
    });

    let mentions: string | undefined;
    if (!ephemeral) {
      const selected = interaction.fields.getSelectedMentionables("inspect_mentions");
      if (selected) {
        const roleMentions = [...selected.roles.values()]
          .filter((role) => role !== null)
          .map((role) => `<@&${role.id}>`);
        const userMentions = [...selected.users.values()]
          .filter((user) => user !== null)
          .map((user) => `<@${user.id}>`);
        mentions = [...new Set([...roleMentions, ...userMentions])]
          .join(" ");
      }
    }

    if (kind === "user") {
      const cached = contextTargetCache.get(`${interaction.user.id}:user:${id}`);
      const resolved = cached && typeof cached === "object"
        ? { id, name: "username" in cached && typeof cached.username === "string"
            ? cached.username
            : id, data: cached }
        : await resolveInspectUser(interaction, id);
      if (!resolved) {
        await interaction.editReply({ content: "Could not find that user." });
        return;
      }
      await sendContextExport(
        interaction,
        kind,
        id,
        `user-${resolved.name}`,
        resolved.data,
        ephemeral,
        mentions
      );
      return;
    }

    const cachedMessage = contextTargetCache.get(`${interaction.user.id}:message:${id}`);
    let message = cachedMessage && typeof cachedMessage === "object"
      ? cachedMessage
      : null;
    if (!message) {
      const channel = interaction.channel;
      message = channel && "messages" in channel
        ? await channel.messages.fetch(id).catch(() => null)
        : null;
    }
    if (!message) {
      await interaction.editReply({ content: "Could not find that message." });
      return;
    }
    await sendContextExport(
      interaction,
      kind,
      id,
      `message-${"id" in message && typeof message.id === "string"
        ? message.id
        : id}`,
      message,
      ephemeral,
      mentions
    );
  }
};

const inspectAutomod: CommandModule = {
  category: "modular",
  requiredBotPermissions: [PermissionFlagsBits.ManageGuild],
  guard: {
    guildOnly: true,
    requireBotPermissions: [PermissionFlagsBits.ManageGuild],
    requireMemberPermissions: [PermissionFlagsBits.ManageGuild]
  },
  data: new SlashCommandBuilder()
    .setName("inspect-automod")
    .setDescription("Inspect a guild AutoMod rule.")
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option
        .setName("rule")
        .setDescription("The AutoMod rule")
        .setRequired(true)
        .setAutocomplete(true))
    .addBooleanOption((option) =>
      option.setName("ephemeral").setDescription("Send only to you").setRequired(false))
    .addMentionableOption((option) =>
      option.setName("mention").setDescription("Mention a user or role").setRequired(false)),
  async execute(interaction) {
    const chatInteraction = interaction as ChatInputCommandInteraction;
    const ephemeral = await resolveEphemeral(chatInteraction);
    await chatInteraction.deferReply({
      flags: ephemeral
        ? MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
        : MessageFlags.IsComponentsV2
    });
    try {
      await sendInspectReply(chatInteraction, "automod");
    } catch (error) {
      await chatInteraction.editReply({
        content: `<:Cross:1425291759952593066> ${error instanceof Error ? error.message : "Inspection failed."}`
      });
    }
  },
  async autocomplete(interaction: AutocompleteInteraction) {
    if (!interaction.inGuild()) return interaction.respond([]);
    const focused = interaction.options.getFocused();
    const rules = await interaction.guild!.autoModerationRules.fetch();
    const choices = [...rules.values()]
      .map((rule) => {
        const emoji = {
          [AutoModerationRuleTriggerType.Keyword]: "📝",
          [AutoModerationRuleTriggerType.Spam]: "🧱",
          [AutoModerationRuleTriggerType.KeywordPreset]: "🗯️",
          [AutoModerationRuleTriggerType.MentionSpam]: "❗",
          [AutoModerationRuleTriggerType.MemberProfile]: "🪪"
        }[rule.triggerType] ?? "📝";
        return {
          name: `${emoji} ${rule.name}`.slice(0, 100),
          value: rule.id
        };
      })
      .filter((choice) =>
        choice.name.toLowerCase().includes(focused.toLowerCase()) ||
        choice.value.includes(focused)
      )
      .slice(0, 25);
    await interaction.respond(choices);
  },
  async component(interaction: MessageComponentInteraction) {
    await handleInspectButton(interaction);
  }
};

const inspectLogs: CommandModule = {
  category: "modular",
  requiredBotPermissions: [PermissionFlagsBits.ViewAuditLog],
  guard: {
    guildOnly: true,
    requireBotPermissions: [PermissionFlagsBits.ViewAuditLog],
    requireMemberPermissions: [PermissionFlagsBits.ViewAuditLog]
  },
  data: new SlashCommandBuilder()
    .setName("inspect-logs")
    .setDescription("Inspect a guild audit log entry.")
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ViewAuditLog)
    .addStringOption((option) =>
      option
        .setName("logging")
        .setDescription("A recent audit log entry")
        .setRequired(false)
        .setAutocomplete(true))
    .addBooleanOption((option) =>
      option.setName("ephemeral").setDescription("Send only to you").setRequired(false))
    .addMentionableOption((option) =>
      option.setName("mention").setDescription("Mention a user or role").setRequired(false)),
  async execute(interaction) {
    const chatInteraction = interaction as ChatInputCommandInteraction;
    const ephemeral = await resolveEphemeral(chatInteraction);
    await chatInteraction.deferReply({
      flags: ephemeral
        ? MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
        : MessageFlags.IsComponentsV2
    });
    try {
      await sendInspectReply(chatInteraction, "logs");
    } catch (error) {
      await chatInteraction.editReply({
        content: `<:Cross:1425291759952593066> ${error instanceof Error ? error.message : "Inspection failed."}`
      });
    }
  },
  async autocomplete(interaction: AutocompleteInteraction) {
    if (!interaction.inGuild()) return interaction.respond([]);
    const botMember = interaction.guild!.members.me;
    if (!botMember?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      return interaction.respond([]);
    }
    const logs = await interaction.guild!.fetchAuditLogs({ limit: 25 }).catch(() => null);
    if (!logs) return interaction.respond([]);
    const focused = interaction.options.getFocused();
    const choices = [...logs.entries.values()]
      .slice(0, 25)
      .map((entry) => {
        const actionName = Object.entries(AuditLogEvent)
          .find(([, value]) => value === entry.action)?.[0] ?? "UNKNOWN";
        const executor = entry.executor?.username ?? "Unknown";
        const target = entry.targetId ?? "N/A";
        return {
          name: `[${actionName}] by ${executor} (target: ${target})`.slice(0, 100),
          value: entry.id
        };
      })
      .filter((choice) =>
        choice.name.toLowerCase().includes(focused.toLowerCase()) ||
        choice.value.includes(focused)
      );
    await interaction.respond(choices);
  },
  async component(interaction: MessageComponentInteraction) {
    await handleInspectButton(interaction);
  }
};

async function showContextModal(
  interaction: UserContextMenuCommandInteraction | MessageContextMenuCommandInteraction,
  kind: "user" | "message",
  id: string
) {
  await interaction.showModal(buildInspectModal(kind, id));
}

const contextUser: CommandModule = {
  category: "guild",
  data: new ContextMenuCommandBuilder()
    .setName("Inspect User")
    .setType(ApplicationCommandType.User)
    .setIntegrationTypes(
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall
    )
    .setContexts(
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel
    ),
  async execute(interaction) {
    const context = interaction as UserContextMenuCommandInteraction;
    const resolved = await resolveInspectUser(context, context.targetId);
    if (resolved) {
    contextTargetCache.set(
      `${interaction.user.id}:user:${context.targetId}`,
      resolved.data
    );
    setTimeout(() =>
      contextTargetCache.delete(`${interaction.user.id}:user:${context.targetId}`),
    10 * 60 * 1000
    ).unref();
    }
    await showContextModal(context, "user", context.targetId);
  },
};

const contextMessage: CommandModule = {
  category: "guild",
  data: new ContextMenuCommandBuilder()
    .setName("Inspect Message")
    .setType(ApplicationCommandType.Message)
    .setIntegrationTypes(
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall
    )
    .setContexts(
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel
    ),
  async execute(interaction) {
    const context = interaction as MessageContextMenuCommandInteraction;
    contextTargetCache.set(
      `${interaction.user.id}:message:${context.targetId}`,
      context.targetMessage
    );
    setTimeout(() =>
      contextTargetCache.delete(`${interaction.user.id}:message:${context.targetId}`),
    10 * 60 * 1000
    ).unref();
    await showContextModal(context, "message", context.targetId);
  },
};

async function sendContextExport(
  interaction: ModalSubmitInteraction,
  kind: "user" | "message",
  id: string,
  filename: string,
  data: unknown,
  ephemeral: boolean,
  mentions?: string
) {
  if (ephemeral) {
    const json = JSON.stringify(toRawInspectData(data), (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    2);
    const jsonFile = new AttachmentBuilder(Buffer.from(json), {
      name: `${sanitizeInspectFilename(filename)}.json`
    });
    const txtFile = new AttachmentBuilder(Buffer.from(json), {
      name: `${sanitizeInspectFilename(filename)}.txt`
    });
    await interaction.editReply({
      files: [jsonFile, txtFile]
    });
    return;
  }

  const payload = buildContextInspectPayload(kind, id, filename, data, mentions);
  await interaction.editReply({
    components: payload.components,
    files: [payload.jsonFile],
    flags: MessageFlags.IsComponentsV2
  });
}

async function handleInspectButton(interaction: MessageComponentInteraction) {
  if (!interaction.isButton()) return;
  const [, kind, id, format] = interaction.customId.split(":");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let data: unknown = null;
  let name = `${kind}-${id}`;
  if (kind === "user") {
    data = await interaction.client.users.fetch(id).catch(() => null);
  } else if (kind === "role" && interaction.inGuild()) {
    data = await interaction.guild!.roles.fetch(id).catch(() => null);
  } else if (kind === "channel" && interaction.inGuild()) {
    data = await interaction.guild!.channels.fetch(id).catch(() => null);
  } else if (kind === "automod" && interaction.inGuild()) {
    data = await interaction.guild!.autoModerationRules.fetch(id).catch(() => null);
  } else if (kind === "logs" && interaction.inGuild()) {
    const guild = interaction.guild!;
    if (id === "recent") {
      const logs = await guild.fetchAuditLogs({ limit: 25 }).catch(() => null);
      data = logs ? [...logs.entries.values()] : null;
    } else {
      const logs = await guild.fetchAuditLogs({ limit: 100 }).catch(() => null);
      data = logs?.entries.get(id) ?? null;
    }
  } else if (kind === "message") {
    const channel = interaction.channel;
    data = channel && "messages" in channel
      ? await channel.messages.fetch(id).catch(() => null)
      : null;
  }

  if (!data) {
    await interaction.editReply("Could not fetch the requested inspection.");
    return;
  }
  if ("name" in Object(data) && typeof (Object(data) as { name?: unknown }).name === "string") {
    name = (Object(data) as { name: string }).name;
  } else if (kind === "message") {
    name = `message-${id}`;
  }

  const json = JSON.stringify(toRawInspectData(data), (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  2);
  const file = new AttachmentBuilder(Buffer.from(json), {
    name: `${sanitizeInspectFilename(name)}.${format === "txt" ? "txt" : "json"}`
  });
  await interaction.editReply({ files: [file] });
}

export default [
  inspectUniversal,
  inspectAutomod,
  inspectLogs,
  contextUser,
  contextMessage
];
