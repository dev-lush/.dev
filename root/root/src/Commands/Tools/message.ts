import {
    SlashCommandBuilder,
    AutocompleteInteraction,
    ChatInputCommandInteraction,
    InteractionCollector,
    ComponentType,
    ApplicationIntegrationType,
    InteractionContextType,
    CacheType,
    StringSelectMenuInteraction,
    MessageFlags,
    APISelectMenuOption
} from 'discord.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { commandGuard } from '../../Utils/commandGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const messagesPath = path.join(__dirname, '..', '..', '..', '..', 'messages', '!content');

// --- Interfaces ---
interface PageMeta {
    label: string;
    description?: string;
    value: string; // page index
}

interface DocPage extends Record<string, any> {
    value?: string | number;
    componentsV2?: boolean;
}

interface DocFile {
    name: string;
    description?: string;
    pages: DocPage[];
    page_meta?: PageMeta[];
    interactions?: {
        [customId: string]: {
            action: 'followup' | 'edit';
            page: string | number;
        }
    };
}

interface DocMeta {
    description?: string;
    error_not_found?: string | DocFile;
}

interface SubcommandInfo {
    name: string;
    description: string;
}

// --- Caching ---
const docCache = new Map<string, { files: Map<string, DocFile>, meta: DocMeta }>();

/**
 * Reads and caches the message files and metadata for a given subcommand.
 * @param subcommand The name of the subcommand (and the directory).
 * @returns A promise that resolves to the cached data.
 */
async function getSubcommandData(subcommand: string): Promise<{ files: Map<string, DocFile>, meta: DocMeta }> {
    if (docCache.has(subcommand)) {
        return docCache.get(subcommand)!;
    }

    const dirPath = path.join(messagesPath, subcommand);
    const files = new Map<string, DocFile>();
    let meta: DocMeta = {};

    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);
            if (entry.isFile() && entry.name.endsWith('.json')) {
                if (entry.name === '_meta.json') {
                    const metaContent = fs.readFileSync(entryPath, 'utf-8');
                    meta = JSON.parse(metaContent);
                } else {
                    const fileContent = fs.readFileSync(entryPath, 'utf-8');
                    const doc = JSON.parse(fileContent) as DocFile;
                    const fileName = entry.name.replace('.json', '');
                    files.set(fileName, doc);
                }
            }
        }
    } catch (error) {
        console.error(`Error reading message directory for subcommand "${subcommand}":`, error);
        // Return empty data if directory doesn't exist or other error occurs
        return { files: new Map(), meta: {} };
    }

    docCache.set(subcommand, { files, meta });
    return { files, meta };
}

// --- Interaction Handler ---

/**
 * Sends a potentially multi-page message and handles all its interactions.
 * @param interaction The ChatInputCommandInteraction to reply to.
 * @param doc The file object to send.
 * @param ephemeral Whether the message should be ephemeral.
 */
async function sendDoc(interaction: ChatInputCommandInteraction, doc: DocFile, ephemeral: boolean) {
    let currentPage = 0;
    const getPage = (index: number) => doc.pages[index];

    const initialPage = getPage(currentPage);
    const messagePayload: any = {
        ...initialPage,
        flags: ephemeral ? MessageFlags.Ephemeral : undefined,
    };

    if (initialPage.componentsV2) {
        messagePayload.flags = (messagePayload.flags || 0) | MessageFlags.IsComponentsV2;
    }

    const message = await interaction.editReply(messagePayload);

    if (!doc.interactions) return;

    const collector = new InteractionCollector(interaction.client, {
        message,
        time: 300_000, // 5 minutes
        filter: i => i.user.id === interaction.user.id,
    });

    collector.on('collect', async (i: any) => {
        if (!i.isButton() && !i.isStringSelectMenu()) return;

        const interactionConfig = doc.interactions?.[i.customId];
        if (!interactionConfig) return;

        const targetPageKey = interactionConfig.page;
        const targetPageIndex = doc.pages.findIndex(p => p.value === targetPageKey);

        if (targetPageIndex === -1) {
            console.warn(`Interaction "${i.customId}" pointed to non-existent page value "${targetPageKey}".`);
            await i.deferUpdate().catch(() => {});
            return;
        }

        const newPageData = getPage(targetPageIndex);
        const newPayload: any = { ...newPageData };
        if (newPageData.componentsV2) {
            newPayload.flags = (newPayload.flags || 0) | MessageFlags.IsComponentsV2;
        }


        if (interactionConfig.action === 'edit') {
            currentPage = targetPageIndex;
            await i.update(newPayload);
        } else if (interactionConfig.action === 'followup') {
            newPayload.ephemeral = true;
            await i.reply(newPayload);
        }
    });

    collector.on('end', async () => {
        try {
            const latestState = getPage(currentPage);
            const disabledPayload: any = {
                ...latestState,
                components: latestState.components?.map((row: any) => ({
                    ...row,
                    components: row.components.map((comp: any) => ({ ...comp, disabled: true })),
                })),
            };
            if (latestState.componentsV2) {
                disabledPayload.flags = (disabledPayload.flags || 0) | MessageFlags.IsComponentsV2;
            }
            await message.edit(disabledPayload);
        } catch (error: any) {
            if (error.code !== 10008) { // Unknown Message
                console.error('Failed to disable components on message command:', error);
            }
        }
    });
}

// --- Command Definition ---
/**
 * Reads the `messages/playground` directory to find all available categories
 * and their metadata to build the slash command subcommands dynamically.
 * @returns An array of subcommand information objects.
 */
function getSubcommands(): SubcommandInfo[] {
    try {
        const subdirectories = fs.readdirSync(messagesPath, { withFileTypes: true })
            .filter((dirent: fs.Dirent) => dirent.isDirectory())
            .map((dirent: fs.Dirent) => dirent.name);

        return subdirectories.map((name: string) => {
            let description = `Messages from the "${name}" category.`;
            const metaPath = path.join(messagesPath, name, '_meta.json');
            try {
                if (fs.existsSync(metaPath)) {
                    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                    if (meta.description) {
                        description = meta.description;
                    }
                }
            } catch { /* ignore meta parsing errors */ }
            return { name, description };
        });
    } catch (error) {
        console.error('Error reading subcommands for /message:', error);
        return [];
    }
}

/**
 * Gets the autocomplete choices for a given subcommand and query.
 * @param subcommand The subcommand context.
 * @param query The user's current input.
 * @returns A promise that resolves to an array of autocomplete choices.
 */
async function getDocChoices(subcommand: string, query: string): Promise<{ name: string; value: string }[]> {
    const { files } = await getSubcommandData(subcommand);
    const lowerCaseQuery = query.toLowerCase();

    const choices = Array.from(files.entries())
        .map(([fileName, fileData]) => ({
            name: fileData.name,
            value: fileName,
        }))
        .filter(choice => choice.name.toLowerCase().includes(lowerCaseQuery));

    return choices.slice(0, 25);
}

const commandBuilder = new SlashCommandBuilder()
    .setName('message')
    .setDescription('Send a pre-defined message.')
    .setIntegrationTypes([ApplicationIntegrationType.UserInstall])
    .setContexts([InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel]);

// Pre-cache data before building commands
(async () => {
    try {
        const subcommands = getSubcommands();
        subcommands.forEach(sub => {
            commandBuilder.addSubcommand(subcommand =>
                subcommand
                    .setName(sub.name)
                    .setDescription(sub.description)
                    .addStringOption(option =>
                        option.setName('query')
                            .setDescription('The specific message to send.')
                            .setRequired(true)
                            .setAutocomplete(true))
                    .addBooleanOption(option =>
                        option.setName('ephemeral')
                            .setDescription('Send the message ephemerally.'))
            );
            // Eagerly cache subcommand data
            getSubcommandData(sub.name);
        });
    } catch (error) {
        console.error('Failed to build /message subcommands:', error);
    }
})();


export default {
    data: commandBuilder,

    /**
     * Handles autocomplete requests for the /message command.
     * @param interaction The autocomplete interaction.
     */
    async autocomplete(interaction: AutocompleteInteraction) {
        const subcommand = interaction.options.getSubcommand(true);
        const focusedOption = interaction.options.getFocused(true);

        if (focusedOption.name === 'query') {
            const choices = await getDocChoices(subcommand, focusedOption.value);
            await interaction.respond(choices);
        }
    },

    /**
     * Executes the /message command.
     * @param interaction The chat input command interaction.
     */
    async execute(interaction: ChatInputCommandInteraction<CacheType>) {
        const passed = await commandGuard(interaction, { ownerOnly: true, global: true });
        if (!passed) return;

        const subcommand = interaction.options.getSubcommand(true);
        const query = interaction.options.getString('query', true);
        const ephemeral = interaction.options.getBoolean('ephemeral') ?? false;

        await interaction.deferReply({ ephemeral });

        const { files, meta } = await getSubcommandData(subcommand);
        const doc = files.get(query);

        if (!doc) {
            let notFoundMessage: any = { content: '<:Cross:1425291759952593066> The requested message could not be found.', flags: MessageFlags.Ephemeral };
            if (typeof meta.error_not_found === 'string') {
                notFoundMessage.content = meta.error_not_found;
            } else if (typeof meta.error_not_found === 'object') {
                notFoundMessage = { ...meta.error_not_found.pages[0], flags: MessageFlags.Ephemeral };
            }
            await interaction.editReply(notFoundMessage);
            return;
        }

        await sendDoc(interaction, doc, ephemeral);
    }
};