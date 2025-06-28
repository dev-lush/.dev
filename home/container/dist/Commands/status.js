import { SlashCommandBuilder, PermissionFlagsBits, TextChannel, NewsChannel } from 'discord.js';
import { Subscription } from '../Models/Subscription.js';
export default {
    data: new SlashCommandBuilder()
        .setName('status')
        .setDescription('Subscribe or unsubscribe to Discord status incident updates.')
        .addStringOption(option => option.setName('follow')
        .setDescription('Choose to subscribe or unsubscribe.')
        .setRequired(true)
        .addChoices({ name: 'Subscribe', value: 'subscribe' }, { name: 'Unsubscribe', value: 'unsubscribe' }))
        .addChannelOption(option => option.setName('channel')
        .setDescription('The channel to receive updates in (optional).')
        .setRequired(false))
        .addBooleanOption(option => option.setName('auto_publish')
        .setDescription('Auto publish updates if in announcement channel (optional).')
        .setRequired(false)),
    async execute(interaction) {
        const follow = interaction.options.getString('follow', true);
        const channel = interaction.options.getChannel('channel', false);
        const autoPublish = interaction.options.getBoolean('auto_publish') ?? false;
        if (!interaction.memberPermissions?.has([
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageGuild,
            PermissionFlagsBits.Administrator
        ])) {
            return interaction.reply({
                content: 'You need one of the following permissions to use this command: `Manage Channels`, `Manage Server`, or `Administrator`.',
                ephemeral: true
            });
        }
        let sendChannel;
        if (channel) {
            if (!(channel instanceof TextChannel || channel instanceof NewsChannel)) {
                return interaction.reply({ content: 'The selected channel must be a text or news channel.', ephemeral: true });
            }
            sendChannel = channel;
        }
        else if (interaction.channel instanceof TextChannel || interaction.channel instanceof NewsChannel) {
            sendChannel = interaction.channel;
        }
        else {
            return interaction.reply({ content: 'Could not determine a valid text or news channel.', ephemeral: true });
        }
        try {
            if (follow === 'subscribe') {
                await interaction.deferReply({ ephemeral: true });
                const existing = await Subscription.findOne({ userId: interaction.user.id, channelId: sendChannel.id, type: 'status' });
                if (existing) {
                    return interaction.editReply({ content: `You are already subscribed to Discord Status updates in ${sendChannel}.` });
                }
                await Subscription.create({ userId: interaction.user.id, channelId: sendChannel.id, type: 'status', autoPublish });
                await interaction.editReply({ content: `Successfully subscribed to Discord Status updates in ${sendChannel}.` });
            }
            else if (follow === 'unsubscribe') {
                const targetChannelId = sendChannel.id;
                const existing = await Subscription.findOneAndDelete({
                    userId: interaction.user.id,
                    channelId: targetChannelId,
                    type: 'status'
                });
                if (existing) {
                    return interaction.reply({ content: `Successfully unsubscribed from Discord Status updates in ${sendChannel}.`, ephemeral: true });
                }
                else {
                    return interaction.reply({ content: 'You are not subscribed to this channel.', ephemeral: true });
                }
            }
            else {
                return interaction.reply({ content: 'Invalid follow option.', ephemeral: true });
            }
        }
        catch (error) {
            console.error('Database error in status.ts:', error);
            return interaction.reply({ content: 'An error occurred while processing your request.', ephemeral: true });
        }
    }
};
