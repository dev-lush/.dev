/**
 * @file Slash command to generate a version 4 UUID.
 */

import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType,
    ContainerBuilder,
    TextDisplayBuilder
} from 'discord.js';
import { randomUUID } from 'crypto';
import { commandGuard } from '../../Utils/commandGuard.js';

export default {
    data: new SlashCommandBuilder()
        .setName('uuid')
        .setDescription('Generates and returns a new version 4 UUID.')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('mentions')
                .setDescription('Mentions to include. Separate with commas. Ex: @user, @role, @everyone')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('ephemeral')
                .setDescription('Whether to make the message ephemeral. Defaults to true.')
                .setRequired(false)),

    async execute(interaction: ChatInputCommandInteraction) {
        // Ensure the command can be used in the current context.
        const passed = await commandGuard(interaction, { global: true });
        if (!passed) return;

        const mentionsInput = interaction.options.getString('mentions');
        let ephemeral = interaction.options.getBoolean('ephemeral') ?? true;

        if (mentionsInput) {
            ephemeral = false;
        }

        let mentionsContent: string | undefined;
        if (mentionsInput && !ephemeral) {
            const mentionRegex = /(<@!?\d+>|<@&\d+>|@everyone|@here)/g;
            const validMentions = mentionsInput.match(mentionRegex);

            if (validMentions) {
                if (interaction.inGuild()) {
                    mentionsContent = validMentions.join(' ');
                } else {
                    const userMentions = validMentions.filter(m => m.match(/^<@!?\d+>$/));
                    if (userMentions.length > 0) {
                        mentionsContent = userMentions.join(' ');
                    }
                }
            }
        }

        // Generate a new v4 UUID using Node's built-in crypto module.
        const uuid = randomUUID();

        if (ephemeral) {
            await interaction.reply({
                content: `\`${uuid}\``,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const container = new ContainerBuilder()
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`### -# <:Tags:1431983719559987280> </uuid:1422972419206811711>\n\`${uuid}\``)
            );
            
        const components: any[] = [container];

        if (mentionsContent) {
            components.push({ type: 10, content: mentionsContent });
        }

        // Reply with the generated UUID.
        await interaction.reply({
            components,
            flags: MessageFlags.IsComponentsV2
        });
    }
};