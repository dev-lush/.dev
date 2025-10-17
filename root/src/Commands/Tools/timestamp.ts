import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType,
    ContainerBuilder,
    TextDisplayBuilder
} from 'discord.js';
import { commandGuard } from '../../Utils/commandGuard.js';
import { formatDiscordTimestamps } from '../../Utils/time.js';

/**
 * @file Slash command to generate a Discord timestamp.
 */

const commandBuilder = new SlashCommandBuilder()
    .setName('timestamp')
    .setDescription('Generates a Discord timestamp string from the provided date and time.')
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
    .addStringOption(option =>
        option.setName('format')
            .setDescription('The timestamp format to use.')
            .setRequired(true)
            .addChoices(
                { name: 'Relative', value: 'relative' },
                { name: 'Long Date/Time', value: 'longDate_dayofWeek_shortTime' },
                { name: 'Short Date/Time', value: 'longDate_ShortTime' },
                { name: 'Long Date', value: 'longDate' },
                { name: 'Short Date', value: 'shortDate' },
                { name: 'Long Time', value: 'longTime' },
                { name: 'Short Time', value: 'shortTime' }
            ))
    .addIntegerOption(option => option.setName('year').setDescription('Year (e.g., 2025). Defaults to the current year.'))
    .addIntegerOption(option => option.setName('month').setDescription('Month (1-12). Defaults to the current month.'))
    .addIntegerOption(option => option.setName('date').setDescription('Day of the month (1-31). Defaults to the current date.'))
    .addIntegerOption(option => option.setName('hour').setDescription('Hour in 24-hour format (0-23). Defaults to the current hour.'))
    .addIntegerOption(option => option.setName('minute').setDescription('Minute (0-59). Defaults to the current minute.'))
    .addIntegerOption(option => option.setName('second').setDescription('Second (0-59). Defaults to the current second.'));

export default {
    data: commandBuilder,

    /**
     * Executes the slash command.
     * Validates user-provided date/time parts, generates a Discord timestamp,
     * and replies with it in an ephemeral message.
     * @param interaction The chat input command interaction.
     */
    async execute(interaction: ChatInputCommandInteraction) {
        // Ensure the command can be used in the current context.
        const passed = await commandGuard(interaction, { global: true });
        if (!passed) return;

        const format = interaction.options.getString('format', true) as keyof ReturnType<typeof formatDiscordTimestamps>;

        // Get current date/time as a fallback for any missing options.
        const now = new Date();
        const year = interaction.options.getInteger('year') ?? now.getFullYear();
        const month = interaction.options.getInteger('month') ?? now.getMonth() + 1;
        const date = interaction.options.getInteger('date') ?? now.getDate();
        const hour = interaction.options.getInteger('hour') ?? now.getHours();
        const minute = interaction.options.getInteger('minute') ?? now.getMinutes();
        const second = interaction.options.getInteger('second') ?? now.getSeconds();

        // --- Input Validation ---
        const errors = [];
        if (month < 1 || month > 12) errors.push('`month` must be between 1 and 12.');
        if (hour < 0 || hour > 23) errors.push('`hour` must be between 0 and 23.');
        if (minute < 0 || minute > 59) errors.push('`minute` must be between 0 and 59.');
        if (second < 0 || second > 59) errors.push('`second` must be between 0 and 59.');

        // Validate the date based on the month and year (handles leap years correctly).
        const tempDate = new Date(year, month - 1, 1);
        const daysInMonth = new Date(tempDate.getFullYear(), tempDate.getMonth() + 1, 0).getDate();
        if (date < 1 || date > daysInMonth) {
            errors.push(`\`date\` must be between 1 and ${daysInMonth} for the selected month and year.`);
        }

        // If any validation errors occurred, reply with an error message and stop.
        if (errors.length > 0) {
            let errorContent: string;
            if (errors.length === 1) {
                errorContent = `<:Warning:1395719352560648274> Invalid input: ${errors[0]}`;
            } else {
                errorContent = `<:Warning:1395719352560648274> Invalid input:\n- ${errors.join('\n- ')}`;
            }

            const exampleDate = new Date();
            const examples = formatDiscordTimestamps(exampleDate);
            const exampleContent = [
                `**Relative**: ${examples.relative} - \`${examples.relative}\``,
                `**Long Date/Time**: ${examples.longDate_dayofWeek_shortTime} - \`${examples.longDate_dayofWeek_shortTime}\``,
                `**Short Date/Time**: ${examples.longDate_ShortTime} - \`${examples.longDate_ShortTime}\``,
                `**Long Date**: ${examples.longDate} - \`${examples.longDate}\``,
                `**Short Date**: ${examples.shortDate} - \`${examples.shortDate}\``,
                `**Long Time**: ${examples.longTime} - \`${examples.longTime}\``,
                `**Short Time**: ${examples.shortTime} - \`${examples.shortTime}\``,
            ].join('\n');

            const container = new ContainerBuilder()
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`-# <:Events:1424617114597326878> </timestamp:1422972419206811709>\n${exampleContent}`)
                );

            await interaction.reply({
                content: errorContent,
                components: [container],
                flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
            });
            return;
        }

        // --- Timestamp Generation ---
        // Create the final Date object from the validated parts.
        const finalDate = new Date(year, month - 1, date, hour, minute, second);

        // Generate all timestamp formats.
        const timestamps = formatDiscordTimestamps(finalDate);
        const selectedTimestamp = timestamps[format];

        // Reply with the selected timestamp, showing both the raw string and its rendered output.
        await interaction.reply({
            content: `${selectedTimestamp} - \`${selectedTimestamp}\``,
            flags: MessageFlags.Ephemeral
        });
    }
};