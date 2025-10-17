import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import { randomUUID } from 'crypto';
import { commandGuard } from '../../Utils/commandGuard.js';

/**
 * @file Slash command to generate a version 4 UUID.
 */

export default {
    data: new SlashCommandBuilder()
        .setName('uuid')
        .setDescription('Generates and returns a new version 4 UUID.')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

    async execute(interaction: ChatInputCommandInteraction) {
        // Ensure the command can be used in the current context.
        const passed = await commandGuard(interaction, { global: true });
        if (!passed) return;

        // Generate a new v4 UUID using Node's built-in crypto module.
        const uuid = randomUUID();

        // Reply with the generated UUID, formatted as a code block, in an ephemeral message.
        await interaction.reply({
            content: uuid,
            flags: MessageFlags.Ephemeral
        });
    }
};