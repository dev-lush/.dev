import { Client, ActivityType, GatewayIntentBits, Collection, Events, Routes } from "discord.js";
import * as dotenv from "dotenv";
import mongoose from "mongoose";
import fs from "fs";
import path from 'path';
import { fileURLToPath } from "url";
import { connectDatabase } from "./database.js";
import { REST } from "@discordjs/rest";
dotenv.config();
const { DISCORD_TOKEN, MONGODB_URI, CLIENT_ID } = process.env;
async function startBot() {
    if (!DISCORD_TOKEN || !MONGODB_URI || !CLIENT_ID) {
        console.error("Missing required environment variables (DISCORD_TOKEN, MONGODB_URI, CLIENT_ID).");
        process.exit(1);
    }
    try {
        await connectDatabase(MONGODB_URI);
    }
    catch (dbError) {
        console.error("Failed to connect to the database:", dbError);
        process.exit(1);
    }
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
        ],
    });
    client.slashCommands = new Collection();
    const commands = [];
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const commandsPath = path.join(__dirname, 'Commands');
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith(".js"));
    for (const file of commandFiles) {
        try {
            const filePath = path.join(commandsPath, file);
            const commandModule = await import('file:///' + filePath.replace(/\\/g, '/'));
            const command = commandModule.default;
            client.slashCommands.set(command.data.name, command);
            commands.push(command.data.toJSON());
        }
        catch (error) {
            console.error(`Failed to load command ${file}:`, error);
        }
    }
    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand())
            return;
        const command = client.slashCommands.get(interaction.commandName);
        if (!command)
            return;
        try {
            await command.execute(interaction);
        }
        catch (error) {
            console.error(`Error executing command ${interaction.commandName}:`, error);
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply({ content: 'There was an error while executing this command!' });
            }
            else {
                await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
            }
        }
    });
    client.once(Events.ClientReady, async (c) => {
        console.log(`Ready! Logged in as ${c.user.tag}`);
        c.user.setActivity("from discord.dev", { type: ActivityType.Watching });
        const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
        try {
            console.log('Started refreshing application (/) commands.');
            await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
            console.log('Successfully reloaded application (/) commands.');
        }
        catch (error) {
            console.error(error);
        }
        // Removed status monitoring logic from here.
        // Discord status updates are now handled in dedicated utilities/commands.
    });
    client.login(DISCORD_TOKEN);
    const shutdown = async (restart = false) => {
        console.log("Shutting down bot...");
        try {
            await client.destroy();
            if (mongoose.connection.readyState !== 0) {
                await mongoose.disconnect();
            }
            console.log("Bot has been shut down cleanly.");
            if (restart) {
                console.log("Restarting bot...");
                process.exit(1);
            }
            else {
                process.exit(0);
            }
        }
        catch (error) {
            console.error("Error during shutdown:", error);
            process.exit(1);
        }
    };
    process.on("SIGINT", () => shutdown(false));
    process.on("SIGTERM", () => shutdown(false));
    process.on("SIGHUP", () => shutdown(true));
}
startBot().catch(console.error);
