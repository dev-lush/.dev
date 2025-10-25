import { SlashCommandBuilder, MessageFlags, InteractionContextType, ApplicationIntegrationType } from 'discord.js';
import { format } from 'date-fns';
import { fetchIncidents, fetchIncidentById, buildStatusContainer } from '../../Utils/discordStatus.js';
import { buildCommitCommentPayload, isTokenLoaded, parseSections } from '../../Utils/commitMessage.js';
import { commandGuard } from '../../Utils/commandGuard.js';
import { fetchWithToken } from '../../Models/GitHubToken.js';
import { gitHubUpdateGate } from '../../Utils/pollGate.js';
await gitHubUpdateGate.requestImmediatePoll().catch(() => { });
export default {
    data: new SlashCommandBuilder()
        .setName('send')
        .setDescription('Send a specific incident or commit comment.')
        .setIntegrationTypes([ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall])
        .setContexts([InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel])
        .addSubcommand(subcommand => subcommand
        .setName('status')
        .setDescription('Send a specific Discord Status incident or maintenance.')
        .addStringOption(option => option.setName('incident')
        .setDescription('The incident or maintenance to send.')
        .setRequired(true)
        .setAutocomplete(true))
        .addStringOption(option => option.setName('mentions')
        .setDescription('Mentions to include. Separate with commas. Ex: @user, @role, @everyone')
        .setRequired(false))
        .addBooleanOption(option => option.setName('ephemeral')
        .setDescription('Whether to make the message ephemeral.')
        .setRequired(false)))
        .addSubcommand(subcommand => subcommand
        .setName('previews')
        .setDescription('Send a specific commit comment.')
        .addStringOption(option => option.setName('comment')
        .setDescription('The commit comment to send.')
        .setRequired(true)
        .setAutocomplete(true))
        .addStringOption(option => option.setName('mentions')
        .setDescription('Optional mentions (users or roles, comma-separated).')
        .setRequired(false))
        .addBooleanOption(option => option.setName('ephemeral')
        .setDescription('Whether to make the message ephemeral.')
        .setRequired(false))),
    /**
     * Handles autocomplete requests for the command.
     * @param interaction The autocomplete interaction.
     */
    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        const subCommand = interaction.options.getSubcommand();
        try {
            // Autocomplete for 'status' subcommand's 'incident' option
            if (subCommand === 'status' && focused.name === 'incident') {
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
            }
            else if (subCommand === 'previews' && focused.name === 'comment') {
                if (!await isTokenLoaded()) {
                    return await interaction.respond([{ name: 'GitHub token is missing.', value: 'missing' }]);
                }
                let comments;
                try {
                    // Fetch repository events, which are sorted newest-first by default.
                    // This is much faster than paginating through all comments and avoids timeouts.
                    const eventsRes = await fetchWithToken('https://api.github.com/repos/Discord-Datamining/Discord-Datamining/events?per_page=100', undefined, true);
                    if (!eventsRes.ok) {
                        console.error('GitHub API error (repo events):', await eventsRes.text());
                        return await interaction.respond([]);
                    }
                    const events = await eventsRes.json();
                    // Filter for commit comment events and extract the comment payload.
                    comments = events
                        .filter(event => event.type === 'CommitCommentEvent')
                        .map(event => event.payload.comment);
                }
                catch (e) {
                    console.error('Failed to parse GitHub repo events response:', e);
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
                const filtered = choices.filter(choice => choice.name.toLowerCase().includes(focused.value.toLowerCase()) ||
                    choice.value.includes(focused.value));
                await interaction.respond(filtered.slice(0, 25));
            }
        }
        catch (error) {
            console.error('❌ Autocomplete failed:', error);
        }
    },
    /**
     * Executes the /send command.
     * @param interaction The chat input command interaction.
     */
    async execute(interaction) {
        const passed = await commandGuard(interaction, { global: true });
        if (!passed)
            return;
        const subCommand = interaction.options.getSubcommand();
        const ephemeral = interaction.options.getBoolean('ephemeral') ?? false;
        const mentionsInput = interaction.options.getString('mentions');
        await interaction.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : undefined });
        let mentionsContent;
        if (mentionsInput && !ephemeral) {
            const mentionRegex = /(<@!?\d+>|<@&\d+>|@everyone|@here)/g;
            const validMentions = mentionsInput.match(mentionRegex);
            if (validMentions) {
                if (interaction.inGuild()) {
                    // All mention types are valid in guilds
                    mentionsContent = validMentions.join(' ');
                }
                else {
                    // Only user mentions are valid in DMs
                    const userMentions = validMentions.filter(m => m.match(/^<@!?\d+>$/));
                    if (userMentions.length > 0) {
                        mentionsContent = userMentions.join(' ');
                    }
                }
            }
        }
        if (subCommand === 'status') {
            try {
                const incidentId = interaction.options.getString('incident', true);
                const incident = await fetchIncidentById(incidentId); // Fetch specific incident
                if (!incident) {
                    return interaction.editReply({ content: '<:Cross:1425291759952593066> Incident not found.' });
                }
                const container = buildStatusContainer(incident, true);
                const components = [container];
                if (mentionsContent) {
                    components.push({ type: 10, content: mentionsContent });
                }
                await interaction.editReply({
                    components,
                    flags: ephemeral ? MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 : MessageFlags.IsComponentsV2
                });
            }
            catch (error) {
                console.error('Failed to send status message:', error);
                await interaction.editReply({ content: '<:Cross:1425291759952593066> An error occurred while sending the **Discord Status** message.' });
            }
        }
        else if (subCommand === 'previews') {
            try {
                if (!await isTokenLoaded()) {
                    return interaction.editReply({ content: '<:Cross:1425291759952593066> GitHub token is missing.' });
                }
                const commentId = interaction.options.getString('comment', true);
                const commentsRes = await fetchWithToken(`https://api.github.com/repos/Discord-Datamining/Discord-Datamining/comments/${commentId}`, undefined, true);
                if (!commentsRes.ok) {
                    return interaction.editReply({ content: '<:Cross:1425291759952593066> Comment not found. Please check the ID and ensure it is a commit comment.' });
                }
                const comment = await commentsRes.json();
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
                    isNewComment: false,
                    commentId: comment.id
                }, sections);
                const components = payload.components;
                if (mentionsContent) {
                    components.push({ type: 10, content: mentionsContent });
                }
                await interaction.editReply({
                    components,
                    files: payload.files,
                    flags: ephemeral ? MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 : MessageFlags.IsComponentsV2
                });
            }
            catch (error) {
                console.error('Failed to send preview:', error);
                await interaction.editReply({ content: '<:Cross:1425291759952593066> An error occurred while sending a **Discord Previews** commit comment.' });
            }
        }
    }
};
function capitalize(status) {
    // Replace underscores/hyphens with spaces, then capitalize each word.
    if (!status)
        return status;
    return status
        .toString()
        .replace(/[_-]+/g, ' ')
        .split(' ')
        .map(s => s.length ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '')
        .join(' ');
}
