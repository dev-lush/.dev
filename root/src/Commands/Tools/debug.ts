import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags, EmbedBuilder } from 'discord.js';
import { commandGuard } from '../../Utils/commandGuard.js';
import { CommitCommentCheckpoint, setCheckpoint, ICommitCommentCheckpoint, Subscription, ISubscription } from '../../Models/Subscription.js';
import { GitHubToken } from '../../Models/GitHubToken.js';

/**
 * @file Owner-only commands for debugging the bot's internal state.
 */
export default {
    data: new SlashCommandBuilder()
        .setName('debug')
        .setDescription('Commands for debugging the bot.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('checkpoint')
                .setDescription('View or set the commit comment checkpoint.')
                .addStringOption(option =>
                    option.setName('action')
                        .setDescription('The action to perform.')
                        .setRequired(true)
                        .addChoices(
                            { name: 'View', value: 'view' },
                            { name: 'Set', value: 'set' }
                        ))
                .addIntegerOption(option =>
                    option.setName('id')
                        .setDescription('The comment ID to set the checkpoint to. Required for "Set" action.')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('subscription')
                .setDescription('View a specific subscription\'s state.')
                .addStringOption(option =>
                    option.setName('id')
                        .setDescription('The ID of the subscription to inspect.')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('github')
                .setDescription('View the status of GitHub API tokens.')
        ),
    /**
     * Handles the execution of the /debug command.
     * @param interaction The chat input command interaction.
     */
    async execute(interaction: ChatInputCommandInteraction) {
        const passed = await commandGuard(interaction, { ownerOnly: true });
        if (!passed) return;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const subcommand = interaction.options.getSubcommand();

        // Handle the 'checkpoint' subcommand
        if (subcommand === 'checkpoint') {
            const action = interaction.options.getString('action', true);
            const id = interaction.options.getInteger('id');

            if (action === 'view') {
                const checkpoint = await CommitCommentCheckpoint.findById('global').lean<ICommitCommentCheckpoint>();
                if (!checkpoint) {
                    await interaction.editReply('No checkpoint document found in the database.');
                } else {
                    await interaction.editReply(`Current global checkpoint is set to comment ID: \`${checkpoint.lastProcessedCommentId}\``);
                }
            } else if (action === 'set') {
                if (!id || id <= 0) {
                    await interaction.editReply('You must provide a valid positive integer ID to set the checkpoint.');
                    return;
                }
                try {
                    await setCheckpoint(id);
                    await interaction.editReply(`<:Checkmark:1425291737550557225> Successfully set the global checkpoint to comment ID: \`${id}\`. The next poll will look for comments after this ID.`);
                } catch (error) {
                    console.error('Failed to set checkpoint via command:', error);
                    await interaction.editReply('An error occurred while trying to set the checkpoint. Check the console for details.');
                }
            }
        // Handle the 'subscription' subcommand
        } else if (subcommand === 'subscription') {
            const subId = interaction.options.getString('id', true);
            try {
                const sub = await Subscription.findById(subId).lean<ISubscription>();
                if (!sub) {
                    return interaction.editReply('Subscription not found.');
                }
                const embed = new EmbedBuilder()
                    .setTitle(`Subscription Details`)
                    .setDescription(`\`${sub._id}\``)
                    .setColor(0x5865F2)
                    .addFields(
                        { name: 'Type', value: sub.type, inline: true },
                        { name: 'Guild ID', value: `\`${sub.guildId}\``, inline: true },
                        { name: 'Channel ID', value: `<#${sub.channelId}> (\`${sub.channelId}\`)`, inline: false },
                        { name: 'User ID', value: `<@${sub.userId}> (\`${sub.userId}\`)`, inline: false },
                        { name: 'Auto-Publish', value: sub.autoPublish ? '✅ Yes' : '❌ No', inline: true },
                        { name: 'Created At', value: `<t:${Math.floor(new Date(sub.createdAt).getTime() / 1000)}:F>`, inline: false },
                        { name: 'Last Permission Warning', value: sub.lastPermissionWarningAt ? `<t:${Math.floor(new Date(sub.lastPermissionWarningAt).getTime() / 1000)}:R>` : 'Never', inline: false },
                    );
                
                if (sub.type === 'status' && sub.incidents.length > 0) {
                    embed.addFields({ name: 'Tracked Incidents', value: `\`${sub.incidents.length}\``, inline: true });
                } else if (sub.type === 'previews') {
                    embed.addFields({ name: 'Last Comment ID', value: `\`${sub.lastCommentId || 'None'}\``, inline: true });
                }

                await interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error('Failed to fetch subscription:', error);
                await interaction.editReply('An error occurred while fetching the subscription. Make sure you provided a valid ID.');
            }
        // Handle the 'github' subcommand
        } else if (subcommand === 'github') {
            try {
                const tokens = await GitHubToken.find().lean();
                if (tokens.length === 0) {
                    return interaction.editReply('No GitHub tokens are configured.');
                }

                const embed = new EmbedBuilder()
                    .setTitle('GitHub Token Status')
                    .setColor(0x24292E)
                    .setTimestamp();

                tokens.forEach((token, index) => {
                    const tokenIdentifier = `Token ${index + 1} (...${token.token.slice(-4)})`;
                    const resetDate = new Date(token.rateLimitReset);
                    const status = token.isActive ? '✅ Active' : '❌ Inactive';
                    const value = `**Status**: ${status}\n**Remaining**: ${token.rateLimitRemaining}\n**Resets**: <t:${Math.floor(resetDate.getTime() / 1000)}:R>\n**Usage Count**: ${token.usageCount}`;
                    embed.addFields({ name: tokenIdentifier, value, inline: true });
                });

                await interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error('Failed to fetch GitHub tokens:', error);
                await interaction.editReply('An error occurred while fetching GitHub token statuses.');
            }
        }
    }
};