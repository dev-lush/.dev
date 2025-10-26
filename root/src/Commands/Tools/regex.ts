/**
 * @file Slash command to generate a regular expression.
 */

import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType,
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType
} from 'discord.js';
import { commandGuard } from '../../Utils/commandGuard.js';

/**
 * Escapes characters that have a special meaning in regex.
 * @param str The string to escape.
 * @returns The escaped string.
 */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// This regex detects if a term contains advanced regex syntax.
// If it does, we treat it as a raw pattern instead of a simple literal.
const IS_ADVANCED_REGEX_TERM = /[\(\)\[\]\{\}\?\+\^\$\.\\]/;

/**
 * Processes a single user-provided term, handling wildcards, escaping, and word boundaries for simple
 * terms, while leaving advanced regex patterns untouched.
 * @param term The raw term from the user input.
 * @returns A processed, regex-safe string component.
 */
function processTerm(term: string): string {
    // 1. Un-escape user-escaped characters that we use as separators.
    let unescaped = term.replace(/\\([,|/&+*\\])/g, '$1').trim();
    if (!unescaped) return '';

    // 2. Check if the term is "advanced" (contains regex syntax) or "simple".
    if (IS_ADVANCED_REGEX_TERM.test(unescaped)) {
        // This term contains regex metacharacters, so we treat it as a raw pattern.
        return unescaped;
    }

    // 3. If it's a "simple" term, apply the original logic.
    const startsWithStar = unescaped.startsWith('*');
    if (startsWithStar) {
        unescaped = unescaped.substring(1);
    }
    const endsWithStar = unescaped.endsWith('*');
    if (endsWithStar) {
        unescaped = unescaped.slice(0, -1);
    }

    // Escape any remaining characters that could be interpreted as regex.
    const escapedCore = escapeRegex(unescaped);

    // Re-assemble with regex wildcards or word boundaries.
    if (startsWithStar || endsWithStar) {
        let final = escapedCore;
        if (startsWithStar) final = '.*' + final;
        if (endsWithStar) final = final + '.*';
        return final;
    } else {
        // No wildcards, use word boundaries for whole-word matching.
        return `\\b${escapedCore}\\b`;
    }
}

/**
 * Validates a generated regex against the limitations of a specific flavour (e.g., RE2).
 * @param regex The generated regex string.
 * @param flavour The selected language flavour.
 * @returns An object containing an array of warning messages.
 */
function validateForFlavour(regex: string, flavour: string): { warnings: string[] } {
    const warnings: string[] = [];

    // Go and Rust use the RE2 engine, which has notable limitations.
    if (flavour === 'rust' || flavour === 'go') {
        // Check for lookbehind assertions: (?<=...) and (?<!...)
        if (/\(\?\<[=!]/.test(regex)) {
            warnings.push(`Lookbehind assertions (\`(?<=...)\`, \`(?<!...)\`) are not supported in the ${flavour} (RE2) regex engine.`);
        }

        // Check for backreferences: \1, \2, etc. This is a heuristic check.
        const backrefMatch = regex.match(/(?<!\\)\\\d/);
        if (backrefMatch) {
            warnings.push(`Backreferences (e.g., \`\\1\`) are not supported in the ${flavour} (RE2) regex engine.`);
        }
    }

    return { warnings };
}


export default {
    data: new SlashCommandBuilder()
        .setName('regex')
        .setDescription('Generates a regular expression from a list of inputs.')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('flavour')
                .setDescription('The regex flavour to use. Note: Rust is used by Discord AutoMod.')
                .setRequired(true)
                .addChoices(
                    { name: 'PCRE (PHP)', value: 'pcre' },
                    { name: 'JavaScript', value: 'javascript' },
                    { name: 'Python', value: 'python' },
                    { name: 'Java', value: 'java' },
                    { name: '.NET', value: 'dotnet' },
                    { name: 'Go', value: 'go' },
                    { name: 'Ruby', value: 'ruby' },
                    { name: 'Rust', value: 'rust' }
                ))
        .addStringOption(option =>
            option.setName('input')
                .setDescription('Use ,|/ for OR, &+ for AND. Simple words are matched whole. Use regex syntax for advanced patterns.')
                .setRequired(true))
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

        const flavour = interaction.options.getString('flavour', true);
        const userInput = interaction.options.getString('input', true);
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

        const orParts = userInput.split(/(?<!\\)[,|/]/g);
        const finalOrParts = orParts.map(orPart => {
            const trimmedOrPart = orPart.trim();
            if (!trimmedOrPart) return null;
            const andParts = trimmedOrPart.split(/(?<!\\)[&+]/g);
            const processedAndParts = andParts.map(processTerm).filter(p => p.length > 0);
            if (processedAndParts.length === 0) return null;
            return processedAndParts.length > 1 ? processedAndParts.map(p => `(?=.*${p})`).join('') : processedAndParts[0];
        }).filter((p): p is string => p !== null && p.length > 0);

        if (finalOrParts.length === 0) {
            return interaction.reply({ content: '<:Caution:1432028786957746177> Invalid input. Please provide valid terms to generate a regex.', flags: MessageFlags.Ephemeral });
        }

        const finalRegex = finalOrParts.length > 1 ? `(?:${finalOrParts.join('|')})` : finalOrParts[0];
        const { warnings } = validateForFlavour(finalRegex, flavour);
        let finalOutput = finalRegex;
        let codeBlockLanguage = 'regex';

        switch (flavour) {
            case 'pcre': case 'ruby': finalOutput = `/${finalRegex.replace(/\//g, '\\/')}/`; break;
            case 'javascript': codeBlockLanguage = 'javascript'; finalOutput = `/${finalRegex.replace(/\//g, '\\/')}/`; break;
            case 'java': codeBlockLanguage = 'java'; finalOutput = `"${finalRegex.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; break;
            case 'python': codeBlockLanguage = 'python'; finalOutput = `r'${finalRegex.replace(/'/g, "\\'")}'`; break;
            case 'go': codeBlockLanguage = 'go'; finalOutput = `\`${finalRegex.replace(/`/g, '` + "`" + `')}\``; break;
            case 'dotnet': codeBlockLanguage = 'csharp'; finalOutput = `@\"${finalRegex.replace(/"/g, '""')}\"`; break;
            case 'rust': codeBlockLanguage = 'rust';
        }

        if (ephemeral) {
            const warningMessage = warnings.length > 0 ? `\n\n<:Caution:1432028786957746177> **Note:**\n- ${warnings.join('\n- ')}` : '';
            await interaction.reply({
                content: `\`\`\`${codeBlockLanguage}\n${finalOutput}\n\`\`\`` + warningMessage,
                flags: MessageFlags.Ephemeral
            });
            return;
        }
        
        const components: any[] = [];
        const container = new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`### -# <:List:1431983721719922778> </regex:1431976810119172097>\n\`\`\`${codeBlockLanguage}\n${finalOutput}\n\`\`\``)
        );
        components.push(container);

        if (mentionsContent) {
            components.push({ type: 10, content: mentionsContent });
        }

        let warningsButtonRow: ActionRowBuilder<ButtonBuilder> | undefined;
        if (warnings.length > 0) {
            const buttonLabel = warnings.length === 1 ? 'Problem' : `+${warnings.length} Problems`;
            warningsButtonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('show_regex_warnings').setLabel(buttonLabel)
                    .setStyle(ButtonStyle.Danger).setEmoji('1432028786957746177')
            );
            components.push(warningsButtonRow);
        }

        const reply = await interaction.reply({
            components,
            flags: MessageFlags.IsComponentsV2,
            fetchReply: true
        });

        if (warningsButtonRow) {
            const collector = reply.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60_000 });
            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) {
                    await i.reply({ content: `<:Caution:1432028786957746177> You cannot use this button.`, ephemeral: true });
                    return;
                }
                await i.reply({
                    content: `-# <:Caution:1432028786957746177> **Problems Found:**\n- ${warnings.join('\n- ')}`,
                    ephemeral: true
                });
            });

            collector.on('end', () => {
                const buttonLabel = warnings.length === 1 ? 'Problem' : `+${warnings.length} Problems`;
                const disabledButtonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId('show_regex_warnings_disabled').setLabel(buttonLabel)
                        .setStyle(ButtonStyle.Danger).setEmoji('1432028786957746177').setDisabled(true)
                );
                const newComponents: any[] = [container];
                if (mentionsContent) newComponents.push({ type: 10, content: mentionsContent });
                newComponents.push(disabledButtonRow);
                interaction.editReply({ components: newComponents }).catch(() => {});
            });
        }
    }
};