import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits, TextChannel, NewsChannel, GuildTextBasedChannel } from 'discord.js';
import { Subscription } from '../Models/Subscription.js';
import { checkNewCommitComments } from '../Utils/commitMessage.js';

export default {
  data: new SlashCommandBuilder()
    .setName('previews')
    .setDescription('Subscribe or unsubscribe to Discord-Datamining GitHub commit comment updates.')
    .addStringOption(option =>
      option.setName('follow')
        .setDescription('Choose to subscribe or unsubscribe to commit comment updates.')
        .setRequired(true)
        .addChoices(
          { name: 'Subscribe', value: 'subscribe' },
          { name: 'Unsubscribe', value: 'unsubscribe' }
        )
    )
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Specify the target channel (optional).')
        .setRequired(false)
    )
    .addBooleanOption(option =>
      option.setName('auto_publish')
        .setDescription('Auto-publish if in announcement channel.')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageGuild | PermissionFlagsBits.Administrator),

  async execute(interaction: ChatInputCommandInteraction) {
    const follow = interaction.options.getString('follow', true);
    const channelOption = interaction.options.getChannel('channel');
    const autoPublish = interaction.options.getBoolean('auto_publish') ?? false;

    const targetChannel = channelOption ?? interaction.channel;
    if (!targetChannel || !(targetChannel instanceof TextChannel || targetChannel instanceof NewsChannel)) {
      return interaction.reply({ content: 'You must select a valid text or announcement channel.', ephemeral: true });
    }

    try {
      if (follow === 'subscribe') {
        await interaction.deferReply({ ephemeral: true });
        await Subscription.create({
          userId: interaction.user.id,
          channelId: targetChannel.id,
          type: 'commit',
          autoPublish,
        });
        await interaction.editReply({ content: `✅ Subscribed to GitHub commit comment updates in ${targetChannel}` });
      } else if (follow === 'unsubscribe') {
        const result = await Subscription.findOneAndDelete({
          userId: interaction.user.id,
          channelId: targetChannel.id,
          type: 'commit'
        });
        const reply = result
          ? `❌ Unsubscribed from GitHub commit comment updates in ${targetChannel}`
          : '⚠️ You are not subscribed in this channel.';
        await interaction.reply({ content: reply, ephemeral: true });
      } else {
        await interaction.reply({ content: 'Invalid follow option.', ephemeral: true });
      }
    } catch (err) {
      console.error('Database error in /previews:', err);
      await interaction.reply({ content: 'An error occurred processing your request.', ephemeral: true });
    }
  },

  checkNewCommits: checkNewCommitComments
};