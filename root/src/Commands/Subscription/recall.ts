import {
    ChatInputCommandInteraction,
    SlashCommandBuilder,
    AutocompleteInteraction,
    MessageFlags,
    CacheType,
    TextChannel,
    NewsChannel,
    InteractionContextType,
    ApplicationIntegrationType
} from 'discord.js';
import { Subscription, SubscriptionType, IncidentData } from '../../Models/Subscription.js';
import { format } from 'date-fns';
import { commandGuard } from '../../Utils/commandGuard.js';
import { fetchIncidents, fetchIncidentById, buildStatusContainer, Incident, buildStatusPayload, getStatusMentionPings } from '../../Utils/discordStatus.js';
import {
    buildCommitCommentPayload,
    GitHubComment,
    isTokenLoaded,
    parseSections
} from '../../Utils/commitMessage.js';
import { RoleMentionsHandler } from '../../Models/RoleMentionsHandler.js';
import { fetchWithToken } from '../../Models/GitHubToken.js';
import { crosspostMessage } from '../../Utils/autoPublisher.js';

export default {
    data: new SlashCommandBuilder()
        .setName('recall')
        .setDescription('Recall a specific incident or commit comment.')
        .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
        .setContexts([InteractionContextType.Guild])
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Recall a specific Discord Status incident or maintenance.')
                .addStringOption(option =>
                    option.setName('incident')
                        .setDescription('The incident or maintenance to recall.')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addStringOption(option =>
                    option.setName('subscription')
                        .setDescription('The subscription to use.')
                        .setRequired(true)
                        .setAutocomplete(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('previews')
                .setDescription('Recall a specific commit comment.')
                .addStringOption(option =>
                    option.setName('comment')
                        .setDescription('The commit comment to recall.')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addStringOption(option =>
                    option.setName('subscription')
                        .setDescription('The subscription to use.')
                        .setRequired(true)
                        .setAutocomplete(true))),
    /**
     * Handles autocomplete requests for the command.
     * @param interaction The autocomplete interaction.
     */
    async autocomplete(interaction: AutocompleteInteraction) {
        const focused = interaction.options.getFocused(true);
        const subCommand = interaction.options.getSubcommand();

        try {
            // Autocomplete for 'subscription' option
            if (focused.name === 'subscription') {
                const type = subCommand === 'status' ? SubscriptionType.STATUS : SubscriptionType.PREVIEWS;
                const subs = await Subscription.find({ guildId: interaction.guildId, type });

                const choices = await Promise.all(subs.map(async sub => {
                    const channel = await interaction.client.channels.fetch(sub.channelId).catch(() => null);
                    const user = await interaction.client.users.fetch(sub.userId).catch(() => null);
                    const channelName = (channel && 'name' in channel && channel.name) ? `#${channel.name}` : 'Unknown Channel';
                    const category = sub.type === SubscriptionType.STATUS ? 'Discord Status' : 'Discord Previews';
                    return {
                        name: `${channelName}: ${category} | ${user?.username ?? 'Unknown'} | ${format(sub.createdAt, 'd MMMM yyyy')}`,
                        value: sub._id.toString()
                    };
                 }));
                 await interaction.respond(choices.slice(0, 25));

            // Autocomplete for 'status' subcommand's 'incident' option
            } else if (subCommand === 'status' && focused.name === 'incident') {
                const incidents = await fetchIncidents(2);
                const choices = incidents.slice(0, 25).map(incident => {
                    const impactText = incident.impact !== 'none' ? ` - ${incident.impact}` : '';
                    const unresolved = incident.status !== 'resolved' ? '[⚠️] ' : '';
                    return {
                        name: `${unresolved}[${incident.id.slice(0, 6)}]${impactText} | ${format(new Date(incident.created_at), 'd MMMM yyyy')}`,
                        value: incident.id
                    };
                });
                await interaction.respond(choices);

            // Autocomplete for 'previews' subcommand's 'comment' option
            } else if (subCommand === 'previews' && focused.name === 'comment') {
                if (!await isTokenLoaded()) {
                    return await interaction.respond([{ name: 'GitHub token is missing.', value: 'missing' }]);
                }
                
                let comments: GitHubComment[];
                try {
                    // Fetch repository events, which are sorted newest-first by default.
                    const eventsRes = await fetchWithToken(
                        'https://api.github.com/repos/Discord-Datamining/Discord-Datamining/events?per_page=100',
                        undefined,
                        true
                    );

                    if (!eventsRes.ok) return await interaction.respond([]);
                    const events = await eventsRes.json() as any[];

                    // Filter for commit comment events and extract the comment payload.
                    comments = events
                        .filter(event => event.type === 'CommitCommentEvent')
                        .map(event => event.payload.comment);

                } catch (error) {
                    console.error('Autocomplete failed during comment fetch:', error);
                    return await interaction.respond([]);
                }

                const choices = comments.map(comment => ({
                    name: `[${comment.commit_id.slice(0, 7)}] @${comment.user.login}: ${comment.body.slice(0, 25).replace(/\r?\n/g, ' ')}...`,
                    value: comment.id.toString()
                }));

                if (!focused.value) {
                    return await interaction.respond(choices.slice(0, 25));
                }

                // Filter by name OR comment ID for more robust searching.
                const filtered = choices.filter(choice => 
                    choice.name.toLowerCase().includes(focused.value.toLowerCase()) ||
                    choice.value.includes(focused.value)
                );
                await interaction.respond(filtered.slice(0, 25));
            }
        } catch (error) {
            console.error('❌ Autocomplete failed:', error);
        }
    },

    /**
     * Executes the /recall command.
     * @param interaction The chat input command interaction.
     */
    async execute(interaction: ChatInputCommandInteraction<CacheType>) {
        const passed = await commandGuard(interaction, { ownerOnly: true, guildOnly: true });
        if (!passed) return;

        const subCommand = interaction.options.getSubcommand();
        const subscriptionId = interaction.options.getString('subscription', true);
        const subscription = await Subscription.findById(subscriptionId);

        if (!subscription) {
            return interaction.reply({ content: '<:Cross:1425291759952593066> Subscription not found.', flags: MessageFlags.Ephemeral });
        }

        const channel = await interaction.client.channels.fetch(subscription.channelId).catch(() => null);
        if (!(channel instanceof TextChannel || channel instanceof NewsChannel)) {
            return interaction.reply({ content: '<:Cross:1425291759952593066> Channel not found or is not a text channel.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (subCommand === 'status') {
            try {
                const incidentId = interaction.options.getString('incident', true);
                const incident = await fetchIncidentById(incidentId); // Fetch specific incident

                if (!incident) {
                    return interaction.editReply({ content: '<:Cross:1425291759952593066> Incident not found.' });
                }

                const mentionString = await getStatusMentionPings(incident, subscription);
                const payload = buildStatusPayload(incident, mentionString);

                const messagePayload: any = {
                    components: payload.components,
                    flags: MessageFlags.IsComponentsV2
                };

                // Send a brand new message to the channel
                const sentMessage = await channel.send(messagePayload);

                if (subscription.autoPublish && channel instanceof NewsChannel) {
                    await crosspostMessage(sentMessage);
                }

                // Now, update the subscription's tracking data to point to the new message
                const existingIncident = subscription.incidents.find((i: IncidentData) => i.incidentId === incidentId);
                const lastUpdate = new Date(incident.updated_at);
                const lastUpdateId = incident.incident_updates?.[0]?.id;

                if (existingIncident) {
                    // If we were already tracking it, update the message ID to the new one
                    existingIncident.messageId = sentMessage.id;
                    existingIncident.lastUpdatedAt = lastUpdate;
                    existingIncident.lastUpdateId = lastUpdateId;
                    console.log(`🔄 Recalled incident ${incidentId}, updated message ID to ${sentMessage.id} for channel ${channel.id}`);
                } else {
                    // If we weren't tracking it, add it to the list
                    subscription.incidents.push({
                        incidentId: incident.id,
                        messageId: sentMessage.id,
                        lastUpdatedAt: lastUpdate,
                        lastUpdateId: lastUpdateId
                    });
                    console.log(`➕ Recalled incident ${incidentId}, now tracking with message ID ${sentMessage.id} for channel ${channel.id}`);
                }

                await subscription.save();
                await interaction.editReply({ content: `<:Checkmark:1425291737550557225> Recalled and is now tracking incident: ${incidentId}` });

            } catch (error) {
                console.error('Failed to recall status incident:', error);
                await interaction.editReply({ content: '<:Cross:1425291759952593066> Failed to recall status incident. Please try again later.' });
            }
        } else if (subCommand === 'previews') {
            try {
                if (!await isTokenLoaded()) {
                    return interaction.editReply({ content: '<:Cross:1425291759952593066> GitHub token is missing.' });
                }

                const commentId = interaction.options.getString('comment', true);
                const commentsRes = await fetchWithToken(
                    `https://api.github.com/repos/Discord-Datamining/Discord-Datamining/comments/${commentId}`,
                    undefined,
                    true
                );
                
                if (!commentsRes.ok) {
                    return interaction.editReply({ content: '<:Cross:1425291759952593066> Comment not found. Please check the ID and ensure it is a commit comment.' });
                }

                const comment = await commentsRes.json() as GitHubComment;

                const allRolesForSub = await RoleMentionsHandler.find({
                    guildId: interaction.guildId!,
                    type: SubscriptionType.PREVIEWS,
                    value: { $regex: `^${subscription._id}:` }
                });

                const sections = parseSections(comment.body);

                const payload = await buildCommitCommentPayload({
                    sha: comment.commit_id,
                    commentUrl: comment.html_url,
                    author: comment.user.login,
                    authorUrl: comment.user.html_url,
                    body: comment.body,
                    createdAt: comment.created_at,
                    roleMentions: {},
                    attachments: comment.attachments || [],
                    allRolesForSub,
                    isNewComment: false,
                    commentId: comment.id
                }, sections);

                const messagePayload: any = {
                    components: payload.components,
                    files: payload.files,
                    flags: MessageFlags.IsComponentsV2,
                };

                await channel.send(messagePayload);
                await interaction.editReply({ content: `<:Checkmark:1425291737550557225> Recalled commit comment: ${commentId}` });

            } catch (error) {
                console.error('Failed to dispatch previews:', error);
                await interaction.editReply({ content: '<:Cross:1425291759952593066> Failed to dispatch previews.' });
            }
        }
    }
};
