import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import {
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type ModalSubmitInteraction,
  type MessageComponentInteraction,
  type ContextMenuCommandBuilder,
  type Client,
  type Guild,
  type Interaction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type RESTPostAPIContextMenuApplicationCommandsJSONBody,
  type SlashCommandBuilder,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
  type PermissionResolvable,
  type APIApplicationCommandOption
} from "discord.js";

export type CommandCategory = "user" | "guild" | "modular";

/** A slash or context-menu builder accepted by the command registry. */
export type CommandData =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder
  | ContextMenuCommandBuilder;

export interface CommandModule {
  category: CommandCategory;
  data: CommandData;
  requiredBotPermissions?: readonly PermissionResolvable[];
  guard?: CommandGuardOptions;
  conditionalOptions?: readonly ConditionalCommandOption[];
  execute(interaction: Interaction): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
  component?(interaction: MessageComponentInteraction): Promise<void>;
  modalSubmit?(interaction: ModalSubmitInteraction): Promise<void>;
}

type CommandJSON =
  | RESTPostAPIChatInputApplicationCommandsJSONBody
  | RESTPostAPIContextMenuApplicationCommandsJSONBody;

export interface CommandGuardOptions {
  requireBotPermissions?: readonly PermissionResolvable[];
  requireMemberPermissions?: readonly PermissionResolvable[];
  guildOnly?: boolean;
  dmOnly?: boolean;
  ownerOnly?: boolean;
}

export interface ConditionalCommandOption {
  optionName: string;
  condition: (context: { guild: Guild; client: Client }) => boolean | Promise<boolean>;
}

const loadedCommands: CommandModule[] = [];
const globalCommandIds = new Map<string, string>();
const guildCommandIds = new Map<string, Map<string, string>>();

/** Recursively loads command modules from this directory. */
export async function loadCommands(
  directory = fileURLToPath(new URL("../Commands", import.meta.url))
) {
  loadedCommands.length = 0;
  await loadFromDirectory(directory);
  return loadedCommands;

  async function loadFromDirectory(currentDirectory: string): Promise<void> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await loadFromDirectory(entryPath);
        continue;
      }

      if (!/\.(?:ts|js)$/.test(entry.name)) {
        continue;
      }

      const moduleUrl = pathToFileURL(entryPath).href;
      const imported = await import(moduleUrl) as { default?: CommandModule };
      if (Array.isArray(imported.default)) {
        loadedCommands.push(...imported.default);
      } else if (imported.default) {
        loadedCommands.push(imported.default);
      }
    }
  }
}

/** Returns commands that belong in Discord's global application-command list. */
export function getGlobalCommands(category?: "user" | "guild"): CommandJSON[] {
  return loadedCommands
    .filter((command) => category ? command.category === category : command.category === "user" || command.category === "guild")
    .map((command) => command.data.toJSON());
}

/** Returns modular guild commands for which the bot has every required permission. */
export async function getAvailableModularCommands(guild: Guild): Promise<CommandJSON[]> {
  const botPermissions = guild.members.me?.permissions;
  if (!botPermissions) return [];

  const available = loadedCommands
    .filter((command) => command.category === "modular")
    .filter((command) => !command.requiredBotPermissions?.length ||
      command.requiredBotPermissions.every((permission) => botPermissions.has(permission)));

  const commands: CommandJSON[] = [];
  for (const command of available) {
    commands.push(await getDynamicCommandForGuild(command, guild));
  }
  return commands;
}

/** Applies per-guild option conditions without mutating the source command. */
export async function getDynamicCommandForGuild(
  command: CommandModule,
  guild: Guild
): Promise<CommandJSON> {
  const commandData = command.data.toJSON();
  if (!command.conditionalOptions?.length || !("options" in commandData) || !commandData.options) {
    return commandData;
  }

  const cloned = JSON.parse(JSON.stringify(commandData)) as typeof commandData & { options: APIApplicationCommandOption[] };
  const filteredOptions: APIApplicationCommandOption[] = [];
  for (const option of cloned.options) {
    const conditional = command.conditionalOptions.find((item) => item.optionName === option.name);
    if (!conditional ||
        await Promise.resolve(conditional.condition({ guild, client: guild.client }))) {
      filteredOptions.push(option);
    }
  }
  cloned.options = filteredOptions;
  return cloned;
}

/** Synchronizes global user and fixed guild commands. */
export async function syncGlobalCommands(rest: REST, applicationId: string): Promise<void> {
  const registered = await rest.put(Routes.applicationCommands(applicationId), {
    body: getGlobalCommands()
  }) as { id: string; name: string }[];
  globalCommandIds.clear();
  for (const command of registered) globalCommandIds.set(command.name, command.id);
}

/** Synchronizes modular guild commands based on the bot's effective guild permissions. */
export async function syncGuildModularCommands(
  rest: REST,
  applicationId: string,
  guild: Guild
): Promise<void> {
  const registered = await rest.put(Routes.applicationGuildCommands(applicationId, guild.id), {
    body: await getAvailableModularCommands(guild)
  }) as { id: string; name: string }[];
  const ids = new Map<string, string>();
  for (const command of registered) ids.set(command.name, command.id);
  guildCommandIds.set(guild.id, ids);
}

/** Gets a registered command ID by name. */
export function getCommandId(commandName: string, guildId?: string): string | undefined {
  return guildId
    ? guildCommandIds.get(guildId)?.get(commandName) ?? globalCommandIds.get(commandName)
    : globalCommandIds.get(commandName);
}

/** Creates a clickable Discord slash-command mention. */
export function getCommandMention(
  commandName: string,
  subcommand?: string,
  guildId?: string
): string | undefined {
  const id = getCommandId(commandName, guildId);
  if (!id) return undefined;
  const name = subcommand ? `${commandName} ${subcommand}` : commandName;
  return `</${name}:${id}>`;
}

/** Enforces context, permission, and owner restrictions before command execution. */
export async function commandGuard(
  interaction: ChatInputCommandInteraction,
  options: CommandGuardOptions
): Promise<boolean> {
  if (options.dmOnly && interaction.inGuild()) {
    await interaction.reply({ content: "This command can only be used in Direct Messages.", flags: MessageFlags.Ephemeral });
    return false;
  }
  if (options.guildOnly && !interaction.inGuild()) {
    await interaction.reply({ content: "This command must be used inside a server.", flags: MessageFlags.Ephemeral });
    return false;
  }

  if (interaction.inGuild()) {
    const guild = interaction.guild!;
    const botMember = guild.members.me;
    if (botMember && options.requireBotPermissions?.length) {
      const permissions = interaction.channel
        ? botMember.permissionsIn(interaction.channel)
        : botMember.permissions;
      if (!permissions.has(PermissionFlagsBits.Administrator)) {
        const missing = permissions.missing(options.requireBotPermissions);
        if (missing.length) {
          await interaction.reply({
            content: `The application is missing the required permission(s): \`${missing.join(", ")}\`.`,
            flags: MessageFlags.Ephemeral
          });
          return false;
        }
      }
    }

    if (options.requireMemberPermissions?.length) {
      const member = interaction.member instanceof GuildMember
        ? interaction.member
        : await guild.members.fetch(interaction.user.id);
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
        const missing = member.permissions.missing(options.requireMemberPermissions);
        if (missing.length) {
          await interaction.reply({
            content: `You are missing the required permission(s): \`${missing.join(", ")}\`.`,
            flags: MessageFlags.Ephemeral
          });
          return false;
        }
      }
    }
  }

  if (options.ownerOnly) {
    const ownerId = process.env.OWNER;
    if (!ownerId || interaction.user.id !== ownerId) {
      await interaction.reply({ content: "You are not authorized to run this command.", flags: MessageFlags.Ephemeral });
      return false;
    }
  }
  return true;
}

/** Dispatches any slash or context-menu interaction to its loaded command module. */
export async function handleCommand(interaction: Interaction): Promise<void> {
  if (interaction.isModalSubmit()) {
    const separatorIndex = interaction.customId.indexOf(":");
    const commandName = separatorIndex >= 0
      ? interaction.customId.slice(0, separatorIndex)
      : "";
    const command = loadedCommands.find((candidate) =>
      candidate.data.name === commandName
    );
    if (command?.modalSubmit) await command.modalSubmit(interaction);
    return;
  }

  if (interaction.isMessageComponent()) {
    const separatorIndex = interaction.customId.indexOf(":");
    const commandName = separatorIndex >= 0
      ? interaction.customId.slice(0, separatorIndex)
      : "";
    const command = loadedCommands.find((candidate) =>
      candidate.data.name === commandName
    );
    if (command?.component) await command.component(interaction);
    return;
  }

  if (interaction.isAutocomplete()) {
    const command = loadedCommands.find((candidate) =>
      candidate.data.name === interaction.commandName
    );
    if (command?.autocomplete) await command.autocomplete(interaction);
    return;
  }

  if (!interaction.isChatInputCommand() &&
      !interaction.isUserContextMenuCommand() &&
      !interaction.isMessageContextMenuCommand()) {
    return;
  }

  const command = loadedCommands.find((candidate) =>
    candidate.data.name === interaction.commandName
  );
  if (!command) {
    if (interaction.isRepliable()) {
      await interaction.reply({ content: "This command is not available.", ephemeral: true });
    }
    return;
  }

  if (interaction.isChatInputCommand() && command.guard) {
    const allowed = await commandGuard(interaction, command.guard);
    if (!allowed) return;
  }

  await command.execute(interaction);
}
