import { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags, } from 'discord.js';
import { commandGuard } from '../../Utils/commandGuard.js';
import { parseDuration, formatDuration } from '../../Utils/time.js';
import { headersFromInteraction } from '../../Utils/auditLog.js';
import { REST } from '@discordjs/rest';
const MAX_SLOWMODE_SECONDS = 21600; // 6 hours in seconds, the Discord API maximum.
export default {
    data: new SlashCommandBuilder()
        .setName('slowmode')
        .setDescription('Sets or removes the slowmode in a channel or thread.')
        .addStringOption(option => option.setName('duration')
        .setDescription('Duration of the slowmode (e.g., "10s", "5m", "1h"). Set to 0 to remove.')
        .setRequired(true))
        .addChannelOption(option => option.setName('channel')
        .setDescription('The channel or thread to apply slowmode to. Defaults to the current one.')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread))
        .addStringOption(option => option.setName('reason')
        .setDescription('The reason for this action.'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageThreads),
    /**
     * Executes the /slowmode command to set or remove a rate limit in a specified channel or thread.
     * It dynamically checks for the correct permissions based on the channel type (e.g., Manage Channels vs. Manage Threads)
     * and provides context-specific error messages.
     * @param {ChatInputCommandInteraction} interaction The command interaction object.
     */
    async execute(interaction) {
        if (!interaction.guild)
            return;
        const durationStr = interaction.options.getString('duration', true);
        const targetChannel = (interaction.options.getChannel('channel') || interaction.channel);
        // Dynamically determine the required permission name and bitfield for context-aware error messages and checks.
        let requiredPermissionName = 'Manage Channels';
        let requiredBotPerms = [PermissionFlagsBits.ManageChannels];
        let requiredMemberPerms = [PermissionFlagsBits.ManageChannels];
        // Threads require different permissions than standard channels.
        if (targetChannel.isThread()) {
            const parent = await targetChannel.parent?.fetch();
            // Posts within Forum and Media channels have their own permission context.
            if (parent?.type === ChannelType.GuildForum || parent?.type === ChannelType.GuildMedia) {
                requiredPermissionName = 'Manage Posts';
                // Note: Discord's API maps the "Manage Posts" permission to the `ManageThreads` bitfield.
                requiredBotPerms = [PermissionFlagsBits.ManageThreads];
                requiredMemberPerms = [PermissionFlagsBits.ManageThreads];
            }
            else {
                // This handles threads created in standard text or announcement channels.
                requiredPermissionName = 'Manage Threads';
                requiredBotPerms = [PermissionFlagsBits.ManageThreads];
                requiredMemberPerms = [PermissionFlagsBits.ManageThreads];
            }
        }
        if (!await commandGuard(interaction, {
            guildOnly: true,
            requireMemberPermissions: requiredMemberPerms,
            requireBotPermissions: requiredBotPerms
        })) {
            return;
        }
        if (!('setRateLimitPerUser' in targetChannel)) {
            await interaction.reply({
                content: `<:Cross:1425291759952593066> The selected channel type does not support slowmode.`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }
        const durationInSeconds = parseDuration(durationStr);
        if (durationInSeconds === (targetChannel.rateLimitPerUser ?? 0)) {
            if (durationInSeconds === 0) {
                await interaction.reply({
                    content: `Slowmode is already disabled in <#${targetChannel.id}>.`,
                    flags: MessageFlags.Ephemeral
                });
            }
            else {
                const formattedDuration = formatDuration(durationInSeconds);
                await interaction.reply({
                    content: `Slowmode in <#${targetChannel.id}> is already set to **${formattedDuration}**.`,
                    flags: MessageFlags.Ephemeral
                });
            }
            return;
        }
        if (durationInSeconds > MAX_SLOWMODE_SECONDS) {
            await interaction.reply({
                content: `<:Cross:1425291759952593066> The maximum slowmode duration is \`6 hours\` (\`${MAX_SLOWMODE_SECONDS}\` seconds).`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }
        const rest = new REST({ version: '10' }).setToken(interaction.client.token);
        const auditLogHeaders = headersFromInteraction(interaction);
        try {
            await rest.patch(`/channels/${targetChannel.id}`, {
                body: { rate_limit_per_user: durationInSeconds },
                headers: auditLogHeaders,
            });
            if (durationInSeconds > 0) {
                const formattedDuration = formatDuration(durationInSeconds);
                await interaction.reply({
                    content: `<:Checkmark:1425291737550557225> Slowmode has been set to **${formattedDuration}** in <#${targetChannel.id}>.`,
                    flags: MessageFlags.Ephemeral
                });
            }
            else {
                await interaction.reply({
                    content: `<:Checkmark:1425291737550557225> Slowmode has been removed from <#${targetChannel.id}>.`,
                    flags: MessageFlags.Ephemeral
                });
            }
        }
        catch (error) {
            console.error('Failed to set slowmode:', error);
            await interaction.reply({
                content: `<:Cross:1425291759952593066> Failed to set the slowmode. The application lacks the \`${requiredPermissionName}\` permission.`,
                flags: MessageFlags.Ephemeral
            });
        }
    }
};
