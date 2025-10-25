import { Client, ActivityType, GatewayIntentBits, Collection, Events, MessageFlags } from 'discord.js';
import * as dotenv from 'dotenv';
dotenv.config();
import sharp from 'sharp';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDatabase } from './database.js';
import { checkNewCommitComments } from './Utils/commitMessage.js';
import { handleIncidents, fetchActiveIncidents } from './Utils/discordStatus.js';
import { Subscription, SubscriptionType } from './Models/Subscription.js';
import app from './webhook.js';
import { initializeGitHubTokens } from './Models/GitHubToken.js';
import { republishMessages } from './Utils/autoPublisher.js';
import { warnMissingPerms } from './System Messages/System/permissionNotifier.js';
import { preloadFonts } from './Assets/fonts.js';
import { handleAssetButton } from './Utils/interactionHandlers.js';
import { handleChannelPermsModal } from './Commands/Management/channel.js';
import { gitHubUpdateGate, statusUpdateGate } from './Utils/pollGate.js';
const { DISCORD_TOKEN, MONGODB_URI, CLIENT_ID, PORT } = process.env;
// Centralized error handling for unhandled promise rejections and uncaught exceptions.
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
/**
 * Initializes and starts the Discord bot and all related services.
 * This includes connecting to the database, loading commands, starting the web server,
 * and logging into Discord.
 */
async function startBot() {
    // Configure Sharp for production performance
    sharp.cache({ files: 0, items: 0, memory: 50 });
    sharp.concurrency(Math.max(1, os.cpus().length / 2));
    sharp.simd(true);
    // Validate required environment variables before starting.
    if (!DISCORD_TOKEN || !MONGODB_URI || !CLIENT_ID) {
        console.error('Missing required environment variables');
        process.exit(1);
    }
    // Connect to MongoDB before doing anything else.
    await connectDatabase(MONGODB_URI).catch(err => {
        console.error('❌ Database connection failed:', err);
        process.exit(1);
    });
    // Initialize GitHub tokens from environment variables.
    await initializeGitHubTokens().catch(err => {
        console.error('⚠️ Could not initialize GitHub tokens:', err);
    });
    // Preload custom fonts for the image generator.
    await preloadFonts();
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMembers,
        ]
    });
    client.slashCommands = new Collection();
    // Dynamically load all command files from the 'Commands' directory.
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const commandsPath = path.join(__dirname, 'Commands');
    const loadCommands = async (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await loadCommands(fullPath);
            }
            else if (entry.isFile() && entry.name.endsWith('.js')) {
                try {
                    const mod = await import(`file:///${fullPath}`);
                    if (mod.default && mod.default.data) {
                        client.slashCommands.set(mod.default.data.name, mod.default);
                    }
                    else {
                        console.error(`⌛ Command file is missing default export or data property: ${fullPath}`);
                    }
                }
                catch (e) {
                    console.error('⌛ Error loading command:', fullPath, e);
                }
            }
        }
    };
    await loadCommands(commandsPath);
    // Start the Express server for webhooks before logging in the Discord client.
    try {
        const port = PORT ? parseInt(PORT) : 3000;
        // Make the Discord client instance available to webhook routes.
        app.set('client', client);
        // Start Express server.
        const server = app.listen(port, () => {
            console.log(`🌐 Webhook server listening on port ${port}`);
        });
        // Handle potential server errors, like a port being in use.
        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`❌ Port ${port} is already in use`);
            }
            else {
                console.error('❌ Express server error:', error);
            }
            process.exit(1);
        });
    }
    catch (error) {
        console.error('❌ Failed to start Express server:', error);
        process.exit(1);
    }
    // Set up Discord client event handlers.
    client.once('clientReady', async (readyClient) => {
        console.log(`🚀 ${readyClient.user?.tag} ready`);
        // Set up a rotating presence for the bot.
        const statuses = [
            { type: ActivityType.Watching, name: 'from discord.dev' },
            { type: ActivityType.Listening, name: 'Discord API' }
        ];
        let idx = 0;
        readyClient.user.setPresence({ activities: [statuses[idx]] });
        setInterval(() => {
            idx = (idx + 1) % statuses.length;
            readyClient.user.setPresence({ activities: [statuses[idx]] });
        }, 2 * 60_000);
        // Register all loaded slash commands with Discord.
        try {
            console.log('🔄 Registering application commands...');
            const commands = client.slashCommands.map(command => {
                // Accommodate both builders (.toJSON()) and raw data objects.
                const data = typeof command.data.toJSON === 'function'
                    ? command.data.toJSON()
                    : command.data;
                return data;
            });
            // Global command registration. This is the recommended method.
            if (!client.application)
                throw new Error('Client application is not ready');
            await client.application.commands.set(commands);
            console.log(`✅ Successfully registered ${commands.length} application commands`);
        }
        catch (error) {
            console.error('❌ Failed to register application commands:', error);
        }
        // Start all background polling tasks.
        await startPolling(client);
    });
    // Handle incoming command and autocomplete interactions.
    client.on(Events.InteractionCreate, async (interaction) => {
        if (interaction.isButton() && interaction.customId.startsWith('view_asset:')) {
            return handleAssetButton(interaction);
        }
        if (interaction.isChatInputCommand()) {
            const command = client.slashCommands.get(interaction.commandName);
            if (!command)
                return;
            try {
                await command.execute(interaction);
            }
            catch (error) {
                console.error(`❌ Error executing command ${interaction.commandName}:`, error);
                // Generic error reply to the user, ensuring a response is always sent.
                try {
                    if (interaction.replied || interaction.deferred) {
                        await interaction.followUp({ content: '<:Cross:1425291759952593066> An error occurred while executing this command.', flags: MessageFlags.Ephemeral });
                    }
                    else {
                        await interaction.reply({ content: '<:Cross:1425291759952593066> An error occurred while executing this command.', flags: MessageFlags.Ephemeral });
                    }
                }
                catch (e) {
                    console.error(`❌ Error sending error message for ${interaction.commandName}:`, e);
                }
            }
        }
        else if (interaction.isAutocomplete()) {
            const command = client.slashCommands.get(interaction.commandName);
            if (command?.autocomplete) {
                try {
                    await command.autocomplete(interaction);
                }
                catch (error) {
                    console.error(`❌ Error handling autocomplete for ${interaction.commandName}:`, error);
                }
            }
        }
        else if (interaction.isModalSubmit()) {
            const modalId = interaction.customId ?? '';
            if (modalId.startsWith('channel_perms')) {
                try {
                    if (typeof handleChannelPermsModal === 'function') {
                        await handleChannelPermsModal(interaction);
                    }
                    else {
                        const cmd = client.slashCommands?.get?.('channel');
                        if (cmd && typeof cmd.handleChannelPermsModal === 'function') {
                            await cmd.handleChannelPermsModal(interaction);
                        }
                        else {
                            throw new Error('channel modal handler not found');
                        }
                    }
                }
                catch (err) {
                    console.error('[bot] channel modal handler threw', err);
                    // Attempt to inform the user once if possible
                    if (!interaction.replied && !interaction.deferred) {
                        try {
                            await interaction.reply({ content: '<:Warning:1326742459912425494> An error occurred processing the modal.', flags: MessageFlags.Ephemeral });
                        }
                        catch (e) {
                            console.error('[bot] failed to send modal error reply', e);
                        }
                    }
                }
                return;
            }
        }
        else if (interaction.isStringSelectMenu()) {
            const [commandName, , action] = interaction.customId.split(':');
            if (!commandName || !action)
                return;
            const command = client.slashCommands.get(commandName);
            if (!command)
                return;
            try {
                if (action === 'tags' && command.handleTagSelect) {
                    await command.handleTagSelect(interaction);
                }
                else if (action === 'select' && command.handleDocSelect) {
                    await command.handleDocSelect(interaction);
                }
            }
            catch (error) {
                console.error(`❌ Error handling select menu for ${interaction.customId}:`, error);
                try {
                    if (interaction.replied || interaction.deferred) {
                        await interaction.followUp({ content: '<:Cross:1425291759952593066> An error occurred while processing your selection.', flags: MessageFlags.Ephemeral });
                    }
                    else {
                        await interaction.reply({ content: '<:Cross:1425291759952593066> An error occurred while processing your selection.', flags: MessageFlags.Ephemeral });
                    }
                }
                catch (e) {
                    console.error(`❌ Error sending select menu error message for ${interaction.customId}:`, e);
                }
            }
        }
    });
    // Log in to Discord. This should be the final step.
    try {
        await client.login(DISCORD_TOKEN);
    }
    catch (error) {
        console.error('❌ Failed to log in to Discord:', error);
        process.exit(1);
    }
}
/**
 * Starts all periodic polling tasks for the bot.
 * @param client The authenticated Discord client instance.
 */
async function startPolling(client) {
    // GitHub commit comment polling is now entirely managed by the GitHubUpdateGate.
    // Poll for Discord Status updates every 60 seconds.
    // This is now managed by the StatusUpdateGate to allow fallback from webhooks.
    const pollStatusFn = async (c) => {
        try {
            const subscriptions = await Subscription.find({ type: SubscriptionType.STATUS });
            if (subscriptions.length === 0)
                return;
            const activeIncidents = await fetchActiveIncidents();
            for (const subscription of subscriptions) {
                await handleIncidents(c, subscription, activeIncidents);
            }
        }
        catch (err) {
            console.error('❌ Error polling status incidents:', err);
        }
    };
    // Initialize the status update gatekeeper
    statusUpdateGate.init(client, pollStatusFn);
    // Periodically clean up subscriptions for channels that no longer exist.
    setInterval(async () => {
        try {
            const subscriptions = await Subscription.find();
            for (const sub of subscriptions) {
                const channel = await client.channels.fetch(sub.channelId).catch(() => null);
                if (!channel) {
                    console.log(`🧹 Removing orphaned subscription for channel ${sub.channelId}`);
                    await Subscription.findByIdAndDelete(sub._id);
                }
            }
        }
        catch (err) {
            console.error('❌ Error cleaning up subscriptions:', err);
        }
    }, 10 * 60_000);
    // Periodically check for and republish any announcements that failed to crosspost.
    setInterval(async () => {
        try {
            await republishMessages(client);
        }
        catch (err) {
            console.error('❌ Error processing republish queue:', err);
        }
    }, 15 * 60_000);
    /**
     * Periodically check permissions for all subscriptions to ensure the bot can still post updates.
     * This runs every hour.
     */
    setInterval(async () => {
        try {
            const subscriptions = await Subscription.find();
            for (const sub of subscriptions) {
                const guild = await client.guilds.fetch(sub.guildId).catch(() => null);
                if (guild) {
                    await warnMissingPerms(client, guild, sub);
                }
            }
        }
        catch (err) {
            console.error('❌ Error during periodic permission check:', err);
        }
    }, 60 * 60 * 1000);
    // Initialize the smart polling controller for commits.
    // The controller decides whether to run continuous polling (if GitHub App not installed)
    // or to rely on webhooks (if the App is installed), and it can enable temporary polling
    // on transient failures.
    try {
        await gitHubUpdateGate.init(client, async (c) => {
            try {
                const processedCount = await checkNewCommitComments(c);
                return processedCount;
            }
            catch (err) {
                console.error('❌ Error during commit poll (controller):', err);
                throw err;
            }
        });
    }
    catch (err) {
        console.warn('[bot] GitHubUpdateGate.init failed, falling back to basic polling interval.');
        // fallback: if the gate fails to init, start a basic setInterval so bot remains functional.
        const fallbackPoll = async () => {
            try {
                await checkNewCommitComments(client);
            }
            catch (e) {
                console.error('[bot] fallback poll error:', e);
            }
        };
        fallbackPoll();
        setInterval(fallbackPoll, 15_000);
    }
}
// Start the application and catch any fatal errors during initialization.
startBot().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});
