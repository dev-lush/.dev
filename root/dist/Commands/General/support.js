import { SlashCommandBuilder, InteractionCollector, ComponentType, ApplicationIntegrationType, InteractionContextType, MessageFlags, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, TextDisplayBuilder } from 'discord.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { commandGuard } from '../../Utils/commandGuard.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const messagesPath = path.join(__dirname, '..', '..', '..', '..', 'messages', 'support');
// --- Caching ---
const docCache = new Map();
/**
 * Reads and caches the support message files and metadata for a given subcommand.
 * @param subcommand The name of the subcommand (and the directory).
 * @returns A promise that resolves to the cached data.
 */
async function getSubcommandData(subcommand) {
    if (docCache.has(subcommand)) {
        return docCache.get(subcommand);
    }
    const dirPath = path.join(messagesPath, subcommand);
    const files = new Map();
    let meta = {};
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);
            if (entry.isFile() && entry.name.endsWith('.json')) {
                if (entry.name === '_meta.json') {
                    const metaContent = fs.readFileSync(entryPath, 'utf-8');
                    meta = JSON.parse(metaContent);
                }
                else {
                    const fileContent = fs.readFileSync(entryPath, 'utf-8');
                    const doc = JSON.parse(fileContent);
                    const fileName = entry.name.replace('.json', '');
                    files.set(fileName, doc);
                }
            }
        }
    }
    catch (error) {
        console.error(`Error reading support directory for subcommand "${subcommand}":`, error);
        return { files: new Map(), meta: {} };
    }
    docCache.set(subcommand, { files, meta });
    return { files, meta };
}
// --- Interaction Handler ---
/**
 * Sends a paginated, ephemeral reply with a list of recommended documents.
 * Used for tag search results.
 * @param interaction The StringSelectMenuInteraction that triggered the search.
 * @param subcommand The subcommand context.
 * @param matchingDocs An array of documents that matched the search.
 */
async function sendPaginatedRecommendations(interaction, subcommand, matchingDocs) {
    let page = 0;
    const itemsPerPage = 5;
    const totalPages = Math.ceil(matchingDocs.length / itemsPerPage);
    const generatePayload = (currentPage) => {
        const start = currentPage * itemsPerPage;
        const end = start + itemsPerPage;
        const currentDocs = matchingDocs.slice(start, end);
        const container = new ContainerBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder()
            .setContent(`**Found ${matchingDocs.length} matching documents.**\nSelect one from the menu below or browse through the pages.`));
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`support:${subcommand}:select`)
            .setPlaceholder('Select a document to view');
        currentDocs.forEach(([fileName, doc]) => {
            menu.addOptions({
                label: doc.name,
                description: doc.description?.substring(0, 100) || 'No description available.',
                value: fileName,
            });
        });
        const row1 = new ActionRowBuilder().addComponents(menu);
        const prevButton = new ButtonBuilder()
            .setCustomId('prev_page')
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage === 0);
        const nextButton = new ButtonBuilder()
            .setCustomId('next_page')
            .setLabel('Next')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage >= totalPages - 1);
        const row2 = new ActionRowBuilder().addComponents(prevButton, nextButton);
        return {
            components: [container, row1, row2],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        };
    };
    const message = await interaction.reply(generatePayload(page));
    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60000,
        filter: i => i.user.id === interaction.user.id,
    });
    collector.on('collect', async (i) => {
        if (i.customId === 'prev_page') {
            page--;
        }
        else if (i.customId === 'next_page') {
            page++;
        }
        await i.update(generatePayload(page));
    });
    collector.on('end', async () => {
        const finalPayload = generatePayload(page);
        finalPayload.components.forEach(row => {
            if (row instanceof ActionRowBuilder) {
                row.components.forEach(component => component.setDisabled(true));
            }
        });
        await interaction.editReply(finalPayload).catch(() => { });
    });
}
/**
 * Sends a potentially multi-page support message and handles all its interactions.
 * @param interaction The interaction to reply to.
 * @param doc The support file object to send.
 * @param ephemeral Whether the message should be ephemeral.
 * @param mentionsContent An optional string of mentions to include.
 * @param subcommand The subcommand context.
 */
async function sendDoc(interaction, doc, ephemeral, mentionsContent, subcommand) {
    let currentPage = 0;
    const getPage = (index) => doc.pages[index];
    const generatePayload = (index, finished = false) => {
        const pageData = getPage(index);
        const payload = { ...pageData };
        if (finished) {
            payload.components = pageData.components?.map((row) => {
                const newRow = { ...row, components: row.components.map((c) => ({ ...c, disabled: true })) };
                return newRow;
            });
        }
        else {
            const components = payload.components ? [...payload.components] : [];
            // --- Pagination Row ---
            if (doc.pages.length > 1) {
                const prevLabel = doc.pagination?.previous?.label ?? 'Previous';
                const prevEmoji = doc.pagination?.previous?.emoji;
                const nextLabel = doc.pagination?.next?.label ?? 'Next';
                const nextEmoji = doc.pagination?.next?.emoji;
                const jumpPlaceholder = doc.pagination?.jump?.placeholder ?? 'Select a page...';
                const paginationRow = new ActionRowBuilder();
                const prevButton = new ButtonBuilder()
                    .setCustomId('prev_page')
                    .setLabel(prevLabel)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(index === 0);
                if (prevEmoji)
                    prevButton.setEmoji(prevEmoji);
                const nextButton = new ButtonBuilder()
                    .setCustomId('next_page')
                    .setLabel(nextLabel)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(index === doc.pages.length - 1);
                if (nextEmoji)
                    nextButton.setEmoji(nextEmoji);
                paginationRow.addComponents(prevButton, nextButton);
                components.push(paginationRow);
                if (doc.page_meta && doc.page_meta.length > 0) {
                    const jumpMenuRow = new ActionRowBuilder();
                    const jumpMenu = new StringSelectMenuBuilder()
                        .setCustomId('jump_to_page')
                        .setPlaceholder(jumpPlaceholder)
                        .addOptions(doc.page_meta.map(meta => ({
                        label: meta.label,
                        description: meta.description,
                        value: meta.value,
                    })));
                    jumpMenuRow.addComponents(jumpMenu);
                    components.push(jumpMenuRow);
                }
            }
            payload.components = components;
        }
        if (pageData.componentsV2) {
            payload.flags = (payload.flags || 0) | MessageFlags.IsComponentsV2;
        }
        return payload;
    };
    const initialPayload = generatePayload(currentPage);
    if (mentionsContent) {
        initialPayload.content = `${mentionsContent}\n${initialPayload.content || ''}`;
    }
    if (interaction.isChatInputCommand()) {
        initialPayload.flags = ephemeral ? MessageFlags.Ephemeral : undefined;
        if (getPage(currentPage).componentsV2) {
            initialPayload.flags = (initialPayload.flags || 0) | MessageFlags.IsComponentsV2;
        }
    }
    else { // For StringSelectMenuInteraction, we are always editing an ephemeral message
        initialPayload.flags = MessageFlags.Ephemeral;
        if (getPage(currentPage).componentsV2) {
            initialPayload.flags |= MessageFlags.IsComponentsV2;
        }
    }
    const message = await interaction.editReply(initialPayload);
    const collector = new InteractionCollector(interaction.client, {
        message,
        time: 300_000, // 5 minutes
        filter: i => i.user.id === interaction.user.id,
    });
    collector.on('collect', async (i) => {
        await i.deferUpdate();
        if (i.isButton()) {
            if (i.customId === 'prev_page') {
                currentPage = Math.max(0, currentPage - 1);
            }
            else if (i.customId === 'next_page') {
                currentPage = Math.min(doc.pages.length - 1, currentPage + 1);
            }
            else {
                // Handle custom interaction buttons
                const interactionConfig = doc.interactions?.[i.customId];
                if (interactionConfig) {
                    const targetPageKey = interactionConfig.page;
                    const targetPageIndex = doc.pages.findIndex(p => p.value === targetPageKey);
                    if (targetPageIndex !== -1) {
                        const newPageData = getPage(targetPageIndex);
                        const newPayload = { ...newPageData };
                        if (newPageData.componentsV2) {
                            newPayload.flags = (newPayload.flags || 0) | MessageFlags.IsComponentsV2;
                        }
                        if (interactionConfig.action === 'edit') {
                            currentPage = targetPageIndex;
                            await i.editReply(generatePayload(currentPage));
                            return; // Return to not send another edit
                        }
                        else if (interactionConfig.action === 'followup') {
                            newPayload.ephemeral = true;
                            await i.followUp(newPayload);
                            return; // Return to not edit the original message
                        }
                    }
                }
            }
        }
        else if (i.isStringSelectMenu()) {
            if (i.customId === 'jump_to_page') {
                const pageValue = i.values[0];
                const targetIndex = doc.pages.findIndex(p => p.value === pageValue);
                if (targetIndex !== -1) {
                    currentPage = targetIndex;
                }
            }
            else {
                // Handle custom interaction menus
                const interactionConfig = doc.interactions?.[i.customId];
                if (interactionConfig) {
                    // This part is left for if you add select menu-based interactions
                }
            }
        }
        await i.editReply(generatePayload(currentPage));
    });
    collector.on('end', async () => {
        try {
            await message.edit(generatePayload(currentPage, true));
        }
        catch (error) {
            if (error.code !== 10008) { // Unknown Message
                console.error('Failed to disable components on support command:', error);
            }
        }
    });
}
/**
 * Handles the interaction from the tag selection menu.
 * @param interaction The StringSelectMenuInteraction.
 */
async function handleTagSelect(interaction) {
    const [, subcommand] = interaction.customId.split(':');
    const selectedTags = interaction.values;
    const { files, meta } = await getSubcommandData(subcommand);
    const matchingDocs = Array.from(files.entries()).filter(([, doc]) => {
        if (!doc.tags)
            return false;
        return selectedTags.every(selectedTag => doc.tags.includes(selectedTag));
    }).sort(([, a], [, b]) => (b.priority ?? 0) - (a.priority ?? 0));
    if (matchingDocs.length === 0) {
        return interaction.reply({
            content: 'No documents found matching all the selected tags.',
            flags: MessageFlags.Ephemeral,
        });
    }
    const limit = meta.tag_recommendation_limit ?? 25;
    await sendPaginatedRecommendations(interaction, subcommand, matchingDocs.slice(0, limit));
}
/**
 * Handles the interaction from the document selection menu in the recommendations message.
 * @param interaction The StringSelectMenuInteraction.
 */
async function handleDocSelect(interaction) {
    const [, subcommand] = interaction.customId.split(':');
    const query = interaction.values[0];
    await interaction.deferUpdate();
    const { files } = await getSubcommandData(subcommand);
    const doc = files.get(query);
    if (!doc) {
        await interaction.editReply({ content: '<:Cross:1425291759952593066> The requested document could not be found.', components: [] });
        return;
    }
    await sendDoc(interaction, doc, true, undefined, subcommand);
}
// --- Command Definition ---
/**
 * Reads the `messages/support` directory to find all available support categories
 * and their metadata to build the slash command subcommands dynamically.
 * @returns An array of subcommand information objects.
 */
async function getDocChoices(subcommand, query) {
    const { files, meta } = await getSubcommandData(subcommand);
    const lowerCaseQuery = query.toLowerCase();
    if (query.startsWith('#')) {
        const tag = query.slice(1).toLowerCase();
        return Array.from(files.entries())
            .filter(([, fileData]) => fileData.tags?.some(t => t.toLowerCase().startsWith(tag)))
            .map(([fileName, fileData]) => ({
            name: fileData.name,
            value: fileName,
        }))
            .slice(0, 25);
    }
    if (!query.trim() && meta.recommendations) {
        return meta.recommendations
            .map(rec => {
            const file = files.get(rec);
            return file ? { name: file.name, value: rec } : null;
        })
            .filter((c) => c !== null)
            .slice(0, 25);
    }
    // Simple search
    return Array.from(files.entries())
        .filter(([, fileData]) => fileData.name.toLowerCase().includes(lowerCaseQuery) ||
        fileData.description?.toLowerCase().includes(lowerCaseQuery))
        .map(([fileName, fileData]) => ({
        name: fileData.name,
        value: fileName,
    }))
        .slice(0, 25);
}
const commandBuilder = new SlashCommandBuilder()
    .setName('support')
    .setDescription('Display support and help messages.')
    .setIntegrationTypes([ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall])
    .setContexts([InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel]);
['general', 'developer', 'applications'].forEach(sub => {
    commandBuilder.addSubcommand(subcommand => subcommand
        .setName(sub)
        .setDescription(`Support for ${sub} topics.`)
        .addStringOption(option => option.setName('query')
        .setDescription('The topic to get help with. Use # for tags.')
        .setRequired(true)
        .setAutocomplete(true))
        .addStringOption(option => option.setName('mentions')
        .setDescription('Optional mentions (users or roles, comma-separated).'))
        .addBooleanOption(option => option.setName('ephemeral')
        .setDescription('Send the message ephemerally.')));
    getSubcommandData(sub); // Eagerly cache
});
export default {
    data: commandBuilder,
    async autocomplete(interaction) {
        const subcommand = interaction.options.getSubcommand(true);
        const focusedOption = interaction.options.getFocused(true);
        if (focusedOption.name === 'query') {
            const choices = await getDocChoices(subcommand, focusedOption.value);
            await interaction.respond(choices);
        }
    },
    async execute(interaction) {
        const passed = await commandGuard(interaction, { global: true });
        if (!passed)
            return;
        const subcommand = interaction.options.getSubcommand(true);
        const query = interaction.options.getString('query', true);
        const ephemeral = interaction.options.getBoolean('ephemeral') ?? false;
        const mentionsInput = interaction.options.getString('mentions');
        if (query === '##SELECT_TAGS##') {
            const { meta } = await getSubcommandData(subcommand);
            if (!meta.available_tags || meta.available_tags.length === 0) {
                return interaction.reply({ content: 'There are no tags available for this category.', flags: MessageFlags.Ephemeral });
            }
            const menu = new StringSelectMenuBuilder()
                .setCustomId(`support:${subcommand}:tags`)
                .setPlaceholder('Select tags to find relevant documents')
                .setMinValues(1)
                .setMaxValues(Math.min(meta.available_tags.length, 25))
                .addOptions(meta.available_tags);
            const row = new ActionRowBuilder().addComponents(menu);
            return interaction.reply({
                content: 'Please select one or more tags from the menu below to find what you\'re looking for.',
                components: [row],
                flags: MessageFlags.Ephemeral,
            });
        }
        await interaction.deferReply({ ephemeral });
        let mentionsContent;
        if (mentionsInput && !ephemeral) {
            const roleMentions = await interaction.guild?.roles.fetch();
            mentionsContent = mentionsInput.split(',')
                .map(m => m.trim())
                .map(mention => {
                if (mention.toLowerCase() === '@everyone')
                    return '@everyone';
                if (mention.toLowerCase() === '@here')
                    return '@here';
                const role = roleMentions?.find(r => r.name.toLowerCase() === mention.toLowerCase().replace(/^@/, ''));
                return role ? `<@&${role.id}>` : null;
            })
                .filter(m => m).join(' ');
        }
        const { files, meta } = await getSubcommandData(subcommand);
        const doc = files.get(query);
        if (!doc) {
            let notFoundMessage = { content: '<:Cross:1425291759952593066> The requested document could not be found.', flags: MessageFlags.Ephemeral };
            if (typeof meta.error_not_found === 'string') {
                notFoundMessage.content = meta.error_not_found;
            }
            else if (typeof meta.error_not_found === 'object') {
                notFoundMessage = { ...meta.error_not_found.pages[0], flags: MessageFlags.Ephemeral };
            }
            await interaction.editReply(notFoundMessage);
            return;
        }
        await sendDoc(interaction, doc, ephemeral, mentionsContent, subcommand);
    },
    handleTagSelect,
    handleDocSelect,
};
