import { SlashCommandBuilder, MessageFlags, ChannelType, GuildFeature, PermissionsBitField, ApplicationIntegrationType, InteractionContextType, AttachmentBuilder, SnowflakeUtil } from 'discord.js';
import { commandGuard } from '../../Utils/commandGuard.js';
import { formatDiscordTimestamps } from '../../Utils/time.js';
import { InfoCardGenerator } from '../../Utils/infoCardGenerator.js';
import { ServerDataHelper } from '../../Data Helper/server.js';
export default {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('Get information about a server, user, role, or channel.')
        .setIntegrationTypes([ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall])
        .setContexts([InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel])
        .addSubcommand(subcommand => subcommand
        .setName('server')
        .setDescription('Get information about a server.')
        .addStringOption(option => option.setName('query')
        .setDescription('A server ID or invite link.')
        .setRequired(true))
        .addStringOption(option => option.setName('mention')
        .setDescription('User or role to mention.')
        .setRequired(false))
        .addBooleanOption(option => option.setName('ephemeral')
        .setDescription('Whether to make the message ephemeral.')
        .setRequired(false))),
    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'server') {
            const passed = await commandGuard(interaction, { global: true });
            if (!passed)
                return;
            const ephemeral = interaction.options.getBoolean('ephemeral') ?? false;
            const query = interaction.options.getString('query', true);
            const mentionsInput = interaction.options.getString('mention');
            await interaction.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : undefined });
            let guild = null;
            let memberCount = null;
            let presenceCount = null;
            const inviteRegex = /(?:discord\.(?:gg|io|me|li)|discordapp\.com\/invite)\/([a-zA-Z0-9\-]+)/;
            const match = query.match(inviteRegex);
            try {
                if (match && match[1]) {
                    const invite = await interaction.client.fetchInvite(match[1]);
                    guild = invite.guild;
                    memberCount = invite.memberCount;
                    presenceCount = invite.presenceCount;
                    if (interaction.client.guilds.cache.has(guild.id)) {
                        guild = await guild.fetch();
                    }
                }
                else if (/^\d{17,19}$/.test(query)) {
                    guild = await interaction.client.guilds.fetch(query);
                }
                else {
                    return interaction.editReply({ content: '<:Cross:1425291759952593066> Invalid query. Please provide a server ID or a valid Discord invite link.' });
                }
            }
            catch (error) {
                console.error('Failed to fetch server:', error);
                return interaction.editReply({ content: '<:Cross:1425291759952593066> Could not find that server. It might be an invalid ID/invite, or I may not be a member.' });
            }
            if (!guild) {
                return interaction.editReply({ content: '<:Cross:1425291759952593066> Could not resolve the server.' });
            }
            const isBotInGuild = !!guild.channels;
            const creationDate = guild.createdAt ?? new Date(SnowflakeUtil.timestampFrom(guild.id));
            // --- Emoji Logic ---
            const features = guild.features;
            const premiumTier = guild.premiumTier ?? 0;
            const isBoosted = premiumTier >= 2;
            let emoji = '';
            if (features.includes('INTERNAL_EMPLOYEE_ONLY'))
                emoji = '<:Employee:1413178265278877766>';
            else if (features.includes(GuildFeature.Verified))
                emoji = '<:Verified:1411264425431666708>';
            else if (features.includes(GuildFeature.Partnered))
                emoji = '<:Partnered:1411264012473339924>';
            else if (features.includes(GuildFeature.Discoverable) && isBoosted)
                emoji = '<:Discoverable_Boosted:1411264124129906737>';
            else if (features.includes(GuildFeature.Discoverable))
                emoji = '<:Discoverable:1411264165149937796>';
            else if (features.includes(GuildFeature.Community) && isBoosted)
                emoji = '<:Community_Boosted:1411263941010657340>';
            else if (features.includes(GuildFeature.Community))
                emoji = '<:Community:1411263844332081262>';
            const container = [];
            const files = [];
            // --- Header & Image ---
            container.push({ type: 10, content: `## ${emoji} ${guild.name}`.trim() });
            const serverDataHandler = new ServerDataHelper();
            const infoCardGenerator = new InfoCardGenerator();
            await infoCardGenerator.initialize();
            const serverData = await serverDataHandler.guildToServerData({ guild, memberCount, presenceCount });
            const imageBuffer = await infoCardGenerator.generateCard(serverData);
            if (imageBuffer) {
                const attachmentName = 'server-info.webp';
                files.push(new AttachmentBuilder(imageBuffer, { name: attachmentName }));
                container.push({
                    type: 12, // Media Grid
                    items: [{
                            media: {
                                url: `attachment://${attachmentName}`
                            }
                        }]
                });
            }
            container.push({ type: 14, spacing: 1 });
            // --- General Info ---
            const owner = isBotInGuild ? await guild.fetchOwner().catch(() => null) : null;
            const timestamps = formatDiscordTimestamps(creationDate);
            const totalMembers = memberCount ?? (isBotInGuild ? guild.memberCount : null);
            let generalInfo = `## General Information\n**Server ID:** \`${guild.id}\``;
            if (owner)
                generalInfo += `\n**Server Owner:** ${owner} - **${owner.user.username}**`;
            generalInfo += `\n**Creation Date:** ${timestamps.longDate} [${timestamps.relative}]`;
            if (guild.vanityURLCode)
                generalInfo += `\n**Vanity URL:** https://discord.gg/${guild.vanityURLCode}`;
            if (totalMembers)
                generalInfo += `\n**Total Members:** ${totalMembers.toLocaleString('en-US')}`;
            container.push({ type: 10, content: generalInfo });
            // --- Channels & Roles (only if bot is in the guild) ---
            if (isBotInGuild) {
                // Channels
                const channels = guild.channels.cache;
                const channelCounts = {
                    text: channels.filter(c => c.type === ChannelType.GuildText).size,
                    announcement: channels.filter(c => c.type === ChannelType.GuildAnnouncement).size,
                    voice: channels.filter(c => c.type === ChannelType.GuildVoice).size,
                    stage: channels.filter(c => c.type === ChannelType.GuildStageVoice).size,
                    forum: channels.filter(c => c.type === ChannelType.GuildForum).size,
                    media: channels.filter(c => c.type === ChannelType.GuildMedia).size,
                };
                const totalChannels = Object.values(channelCounts).reduce((a, b) => a + b, 0);
                if (totalChannels > 0) {
                    container.push({ type: 14, spacing: 1 });
                    let channelInfo = `## Channels`;
                    if (channelCounts.text > 0)
                        channelInfo += `\n<:Text:1411263251710214205> **Text:** ${channelCounts.text}`;
                    if (channelCounts.announcement > 0)
                        channelInfo += `\n<:News:1411263278923120791> **Announcements:** ${channelCounts.announcement}`;
                    if (channelCounts.voice > 0)
                        channelInfo += `\n<:Voice:1411263330919907458> **Voice:** ${channelCounts.voice}`;
                    if (channelCounts.stage > 0)
                        channelInfo += `\n<:Stage:1411263302457229333> **Stages:** ${channelCounts.stage}`;
                    if (channelCounts.forum > 0)
                        channelInfo += `\n<:Forum:1411263376163606630> **Forums:** ${channelCounts.forum}`;
                    if (channelCounts.media > 0)
                        channelInfo += `\n<:Media:1411263812048523334> **Media:** ${channelCounts.media}`;
                    channelInfo += `\n<:Customize:1411267144284373092> **Total:** ${totalChannels}`;
                    container.push({ type: 10, content: channelInfo.trim() });
                }
                // Roles
                const roles = guild.roles.cache;
                const roleCounts = {
                    admin: roles.filter(r => r.permissions.has(PermissionsBitField.Flags.Administrator)).size,
                    mentionable: roles.filter(r => r.mentionable).size,
                    integration: roles.filter(r => r.managed).size,
                    linked: roles.filter(r => r.tags && r.tags.botId === undefined && r.tags.integrationId === undefined && r.tags.premiumSubscriberRole == null).size,
                };
                const totalRoles = roles.size - 1; // Exclude @everyone
                if (totalRoles > 0) {
                    container.push({ type: 14, spacing: 1 });
                    let roleInfo = `## Roles`;
                    if (roleCounts.admin > 0)
                        roleInfo += `\n**<:Safety:1409872681251115142> Administrators:** ${roleCounts.admin}`;
                    if (roleCounts.mentionable > 0)
                        roleInfo += `\n<:Mentionable_Role:1411263105216024627> **Mentionable:** ${roleCounts.mentionable}`;
                    if (roleCounts.integration > 0)
                        roleInfo += `\n<:Integration_Role:1411263012316123146> **Integrations:** ${roleCounts.integration}`;
                    if (roleCounts.linked > 0)
                        roleInfo += `\n**<:Linked_Role:1411262826533879870> Linked Roles:** ${roleCounts.linked}`;
                    roleInfo += `\n<:Role:1411263058998988810> **Total:** ${totalRoles}`;
                    container.push({ type: 10, content: roleInfo.trim() });
                }
            }
            // --- Server Assets ---
            const getAssetInfo = (url, baseName) => {
                if (!url)
                    return null;
                return {
                    label: baseName.charAt(0).toUpperCase() + baseName.slice(1),
                    type: baseName, // 'icon', 'banner', 'splash'
                };
            };
            const assets = [
                getAssetInfo(guild.iconURL({ size: 4096, forceStatic: false }), 'icon'),
                getAssetInfo(guild.bannerURL({ size: 4096, forceStatic: false }), 'banner'),
                getAssetInfo(guild.splashURL({ size: 4096, forceStatic: false }), 'splash')
            ].filter((asset) => asset !== null);
            if (assets.length > 0) {
                container.push({ type: 14, spacing: 1 });
                container.push({ type: 10, content: '## Server Assets' });
                const assetButtons = assets.map(asset => ({
                    type: 2, // Button
                    style: 2, // Secondary style (grey)
                    label: `View ${asset.label}`,
                    custom_id: `view_asset:${asset.type}:${guild.id}`
                }));
                container.push({
                    type: 1, // Action Row
                    components: assetButtons
                });
            }
            // --- Mentions ---
            let mentionsContent;
            if (mentionsInput && !ephemeral) {
                const mentionRegex = /(<@!?\d+>|<@&\d+>|@everyone|@here)/g;
                const validMentions = mentionsInput.match(mentionRegex);
                if (validMentions) {
                    mentionsContent = validMentions.join(' ');
                }
            }
            const components = [{ type: 17, components: container }];
            if (mentionsContent) {
                components.push({ type: 10, content: mentionsContent });
            }
            await interaction.editReply({
                components: components,
                files: files,
                flags: MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0)
            });
        }
    }
};
