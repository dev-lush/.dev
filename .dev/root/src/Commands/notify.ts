import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type RoleSelectMenuInteraction
} from "discord.js";
import { RoleMention } from "../Models/RoleMention.js";
import { Subscription, SubscriptionType } from "../Models/Subscription.js";
import { type CommandModule } from "../Modules/commandRegistry.js";
import {
  buildPreviewPanel,
  buildStatusPanel,
  type MentionKind
} from "../Internals/Messages/notifPanels.js";

const STATUS_TYPES = new Set([
  SubscriptionType.DiscordStatus,
  SubscriptionType.CloudflareStatus,
  SubscriptionType.GitHubStatus
]);

async function handleRoleSelection(interaction: RoleSelectMenuInteraction) {
  const parts = interaction.customId.split(":");
  const subscriptionId = parts[2];
  const kind = parts[3] as MentionKind;
  const category = parts.slice(4).join(":");

  const subscription = await Subscription.findById(subscriptionId);
  if (!subscription || subscription.guildId !== interaction.guildId) {
    await interaction.reply({
      content: "This subscription is no longer available.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const role = interaction.roles.first();
  if (!role) {
    await RoleMention.findOneAndDelete({
      guildId: interaction.guildId!,
      subscriptionId,
      type: kind,
      category
    });
    await interaction.reply({
      content: `Removed the role mention for **${category === "universal" ? "Universal" : category}**.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await RoleMention.findOneAndUpdate(
    {
      guildId: interaction.guildId!,
      subscriptionId,
      type: kind,
      category
    },
    { $set: { roleId: role.id } },
    { upsert: true }
  );

  const botMember = interaction.guild?.members.me;
  const warning = botMember &&
    !role.mentionable &&
    !botMember.permissions.has(PermissionFlagsBits.MentionEveryone)
    ? " The bot may not be able to mention this role due to role mention permissions."
    : "";

  await interaction.reply({
    content: `${role} will be mentioned for **${category === "universal" ? "all status updates" : category}**.${warning}`,
    flags: MessageFlags.Ephemeral
  });
}

/**
 * Guild command module for managing universal, event, and impact role pings.
 *
 * Selecting no roles in a role selector removes the corresponding Mongoose
 * role mapping. Existing mappings are restored as default selector roles.
 */
const command: CommandModule = {
  category: "guild",
  guard: {
    guildOnly: true,
    requireMemberPermissions: [
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.MentionEveryone
    ]
  },
  data: new SlashCommandBuilder()
    .setName("notify")
    .setDescription("Configure role mentions for subscriptions")
    .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
    .setContexts([InteractionContextType.Guild])
    .addStringOption((option) =>
      option
        .setName("subscription")
        .setDescription("Subscription to configure")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild |
      PermissionFlagsBits.ManageRoles |
      PermissionFlagsBits.MentionEveryone
    ),

  async autocomplete(interaction: AutocompleteInteraction) {
    if (!interaction.guildId) {
      await interaction.respond([]);
      return;
    }

    const subscriptions = await Subscription.find({
      guildId: interaction.guildId
    }).sort({ createdAt: -1 }).limit(25);

    const names: Record<SubscriptionType, string> = {
      [SubscriptionType.DiscordStatus]: "Discord Status",
      [SubscriptionType.CloudflareStatus]: "Cloudflare Status",
      [SubscriptionType.GitHubStatus]: "GitHub Status",
      [SubscriptionType.DiscordPreviews]: "Discord Previews"
    };

    const choices = [];
    for (const subscription of subscriptions) {
      const channel = interaction.guild?.channels.cache.get(subscription.channelId);
      choices.push({
        name: `#${channel?.isTextBased() && "name" in channel ? channel.name : "unknown"}: ${names[subscription.type as SubscriptionType]}`,
        value: subscription._id.toString()
      });
    }

    await interaction.respond(choices);
  },

  async execute(interaction) {
    const chatInteraction = interaction as ChatInputCommandInteraction;
    const subscriptionId = chatInteraction.options.getString("subscription", true);
    const subscription = await Subscription.findById(subscriptionId);

    if (!subscription || subscription.guildId !== chatInteraction.guildId) {
      await chatInteraction.reply({
        content: "Subscription not found.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const components = STATUS_TYPES.has(subscription.type)
      ? await buildStatusPanel(subscription.type, subscriptionId, subscription.guildId)
      : await buildPreviewPanel(subscriptionId, subscription.guildId);

    await chatInteraction.reply({
      components,
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
    });
  },

  async component(interaction: MessageComponentInteraction) {
    if (interaction.isRoleSelectMenu()) {
      await handleRoleSelection(interaction);
    }
  }
};

export default command;
