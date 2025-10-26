import { ChatInputCommandInteraction, GuildMember, PermissionResolvable, PermissionsBitField, MessageFlags } from "discord.js";
import dotenv from "dotenv";
dotenv.config();

/**
 * @interface CommandGuardOptions
 * @description Options for the commandGuard function to specify various checks.
 * @property {PermissionResolvable[]} [requireBotPermissions] - An array of permissions the bot must have in the channel for the command to execute.
 * @property {PermissionResolvable[]} [requireMemberPermissions] - An array of permissions the interacting user must have for the command to execute.
 * @property {boolean} [guildOnly] - If true, the command can only be used within a server.
 * @property {boolean} [dmOnly] - If true, the command can only be used in Direct Messages.
 * @property {boolean} [global] - If true, the command can be used in both guilds and DMs (no context restriction).
 * @property {boolean} [ownerOnly] - If true, only the bot owner (defined in the .env file) can use the command.
 */
export interface CommandGuardOptions {
  requireBotPermissions?: PermissionResolvable[];
  requireMemberPermissions?: PermissionResolvable[];
  guildOnly?: boolean;
  dmOnly?: boolean;
  global?: boolean;
  ownerOnly?: boolean;
}

/**
 * A utility function to enforce various pre-execution checks for slash commands.
 * It handles context restrictions (guild/DM), permission checks for both the bot and the user,
 * and owner-only restrictions. If a check fails, it will automatically reply to the interaction
 * with an ephemeral error message explaining the failure.
 * @param {ChatInputCommandInteraction} interaction The ChatInputCommandInteraction to check.
 * @param {CommandGuardOptions} options The set of checks to perform.
 * @returns {Promise<boolean>} A promise that resolves to `true` if all checks pass, and `false` otherwise.
 */
export async function commandGuard(
  interaction: ChatInputCommandInteraction,
  options: CommandGuardOptions
): Promise<boolean> {
  // DM-only restriction check
  if (options.dmOnly && interaction.inGuild()) {
    await interaction.reply({
      content: "<:Caution:1432028786957746177> This command can only be used in Direct Messages.",
      flags: MessageFlags.Ephemeral
    });
    return false;
  }

  // Guild-only restriction check
  if (options.guildOnly && !interaction.inGuild()) {
    await interaction.reply({
      content: "<:Caution:1432028786957746177> This command must be used inside a server.",
      flags: MessageFlags.Ephemeral
    });
    return false;
  }

  // Bot permission check (only runs in guilds)
  if (interaction.inGuild() && options.requireBotPermissions) {
    // The `inGuild` check guarantees `interaction.guild` is not null.
    const botMember = interaction.guild!.members.me;
    if (botMember && !botMember.permissions.has(PermissionsBitField.Flags.Administrator)) {
      const missing = botMember.permissions.missing(options.requireBotPermissions);
      if (missing.length > 0) {
        await interaction.reply({
          content: `<:Caution:1432028786957746177> The application is unable to process the command. Make sure that the application has the following permission(s): \`${missing.join(", ")}\`.`,
          flags: MessageFlags.Ephemeral
        });
        return false;
      }
    }
  }

  // Member permission check (only runs in guilds)
  if (interaction.inGuild() && options.requireMemberPermissions) {
    const member = interaction.member as GuildMember;
    if (member && !member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      const missing = member.permissions.missing(options.requireMemberPermissions);
      if (missing.length > 0) {
        await interaction.reply({
          content: `<:Caution:1432028786957746177> You are missing the required permission(s) to use this command: \`${missing.join(", ")}\`.`,
          flags: MessageFlags.Ephemeral
        });
        return false;
      }
    }
  }

  // Owner-only check
  if (options.ownerOnly) {
    const ownerId = process.env.OWNER;
    if (!ownerId || interaction.user.id !== ownerId) {
      await interaction.reply({
        content: `<:Caution:1432028786957746177> You are not authorized to run this command.`,
        flags: MessageFlags.Ephemeral
      });
      return false;
    }
  }

  // All checks passed
  return true;
}