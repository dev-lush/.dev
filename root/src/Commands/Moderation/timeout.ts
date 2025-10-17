import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, GuildMember, MessageFlags } from 'discord.js';
import { commandGuard } from '../../Utils/commandGuard.js';
import { parseDuration, formatDuration, getFutureDate, formatDiscordTimestamps } from '../../Utils/time.js';
import { buildAuditLogReasonPlain } from '../../Utils/auditLog.js';

const MAX_TIMEOUT_SECONDS = 2419200; // 28 days in seconds, the Discord API maximum.

export default {
    data: new SlashCommandBuilder()
        .setName('timeout')
        .setDescription('Times out a member for a specified duration.')
        .addUserOption(option =>
            option.setName('user')
            .setDescription('The user to time out.')
            .setRequired(true))
        .addStringOption(option =>
            option.setName('duration')
            .setDescription('Duration of the timeout (e.g., "10m", "1h 30m"). Max 28 days.')
            .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
            .setDescription('The reason for the timeout.'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    /**
     * Executes the /timeout command to apply a timeout to a guild member.
     * It includes checks for role hierarchy, target validity (not a bot, admin, or self),
     * and duration limits.
     * @param {ChatInputCommandInteraction} interaction The command interaction object.
     */
    async execute(interaction: ChatInputCommandInteraction) {
    // The commandGuard handles guild-only and permission checks.
    if (!await commandGuard(interaction, {
        guildOnly: true,
        requireMemberPermissions: [PermissionFlagsBits.ModerateMembers],
        requireBotPermissions: [PermissionFlagsBits.ModerateMembers]
    })) {
        return;
    }

        const targetUser = interaction.options.getUser('user', true);
        const durationStr = interaction.options.getString('duration', true);
        const reason = interaction.options.getString('reason') || 'No reason provided.';
        const member = interaction.guild!.members.cache.get(targetUser.id) as GuildMember;

        // Ensure the target member is actually in the server.
        if (!member) {
            await interaction.reply({ content: "That user is not in this server.", flags: MessageFlags.Ephemeral });
            return;
        }

        // Prevent users from timing out themselves or the bot.
        if (member.id === interaction.user.id) {
            await interaction.reply({ content: "Self-timeouts are not possible.", flags: MessageFlags.Ephemeral });
            return;
        }
        if (member.id === interaction.client.user.id) {
            await interaction.reply({ content: "=-=", flags: MessageFlags.Ephemeral });
            return;
        }

        // Prevent timing out a server administrator.
        if (member.permissions.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({ content: "<:Cross:1425291759952593066> Unable to time out an administrator.", flags: MessageFlags.Ephemeral });
            return;
        }
        
        // Check role hierarchy: a moderator cannot time out someone with an equal or higher role.
        const interactionMember = interaction.member as GuildMember;
        if (member.roles.highest.position >= interactionMember.roles.highest.position) {
            await interaction.reply({ content: "<:Cross:1425291759952593066> Cannot time out a member with an equal or higher role.", flags: MessageFlags.Ephemeral });
            return;
        }

        const durationInSeconds = parseDuration(durationStr);

        if (durationInSeconds <= 0) {
            await interaction.reply({ content: "Please provide a valid duration greater than `0`.", flags: MessageFlags.Ephemeral });
            return;
        }

        if (durationInSeconds > MAX_TIMEOUT_SECONDS) {
            await interaction.reply({
                content: `<:Cross:1425291759952593066> The maximum timeout duration is 28 days.`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const auditLogReason = buildAuditLogReasonPlain(interaction.user.id, reason);

        try {
            // The timeout duration must be provided in milliseconds.
            await member.timeout(durationInSeconds * 1000, auditLogReason);
            
            const formattedDuration = formatDuration(durationInSeconds);
            const endDate = getFutureDate(durationInSeconds);
            const timestamps = formatDiscordTimestamps(endDate);

            await interaction.reply({
                content: `<:Checkmark:1425291737550557225> **${targetUser.tag}** has been timed out for **${formattedDuration}**.`,
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
                console.error('Failed to time out member:', error);
                await interaction.reply({
                content: '<:Cross:1425291759952593066> Failed to time out this member. Member in question has higher role or the application lacks the `Moderate Members` permission.',
                flags: MessageFlags.Ephemeral
            });
        }
    }
}