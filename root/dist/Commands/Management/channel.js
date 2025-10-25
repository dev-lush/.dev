/**
 * @file Slash command to manage guild channels (create, edit, permissions).
 */
import { SlashCommandBuilder, ModalBuilder, ChannelType, PermissionsBitField, MessageFlags, LabelBuilder, ChannelSelectMenuBuilder, MentionableSelectMenuBuilder, StringSelectMenuBuilder, ActionRowBuilder, ComponentType, ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import crypto from 'crypto';
import { commandGuard } from '../../Utils/commandGuard.js';
import { permissions as channelPermissions } from '../../Utils/permissions.js';
import { buildAuditLogReasonPlain } from '../../Utils/auditLog.js';
// A temporary in-memory store to pass the audit log reason from the command to the modal handler.
const reasonStore = new Map();
// --- START: Data for Dynamic Permission Descriptions ---
const RAW_DESCRIPTIONS = {
    // General
    'Create Invite': "Allows members to invite new people to this server via a direct invite link to this channel.",
    'View Channel': "Allows members to view this channel. Disabling this for @everyone makes the channel private.",
    'Manage Channel': "Allows members to edit channel settings (name, topic, etc.) and delete the channel.",
    'Manage Permissions': "Allows members to edit channel permissions for members and roles.",
    'Manage Webhooks': "Allows members to create, edit, and delete webhooks in this channel.",
    'Use Application Commands': "Allows members to use slash commands and other application commands in this channel.",
    'Use External Apps': "Allows apps that members have added to their account to post messages in this channel.",
    'Create Events': "Allows members to create events in this channel.",
    'Manage Events': "Allows members to edit, cancel, or delete events in this channel.",
    // Text-based
    'Send Messages': {
        default: "Allows members to send messages in this channel.",
        announcement: "Allows members to publish their own messages to all servers following this channel.",
        forum: "Allows members to create posts."
    },
    'Send Messages in Threads': {
        default: "Allows members to send messages in threads under this channel.",
        forum: "Allows members to send messages in posts under this channel."
    },
    'Create Public Threads': "Allows members to create threads that everyone in this channel can view.",
    'Create Private Threads': "Allows members to create invite-only threads in this channel.",
    'Embed Links': "Allows links that members share to show embedded content in this channel.",
    'Attach Files': "Allows members to upload files or media in this channel.",
    'Add Reactions': "Allows members to add new emoji reactions to a message. Members can still use existing reactions.",
    'Use External Emojis': "Allows members to use emojis from other servers if they're a Discord Nitro member.",
    'Use External Stickers': "Allows members to use stickers from other servers if they're a Discord Nitro member.",
    'Mention @everyone, @here, and All Roles': {
        default: "Allows members to @everyone, @here, and all roles, which will notify all members.",
        stage: "Allows Stage Moderators to notify @everyone when a Stage starts."
    },
    'Manage Messages': "Allows members to delete messages by other members in this channel.",
    'Pin Messages': "Allows members to pin or unpin any message.",
    'Manage Threads': {
        default: "Allows members to rename, delete, archive, and set slow mode for threads.",
        forum: "Allows members to rename, delete, close, and set slow mode for posts."
    },
    'Read Message History': "Allows members to see messages sent in this channel before they joined.",
    'Send Text-to-Speech Messages': "Allows members to send /tts messages, which are read aloud to users focused on the channel.",
    'Send Voice Messages': "Allows members to send voice messages in this channel. Requires the 'Attach Files' permission.",
    'Create Polls': "Allows members to create polls in this channel.",
    // Voice-based
    'Connect': "Allows members to join this voice channel and hear others.",
    'Speak': "Allows members to talk in this voice channel. Otherwise, they must be unmuted by a moderator.",
    'Video': {
        default: "Allows members to share their video, screen share, or stream a game in this channel.",
        stage: "Allows speakers to share their video, screen share, or stream a game in this Stage channel."
    },
    'Use Activities': "Allows members to start Activities in this voice channel.",
    'Use Soundboard': "Allows members to send sounds from the server soundboard in this voice channel.",
    'Use External Sounds': "Allows members to use sounds from other servers if they're a Discord Nitro member.",
    'Use Voice Activity': "Allows members to speak without using Push-to-Talk. Disabling this forces Push-to-Talk.",
    'Priority Speaker': "Allows members to lower other speakers' volume when they talk using a specific keybind.",
    'Mute Members': {
        default: "Allows members to mute other members in this voice channel for everyone.",
        stage: "Allows members to add or remove Speakers. Required for Stage Moderators."
    },
    'Deafen Members': "Allows members to deafen others, so they won't be able to speak or hear.",
    'Move Members': {
        default: "Allows members to move other members out of this voice channel and into other channels.",
        stage: "Allows members to disconnect others from this channel. Required for Stage Moderators."
    },
    'Request to Speak': "Allows members to request to speak in this Stage channel.",
    'Set Voice Channel Status': "Allows members to create and edit the voice channel status."
};
const textPermNames = new Set([
    'Create Invite', 'View Channel', 'Manage Channel', 'Manage Permissions', 'Manage Webhooks',
    'Send Messages', 'Send Messages in Threads', 'Create Public Threads', 'Create Private Threads',
    'Embed Links', 'Attach Files', 'Add Reactions', 'Use External Emojis', 'Use External Stickers',
    'Mention @everyone, @here, and All Roles', 'Manage Messages', 'Manage Threads',
    'Read Message History', 'Send Text-to-Speech Messages', 'Use Application Commands', 'Use External Apps',
    'Pin Messages', 'Send Voice Messages', 'Create Polls'
]);
const forumPermNames = new Set([
    'Create Invite', 'View Channel', 'Manage Channel', 'Manage Permissions', 'Manage Webhooks',
    'Send Messages', 'Send Messages in Threads', 'Embed Links', 'Attach Files', 'Add Reactions',
    'Use External Emojis', 'Use External Stickers', 'Mention @everyone, @here, and All Roles',
    'Manage Messages', 'Manage Threads', 'Read Message History', 'Send Text-to-Speech Messages',
    'Use Application Commands', 'Use External Apps', 'Pin Messages', 'Send Voice Messages', 'Create Polls'
]);
// --- Voice & Stage Channel Permission Sets ---
const generalManagementPermNames = new Set([
    'Create Invite', 'View Channel', 'Manage Channel', 'Manage Permissions', 'Manage Webhooks', 'Create Events', 'Manage Events'
]);
const voiceChatPermNames = new Set([
    'Send Messages', 'Embed Links', 'Attach Files', 'Add Reactions', 'Use External Emojis',
    'Use External Stickers', 'Mention @everyone, @here, and All Roles', 'Manage Messages',
    'Read Message History', 'Send Text-to-Speech Messages', 'Use Application Commands',
    'Use External Apps', 'Send Voice Messages', 'Create Polls'
]);
const commonVoicePermNames = new Set([
    'Connect', 'Video', 'Mute Members', 'Move Members'
]);
const exclusiveVoicePermNames = new Set([
    'Speak', 'Deafen Members', 'Use Activities', 'Use Soundboard', 'Use External Sounds',
    'Use Voice Activity', 'Priority Speaker', 'Set Voice Channel Status'
]);
const exclusiveStagePermNames = new Set([
    'Request to Speak'
]);
/**
 * Retrieves the relevant permission options for a given channel type.
 * @param type The type of the channel.
 * @returns An array of permission objects from the `channelPermissions` map.
 */
function getRelevantPermissions(type) {
    let permNames;
    switch (type) {
        case ChannelType.GuildText:
        case ChannelType.GuildAnnouncement:
            permNames = textPermNames;
            break;
        case ChannelType.GuildForum:
        case ChannelType.GuildMedia:
            permNames = forumPermNames;
            break;
        // Voice and Stage are handled separately by the modal prompt
        default:
            permNames = new Set(channelPermissions.map(p => p.name));
            break;
    }
    return channelPermissions.filter(p => permNames.has(p.name));
}
/**
 * Builds a list of permission options with dynamic labels and descriptions for the modal.
 * @param targetChannel The channel for which to build permission options.
 * @param relevantPermissions The pre-filtered list of permissions to include.
 * @returns An array of `APISelectMenuOption` objects.
 */
function buildPermissionOptionsForChannel(targetChannel, relevantPermissions) {
    const isStage = targetChannel.type === ChannelType.GuildStageVoice;
    const isAnnouncement = targetChannel.type === ChannelType.GuildAnnouncement;
    const isForumOrMedia = targetChannel.type === ChannelType.GuildForum || targetChannel.type === ChannelType.GuildMedia;
    return relevantPermissions.map(p => {
        const descData = RAW_DESCRIPTIONS[p.name];
        let description;
        if (typeof descData === 'string') {
            description = descData;
        }
        else if (typeof descData === 'object') {
            if (isStage && descData.stage) {
                description = descData.stage;
            }
            else if (isAnnouncement && descData.announcement) {
                description = descData.announcement;
            }
            else if (isForumOrMedia && descData.forum) {
                description = descData.forum;
            }
            else {
                description = descData.default;
            }
        }
        let finalLabel = p.name;
        if (isForumOrMedia) {
            finalLabel = finalLabel.replace(/Threads/g, 'Posts');
            finalLabel = finalLabel.replace(/Send Messages/g, 'Create Posts');
        }
        if (isStage) {
            finalLabel = finalLabel.replace(/@here and All Roles/g, 'when a Stage starts');
        }
        return {
            label: finalLabel,
            value: p.value,
            description: description?.substring(0, 100),
        };
    });
}
export default {
    data: new SlashCommandBuilder()
        .setName('channel')
        .setDescription('Manage guild channels.')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
        .addSubcommand(subcommand => subcommand
        .setName('create')
        .setDescription('Create a new channel.')
        .addStringOption(option => option.setName('name')
        .setDescription('The name for the new channel.')
        .setRequired(true))
        .addIntegerOption(option => option.setName('type')
        .setDescription('The type of channel to create.')
        .setRequired(false)
        .addChoices({ name: 'Text', value: ChannelType.GuildText }, { name: 'Voice', value: ChannelType.GuildVoice }, { name: 'Category', value: ChannelType.GuildCategory }, { name: 'Announcement', value: ChannelType.GuildAnnouncement }, { name: 'Stage', value: ChannelType.GuildStageVoice }, { name: 'Forum', value: ChannelType.GuildForum }, { name: 'Media', value: ChannelType.GuildMedia }))
        .addChannelOption(option => option.setName('category')
        .setDescription('The parent category for the new channel.')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(false))
        .addStringOption(option => option.setName('reason')
        .setDescription('The reason for this action, for the audit log.')
        .setRequired(false)))
        .addSubcommand(subcommand => subcommand
        .setName('edit')
        .setDescription('Edit an existing channel.')
        .addChannelOption(option => option.setName('channel')
        .setDescription('The channel to edit. Defaults to the current channel.')
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia, ChannelType.GuildVoice, ChannelType.GuildStageVoice))
        .addStringOption(option => option.setName('name')
        .setDescription('The new name for the channel.')
        .setRequired(false))
        .addStringOption(option => option.setName('description')
        .setDescription("The channel's new topic/description (text, announcement, forum, media only).")
        .setRequired(false))
        .addChannelOption(option => option.setName('category')
        .setDescription('The new parent category for the channel.')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(false))
        .addStringOption(option => option.setName('reason')
        .setDescription('The reason for this action, for the audit log.')
        .setRequired(false)))
        .addSubcommand(subcommand => subcommand
        .setName('perms')
        .setDescription('Configure permission overwrites for a channel.')
        .addChannelOption(option => option.setName('channel')
        .setDescription('The channel to configure. Defaults to the current channel.')
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia, ChannelType.GuildVoice, ChannelType.GuildStageVoice))
        .addStringOption(option => option.setName('reason')
        .setDescription('The reason for this action, for the audit log.')
        .setRequired(false))),
    /**
     * Executes the slash command.
     * @param interaction The chat input command interaction.
     */
    async execute(interaction) {
        const passed = await commandGuard(interaction, {
            requireMemberPermissions: [PermissionsBitField.Flags.ManageChannels],
            requireBotPermissions: [PermissionsBitField.Flags.ManageChannels],
            guildOnly: true
        });
        if (!passed)
            return;
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'create') {
            await handleCreate(interaction);
        }
        else if (subcommand === 'edit') {
            await handleEdit(interaction);
        }
        else if (subcommand === 'perms') {
            await handlePermissionModal(interaction);
        }
    }
};
/**
 * Handles the 'create' subcommand.
 * @param interaction The interaction.
 */
async function handleCreate(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const name = interaction.options.getString('name', true);
    const type = interaction.options.getInteger('type') ?? ChannelType.GuildText;
    const parent = interaction.options.getChannel('category');
    let reason = interaction.options.getString('reason') || undefined;
    const auditLogReason = buildAuditLogReasonPlain(interaction.user.id, reason);
    const newChannel = await interaction.guild.channels.create({
        name,
        type: type,
        parent: parent ? parent.id : undefined,
        reason: auditLogReason
    });
    await interaction.editReply({
        content: `<:Checkmark:1425291737550557225> Successfully created ${newChannel}!`
    });
}
/**
 * Handles the 'edit' subcommand.
 * @param interaction The interaction.
 */
async function handleEdit(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = (interaction.options.getChannel('channel') ?? interaction.channel);
    const newName = interaction.options.getString('name');
    const newDescription = interaction.options.getString('description');
    const newParent = interaction.options.getChannel('category');
    let reason = interaction.options.getString('reason') || undefined;
    const auditLogReason = buildAuditLogReasonPlain(interaction.user.id, reason);
    const editOptions = { reason: auditLogReason };
    if (newName)
        editOptions.name = newName;
    if (newParent)
        editOptions.parent = newParent.id;
    if (newDescription !== null) {
        const supportedTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia];
        if (supportedTypes.includes(channel.type)) {
            editOptions.topic = newDescription;
        }
        else {
            await interaction.editReply({ content: '<:Cross:1425291759952593066> The `description` option can only be used on text, announcement, forum, or media channels.' });
            return;
        }
    }
    if (Object.keys(editOptions).length <= 1) { // <=1 because 'reason' is always there
        await interaction.editReply({ content: '<:Cross:1425291759952593066> You must provide at least one option to edit.' });
        return;
    }
    await channel.edit(editOptions);
    await interaction.editReply({
        content: `<:Checkmark:1425291737550557225> Successfully updated ${channel}.`
    });
}
/**
 * Builds and displays the permission configuration modal.
 * @param interaction The interaction that triggered the modal.
 * @param targetChannel The channel to configure.
 * @param permissionOptions The permission options to display in the modal.
 * @param uuid A unique ID to link the modal submission to the initial command's reason.
 */
async function showPermsModal(interaction, targetChannel, permissionOptions, uuid) {
    const customId = `channel_perms:${targetChannel.id}${uuid ? `:${uuid}` : ''}`;
    const modalTitle = `Configure #${targetChannel.name}`.slice(0, 45);
    const modal = new ModalBuilder()
        .setCustomId(customId)
        .setTitle(modalTitle);
    /**
     * An array of `ChannelType` enums that are permitted for a specific action or command.
     * This is used to validate that a target channel is of an acceptable type.
     */
    let allowedChannelTypes = [];
    switch (targetChannel.type) {
        case ChannelType.GuildText:
        case ChannelType.GuildAnnouncement:
            allowedChannelTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
            break;
        case ChannelType.GuildForum:
        case ChannelType.GuildMedia:
            allowedChannelTypes = [ChannelType.GuildForum, ChannelType.GuildMedia];
            break;
        case ChannelType.GuildVoice:
        case ChannelType.GuildStageVoice:
            allowedChannelTypes = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];
            break;
    }
    const channelSelectLabel = new LabelBuilder()
        .setLabel('Additional Channels')
        .setDescription('Apply the same permission changes to other channels of the same type.')
        .setChannelSelectMenuComponent(new ChannelSelectMenuBuilder()
        .setCustomId('channel_perms_channel_select')
        .setPlaceholder('Select other channels (optional)')
        .setMinValues(0)
        .setMaxValues(25)
        .addChannelTypes(...allowedChannelTypes)
        .setRequired(false));
    const targetsMenu = new LabelBuilder()
        .setLabel('Configure Permissions')
        .setDescription('Select server members or roles to apply permission changes to. Leave empty to target @everyone.')
        .setMentionableSelectMenuComponent(new MentionableSelectMenuBuilder()
        .setCustomId('channel_perms_targets')
        .setPlaceholder('Select users and/or roles to apply permissions to')
        .setMinValues(0)
        .setMaxValues(25)
        .setRequired(false));
    const allowMenu = new LabelBuilder()
        .setLabel('Allow Permissions')
        .setDescription('Select permissions to ALLOW for the selected targets.')
        .setStringSelectMenuComponent(new StringSelectMenuBuilder()
        .setCustomId('channel_perms_allow')
        .setPlaceholder('Select permissions to ALLOW')
        .setMinValues(0)
        .setMaxValues(Math.min(25, permissionOptions.length))
        .addOptions(permissionOptions)
        .setRequired(false));
    const inheritMenu = new LabelBuilder()
        .setLabel('Inherit Permissions')
        .setDescription('Select permissions to INHERIT (reset) for the selected targets.')
        .setStringSelectMenuComponent(new StringSelectMenuBuilder()
        .setCustomId('channel_perms_inherit')
        .setPlaceholder('Select permissions to INHERIT (reset)')
        .setMinValues(0)
        .setMaxValues(Math.min(25, permissionOptions.length))
        .addOptions(permissionOptions)
        .setRequired(false));
    const denyMenu = new LabelBuilder()
        .setLabel('Deny Permissions')
        .setDescription('Select permissions to DENY for the selected targets.')
        .setStringSelectMenuComponent(new StringSelectMenuBuilder()
        .setCustomId('channel_perms_deny')
        .setPlaceholder('Select permissions to DENY')
        .setMinValues(0)
        .setMaxValues(Math.min(25, permissionOptions.length))
        .addOptions(permissionOptions)
        .setRequired(false));
    modal.setLabelComponents(channelSelectLabel.toJSON(), targetsMenu.toJSON(), allowMenu.toJSON(), inheritMenu.toJSON(), denyMenu.toJSON());
    if (interaction.isModalSubmit())
        return; // Type guard
    // console.log('[channel] modal JSON:', JSON.stringify(modal.toJSON(), null, 2));
    await interaction.showModal(modal);
}
/**
 * Handles the 'perms' subcommand by building and displaying a modal.
 * @param interaction The interaction.
 */
async function handlePermissionModal(interaction) {
    const targetChannel = (interaction.options.getChannel('channel') ?? interaction.channel);
    const reason = interaction.options.getString('reason');
    let uuid;
    if (reason) {
        uuid = crypto.randomUUID();
        reasonStore.set(uuid, reason);
        // Clean up the reason from the store after 15 minutes to prevent memory leaks.
        setTimeout(() => reasonStore.delete(uuid), 900000);
    }
    if (!targetChannel || !('permissionsFor' in targetChannel)) {
        await interaction.reply({
            content: '<:Cross:1425291759952593066> This command can only be used in a server channel.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }
    // For voice/stage channels, prompt for a category first to avoid >25 options in the modal.
    if (targetChannel.type === ChannelType.GuildVoice || targetChannel.type === ChannelType.GuildStageVoice) {
        const isStage = targetChannel.type === ChannelType.GuildStageVoice;
        const voiceLabel = isStage ? 'Stage Permissions' : 'Voice Permissions';
        const voiceDescription = isStage ? 'Permissions for speaking and moderating the stage.' : 'Permissions for connecting, speaking, and activity.';
        const chatLabel = isStage ? 'Stage Chat Permissions' : 'Voice Chat Permissions';
        const chatDescription = 'Permissions for the text chat in this channel.';
        const voiceEmoji = isStage ? { name: 'Stage', id: '1411263302457229333' } : { name: 'Voice', id: '1411263330919907458' };
        const row = new ActionRowBuilder()
            .addComponents(new StringSelectMenuBuilder()
            .setCustomId(`channel_perms_category:${targetChannel.id}${uuid ? `:${uuid}` : ''}`)
            .setPlaceholder('Select a permission category to configure')
            .addOptions([
            { label: voiceLabel, description: voiceDescription, value: 'voice', emoji: voiceEmoji },
            { label: chatLabel, description: chatDescription, value: 'chat', emoji: { name: 'Chat', id: '1426382065028304986' } }
        ]));
        const message = await interaction.reply({
            components: [row],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
        });
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.StringSelect,
            time: 60000,
            filter: i => i.user.id === interaction.user.id,
        });
        collector.on('collect', async (i) => {
            const selection = i.values[0];
            const parts = i.customId.split(':');
            const collectedUuid = parts.length > 2 ? parts[2] : undefined;
            let relevantPerms = [];
            let permNames;
            if (selection === 'voice') {
                if (isStage) {
                    permNames = new Set([...generalManagementPermNames, ...commonVoicePermNames, ...exclusiveStagePermNames]);
                }
                else {
                    permNames = new Set([...generalManagementPermNames, ...commonVoicePermNames, ...exclusiveVoicePermNames]);
                }
                relevantPerms = channelPermissions.filter(p => permNames.has(p.name));
            }
            else if (selection === 'chat') {
                relevantPerms = channelPermissions.filter(p => voiceChatPermNames.has(p.name));
            }
            const permissionOptions = buildPermissionOptionsForChannel(targetChannel, relevantPerms);
            await showPermsModal(i, targetChannel, permissionOptions, collectedUuid);
            // Clean up the select menu after showing the modal
            await i.update({
                components: [{ type: 10, content: '</channel perms:1388437776080572416>' }]
            }).catch(() => { });
        });
        collector.on('end', async (collected) => {
            if (collected.size === 0) {
                await interaction.editReply({ content: 'You did not make a selection in time.', components: [] });
            }
        });
    }
    else {
        // For other channel types, show the modal directly.
        const relevantPermissions = getRelevantPermissions(targetChannel.type);
        if (!relevantPermissions) {
            await interaction.reply({ content: '<:Cross:1425291759952593066> Cannot determine relevant permissions for this channel type.', flags: MessageFlags.Ephemeral });
            return;
        }
        const permissionOptions = buildPermissionOptionsForChannel(targetChannel, relevantPermissions);
        await showPermsModal(interaction, targetChannel, permissionOptions, uuid);
    }
}
function isSnowflakeArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0)
        return false;
    // simple heuristic: every item is a numeric string (Discord snowflake)
    return arr.every(it => typeof it === 'string' && /^\d+$/.test(it));
}
function deepFindArrays(obj, path = '') {
    const found = [];
    if (Array.isArray(obj)) {
        if (isSnowflakeArray(obj))
            found.push({ path, value: obj });
        for (let i = 0; i < obj.length; i++) {
            found.push(...deepFindArrays(obj[i], `${path}[${i}]`));
        }
    }
    else if (obj && typeof obj === 'object') {
        for (const key of Object.keys(obj)) {
            found.push(...deepFindArrays(obj[key], path ? `${path}.${key}` : key));
        }
    }
    return found;
}
// Defensive modal select extractor with diagnostics
/**
 * Extracts the values from a specific component within a modal submission.
 * This function iterates through the components of a modal interaction to find
 * a component matching the provided custom ID and returns its value or values.
 * It is designed to work with both single-value components (like text inputs)
 * and multi-value components (like select menus).
 *
 * @param interaction The `ModalSubmitInteraction` object received when a user submits a modal.
 * @param customId The custom ID of the component from which to extract the values.
 * @returns An array of strings containing the value(s) from the specified component.
 * It returns an empty array if the component is not found, has no values, or if an error occurs.
 */
function getModalSelectValues(interaction, customId) {
    try {
        const candidates = [];
        for (const row of interaction.components) {
            if (Array.isArray(row.components)) {
                candidates.push(...row.components);
                continue;
            }
            if (row.component) {
                candidates.push(row.component);
                continue;
            }
            if (row.customId || row.values) {
                candidates.push(row);
            }
        }
        const extract = (comp) => {
            if (!comp || typeof comp !== 'object')
                return null;
            if (Array.isArray(comp.values) && comp.values.length > 0)
                return comp.values;
            if (typeof comp.value === 'string' && comp.value.length > 0)
                return [comp.value];
            return null;
        };
        // 1) exact customId
        for (const comp of candidates) {
            if (comp && typeof comp.customId === 'string' && comp.customId === customId) {
                const vals = extract(comp);
                return vals ?? [];
            }
        }
        // 2) startsWith (in case of builder prefixing)
        for (const comp of candidates) {
            if (comp && typeof comp.customId === 'string' && comp.customId.startsWith(customId)) {
                const vals = extract(comp);
                return vals ?? [];
            }
        }
        // 3) deep fallback — only for the mentionable 'targets' selector.
        // Permission selects (allow/deny/inherit) should NOT fall back to other arrays:
        // if they're empty, they must be treated as empty.
        if (customId.includes('targets')) {
            const foundArrays = deepFindArrays(interaction.components);
            if (foundArrays.length > 0) {
                // Prefer snowflake-like arrays (long numeric strings)
                const snow = foundArrays.find(f => isSnowflakeArray(f.value)) ?? foundArrays[0];
                return snow.value ?? [];
            }
        }
    }
    catch (err) {
        console.error('[channel] getModalSelectValues error', err);
    }
    return [];
}
/**
 * Handles the submission of the channel permission configuration modal.
 * It parses the user's selections for targets (users/roles) and the permissions
 * to allow, deny, or inherit. It then calculates the actual changes and applies
 * them to the channel, finally replying with a formatted summary of the changes.
 * @param interaction The modal submission interaction.
 */
export async function handleChannelPermsModal(interaction) {
    if (!interaction.guild || !interaction.channel)
        return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Extract the target channel ID and potential reason UUID from the modal's custom ID.
    const parts = (interaction.customId ?? '').split(':');
    const primaryChannelId = parts[1];
    const uuid = parts.length > 2 ? parts[2] : undefined;
    let reason;
    if (uuid) {
        reason = reasonStore.get(uuid);
        reasonStore.delete(uuid);
    }
    const auditLogReason = buildAuditLogReasonPlain(interaction.user.id, reason);
    if (!primaryChannelId) {
        await interaction.editReply({ content: '<:Cross:1425291759952593066> Could not identify the target channel from the interaction.' });
        return;
    }
    const primaryChannel = await interaction.guild.channels.fetch(primaryChannelId).catch(() => null);
    if (!primaryChannel) {
        await interaction.editReply({ content: '<:Cross:1425291759952593066> The target channel could not be found.' });
        return;
    }
    // Get raw modal select values
    const selectedChannelIds = getModalSelectValues(interaction, 'channel_perms_channel_select');
    const rawTargets = getModalSelectValues(interaction, 'channel_perms_targets');
    const allowValues = getModalSelectValues(interaction, 'channel_perms_allow');
    const inheritValues = getModalSelectValues(interaction, 'channel_perms_inherit');
    const denyValues = getModalSelectValues(interaction, 'channel_perms_deny');
    // Build allowed channel-type groups used by the modal (same logic as showPermsModal)
    let allowedChannelTypes = [];
    switch (primaryChannel.type) {
        case ChannelType.GuildText:
        case ChannelType.GuildAnnouncement:
            allowedChannelTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
            break;
        case ChannelType.GuildForum:
        case ChannelType.GuildMedia:
            allowedChannelTypes = [ChannelType.GuildForum, ChannelType.GuildMedia];
            break;
        case ChannelType.GuildVoice:
            allowedChannelTypes = [ChannelType.GuildVoice];
            break;
        case ChannelType.GuildStageVoice:
            allowedChannelTypes = [ChannelType.GuildStageVoice];
            break;
        default:
            allowedChannelTypes = [
                ChannelType.GuildText, ChannelType.GuildVoice,
                ChannelType.GuildCategory, ChannelType.GuildAnnouncement,
                ChannelType.GuildStageVoice, ChannelType.GuildForum,
                ChannelType.GuildMedia
            ];
            break;
    }
    // Validate selected additional channels server-side and notify user if any were rejected.
    const filteredChannelIds = [];
    const rejectedChannelMentions = [];
    for (const cid of selectedChannelIds ?? []) {
        const ch = await interaction.guild.channels.fetch(cid).catch(() => null);
        if (!ch) {
            rejectedChannelMentions.push(`#${cid} (not found)`);
            continue;
        }
        if (!allowedChannelTypes.includes(ch.type)) {
            rejectedChannelMentions.push(`<#${cid}>`);
            continue;
        }
        filteredChannelIds.push(cid);
    }
    if (rejectedChannelMentions.length > 0) {
        const note = `<:Warning:1395719352560648274> Some selected channels were ignored because they are not the same channel type as <#${primaryChannelId}>:\n${rejectedChannelMentions.join(', ')}`;
        await interaction.followUp({ content: note, flags: MessageFlags.Ephemeral });
    }
    // If targets empty -> default to @everyone role id
    const finalTargets = (rawTargets && rawTargets.length > 0) ? rawTargets.slice() : [interaction.guild.roles.everyone.id];
    const permKeyToFriendly = {};
    const permKeyToValue = {};
    for (const p of channelPermissions) {
        try {
            const pf = new PermissionsBitField(BigInt(p.value)).toArray();
            const key = pf[0];
            if (key) {
                permKeyToFriendly[key] = p.name;
                permKeyToValue[key] = BigInt(p.value);
            }
        }
        catch { /* skip invalid */ }
    }
    // Convert the selected option bit-values (strings) into permission KEYS (like "ViewChannel")
    const valuesToKeySet = (values) => {
        const s = new Set();
        for (const v of values ?? []) {
            try {
                const names = new PermissionsBitField(BigInt(v)).toArray();
                for (const n of names)
                    s.add(n);
            }
            catch (err) { /* ignore */ }
        }
        return s;
    };
    const allowSet = valuesToKeySet(allowValues);
    const denySet = valuesToKeySet(denyValues);
    const inheritSet = valuesToKeySet(inheritValues);
    const unionKeys = new Set([...allowSet, ...denySet, ...inheritSet]);
    const overwriteOptions = {};
    for (const key of unionKeys) {
        if (inheritSet.has(key))
            overwriteOptions[key] = null;
        else if (denySet.has(key))
            overwriteOptions[key] = false;
        else if (allowSet.has(key))
            overwriteOptions[key] = true;
    }
    // Channels to apply: primary plus additional filtered channels (dedupe)
    const channelsToApply = (filteredChannelIds && filteredChannelIds.length > 0)
        ? Array.from(new Set([primaryChannelId, ...filteredChannelIds]))
        : [primaryChannelId];
    const permOverrideMap = new Map();
    // Helper counts for targets (used to decide if footnote should show differences)
    const totalRoleSelected = finalTargets.filter(t => interaction.guild.roles.cache.has(t)).length;
    const totalUserSelected = finalTargets.filter(t => !interaction.guild.roles.cache.has(t)).length;
    let anyChangeMade = false;
    for (const chId of channelsToApply) {
        const ch = await interaction.guild.channels.fetch(chId).catch(() => null);
        if (!ch)
            continue;
        for (const targetId of finalTargets) {
            const currentOverwrites = ch.permissionOverwrites.cache.get(targetId);
            const currentAllow = currentOverwrites?.allow?.bitfield ?? 0n;
            const currentDeny = currentOverwrites?.deny?.bitfield ?? 0n;
            for (const key of unionKeys) {
                const bit = permKeyToValue[key] ?? 0n;
                if (bit === 0n)
                    continue; // skip unknown mapping
                const currentValue = (currentAllow & bit) !== 0n ? 'allow' : (currentDeny & bit) !== 0n ? 'deny' : 'inherit';
                const desiredRaw = overwriteOptions[key];
                const desiredValue = desiredRaw === null ? 'inherit' : desiredRaw === false ? 'deny' : 'allow';
                if (currentValue !== desiredValue) {
                    anyChangeMade = true;
                    let grouping = permOverrideMap.get(key);
                    if (!grouping) {
                        grouping = { channels: new Set(), users: new Set(), roles: new Set() };
                        permOverrideMap.set(key, grouping);
                    }
                    grouping.channels.add(chId);
                    if (interaction.guild.roles.cache.has(targetId))
                        grouping.roles.add(targetId);
                    else
                        grouping.users.add(targetId);
                }
            }
            try {
                await ch.permissionOverwrites.edit(targetId, overwriteOptions, { reason: auditLogReason });
            }
            catch { }
        }
    }
    if (!anyChangeMade) {
        const comps = [];
        comps.push({ type: 10, content: `## <#${primaryChannel.id}>` });
        if (channelsToApply.length > 1) {
            const extraChannels = channelsToApply.length - 1;
            comps.push({ type: 10, content: `-# +${extraChannels} ${extraChannels === 1 ? 'channel' : 'channels'}` });
        }
        comps.push({ type: 14, spacing: 1 });
        comps.push({ type: 10, content: 'No permission changes were applied as the selected overwrites were already in place.' });
        const container = { type: 17, components: comps };
        await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
        return;
    }
    const buildLines = (keys, icon) => {
        return keys.map(k => {
            const friendly = permKeyToFriendly[k] ?? k;
            const grouping = permOverrideMap.get(k);
            let foot;
            if (grouping) {
                const appliedToAllChannels = grouping.channels.size === channelsToApply.length;
                const appliedToAllRoles = totalRoleSelected === 0 || grouping.roles.size === totalRoleSelected;
                const appliedToAllUsers = totalUserSelected === 0 || grouping.users.size === totalUserSelected;
                const wasUniversal = appliedToAllChannels && appliedToAllRoles && appliedToAllUsers;
                // The footnote should only be displayed if the permission overwrite was not applied universally
                // to all targeted channels and members/roles. This provides clarity on partial updates.
                if (!wasUniversal) {
                    const parts = [];
                    if (grouping.channels.size > 0) {
                        parts.push(Array.from(grouping.channels).map(cid => `<#${cid}>`).join(', '));
                    }
                    if (grouping.users.size > 0 && !appliedToAllUsers) {
                        parts.push(Array.from(grouping.users).map(uid => `<@${uid}>`).join(', '));
                    }
                    if (grouping.roles.size > 0 && !appliedToAllRoles) {
                        parts.push(Array.from(grouping.roles).map(rid => `<@&${rid}>`).join(', '));
                    }
                    if (parts.length > 0)
                        foot = `-# Overrides: ${parts.join('; ')}`;
                }
            }
            return `${icon} ${friendly}${foot ? `\n${foot}` : ''}`;
        });
    };
    const allowedKeys = Array.from(unionKeys).filter(k => overwriteOptions[k] === true && permOverrideMap.has(k));
    const deniedKeys = Array.from(unionKeys).filter(k => overwriteOptions[k] === false && permOverrideMap.has(k));
    const inheritedKeys = Array.from(unionKeys).filter(k => overwriteOptions[k] === null && permOverrideMap.has(k));
    const allowedLines = buildLines(allowedKeys, '<:Check_Coloured:1431463796563771462>');
    const inheritedLines = buildLines(inheritedKeys, '<:Slash_Coloured:1431463800816537731>');
    const deniedLines = buildLines(deniedKeys, '<:X_Coloured:1431463798811918442>');
    const allowedContent = allowedLines.length > 0 ? allowedLines.join('\n') : '';
    const inheritedContent = inheritedLines.length > 0 ? inheritedLines.join('\n') : '';
    const deniedContent = deniedLines.length > 0 ? deniedLines.join('\n') : '';
    const combinedLength = allowedContent.length + inheritedContent.length + deniedContent.length;
    const needSelect = combinedLength > 3800;
    const comps = [
        { type: 10, content: `## <#${primaryChannel.id}>` },
        ...(channelsToApply.length > 1 ? [{ type: 10, content: `-# +${channelsToApply.length - 1} more channels` }] : []),
        { type: 14, spacing: 1 }
    ];
    if (!needSelect) {
        if (allowedContent)
            comps.push({ type: 10, content: allowedContent });
        if (inheritedContent)
            comps.push({ type: 14, divider: false }, { type: 10, content: inheritedContent });
        if (deniedContent)
            comps.push({ type: 14, divider: false }, { type: 10, content: deniedContent });
        comps.push({ type: 14, spacing: 2 }, { type: 10, content: '-# *Permissions shown above only display registered changes*' });
        const container = { type: 17, components: comps };
        await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
    }
    else {
        let initialView = 'allowed';
        if (!allowedContent)
            initialView = inheritedContent ? 'inherited' : 'denied';
        const buildSelectAndContent = (currentView) => {
            const select = new StringSelectMenuBuilder()
                .setCustomId(`channel_perms_view:${primaryChannel.id}:${Date.now()}`)
                .setPlaceholder('Choose which permission view to show')
                .addOptions(...(allowedContent ? [{ label: 'Allowed', value: 'allowed', default: currentView === 'allowed', emoji: { id: '1406896084168609824' } }] : []), ...(inheritedContent ? [{ label: 'Inherited', value: 'inherited', default: currentView === 'inherited', emoji: { id: '1406896106117533758' } }] : []), ...(deniedContent ? [{ label: 'Denied', value: 'denied', default: currentView === 'denied', emoji: { id: '1406896126187016284' } }] : []));
            const contentMap = { allowed: allowedContent, inherited: inheritedContent, denied: deniedContent };
            const currentContent = contentMap[currentView];
            const currentComps = [...comps,
                { type: 10, content: currentContent },
                { type: 14, spacing: 1 },
                { type: 1, components: [select.toJSON()] },
                { type: 14, spacing: 2 },
                { type: 10, content: '-# *Permissions shown above only display registered changes*' }
            ];
            return { type: 17, components: currentComps };
        };
        const container = buildSelectAndContent(initialView);
        const replyMsg = await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
        const collector = replyMsg.createMessageComponentCollector({
            componentType: ComponentType.StringSelect,
            time: 300_000,
            filter: i => i.user.id === interaction.user.id
        });
        collector.on('collect', async (i) => {
            const selectedView = i.values[0];
            const updatedContainer = buildSelectAndContent(selectedView);
            await i.update({ components: [updatedContainer], flags: MessageFlags.IsComponentsV2 });
        });
        collector.on('end', async () => {
            try {
                const finalMsg = await interaction.fetchReply();
                const disabledComps = finalMsg.components.map(row => {
                    if (row.type === ComponentType.ActionRow) {
                        const newRow = new ActionRowBuilder();
                        row.components.forEach(comp => {
                            if (comp.type === ComponentType.StringSelect) {
                                newRow.addComponents(StringSelectMenuBuilder.from(comp).setDisabled(true));
                            }
                        });
                        return newRow;
                    }
                    return row;
                });
                await interaction.editReply({ components: disabledComps.map(c => 'toJSON' in c ? c.toJSON() : c) });
            }
            catch { }
        });
    }
}
