import { PermissionsBitField, MessageFlags } from "discord.js";
import dotenv from "dotenv";
dotenv.config();
/**
 * A utility function to enforce various pre-execution checks for slash commands.
 * It handles context restrictions (guild/DM), permission checks for both the bot and the user,
 * and owner-only restrictions. If a check fails, it will automatically reply to the interaction
 * with an ephemeral error message explaining the failure.
 * @param {ChatInputCommandInteraction} interaction The ChatInputCommandInteraction to check.
 * @param {CommandGuardOptions} options The set of checks to perform.
 * @returns {Promise<boolean>} A promise that resolves to `true` if all checks pass, and `false` otherwise.
 */
export async function commandGuard(interaction, options) {
    // DM-only restriction check
    if (options.dmOnly && interaction.inGuild()) {
        await interaction.reply({
            content: "<:Warning:1395719352560648274> This command can only be used in Direct Messages.",
            flags: MessageFlags.Ephemeral
        });
        return false;
    }
    // Guild-only restriction check
    if (options.guildOnly && !interaction.inGuild()) {
        await interaction.reply({
            content: "<:Warning:1395719352560648274> This command must be used inside a server.",
            flags: MessageFlags.Ephemeral
        });
        return false;
    }
    // Bot permission check (only runs in guilds)
    if (interaction.inGuild() && options.requireBotPermissions) {
        // The `inGuild` check guarantees `interaction.guild` is not null.
        const botMember = interaction.guild.members.me;
        if (botMember && !botMember.permissions.has(PermissionsBitField.Flags.Administrator)) {
            const missing = botMember.permissions.missing(options.requireBotPermissions);
            if (missing.length > 0) {
                await interaction.reply({
                    content: `<:Warning:1395719352560648274> The application is unable to process the command. Make sure that the application has the following permission(s): \`${missing.join(", ")}\`.`,
                    flags: MessageFlags.Ephemeral
                });
                return false;
            }
        }
    }
    // Member permission check (only runs in guilds)
    if (interaction.inGuild() && options.requireMemberPermissions) {
        const member = interaction.member;
        if (member && !member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            const missing = member.permissions.missing(options.requireMemberPermissions);
            if (missing.length > 0) {
                await interaction.reply({
                    content: `<:Warning:1395719352560648274> You are missing the required permission(s) to use this command: \`${missing.join(", ")}\`.`,
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
                content: `<:Warning:1395719352560648274> You are not authorized to run this command.`,
                flags: MessageFlags.Ephemeral
            });
            return false;
        }
    }
    // All checks passed
    return true;
}
