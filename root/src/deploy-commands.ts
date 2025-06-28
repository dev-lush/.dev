import { REST } from '@discordjs/rest';
import { Routes } from 'discord.js';
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const token = process.env.TOKEN!;
const clientId = process.env.CLIENT_ID!;

export async function deployCommands() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    const commands: any[] = [];

    // Commands directory path
    const commandsPath = path.join(__dirname, 'Commands');
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'));

    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const fileUrl = new URL('file:///' + filePath.replace(/\\/g, '/')).href; 
        try {
            const commandModule = await import(fileUrl); // Dynamically import the command file
            if (commandModule.data) { 
                commands.push(commandModule.data.toJSON()); // Ensure the command exports a `data` object
            } else {
                console.warn(`Command file "${file}" does not export a valid SlashCommandBuilder instance.`);
            }
        } catch (error) {
            console.error(`Error loading command file "${file}":`, error);
        }
    }

    const rest = new REST({ version: '10' }).setToken(token);

    try {
        console.log('Started refreshing global application (/) commands.');

        await rest.put(
            Routes.applicationCommands(clientId), // For global commands
            { body: commands },
        );

        console.log('Successfully reloaded global application (/) commands.');
    } catch (error) {
        console.error('Error refreshing commands:', error);
    }
}

// Run the function if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    deployCommands().catch(console.error);
}