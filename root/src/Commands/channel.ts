import { ChatInputCommandInteraction, ChannelType, TextChannel, NewsChannel, VoiceChannel, StageChannel, ForumChannel, CategoryChannel, PublicThreadChannel, PrivateThreadChannel, type GuildChannelTypes, ThreadChannel } from 'discord.js';
import { SlashCommandBuilder as _SlashCommandBuilder } from '@discordjs/builders';

// re-alias so TS doesn’t think we accidentally imported the wrong one
const SlashCommandBuilder = _SlashCommandBuilder;

export const data = new SlashCommandBuilder()
  .setName('channel')
  .setDescription('Manage channels')
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Create a new channel')
      .addStringOption((opt) =>
        opt
          .setName('type')
          .setDescription('The type of channel to create')
          .setRequired(true)
          .addChoices(
            { name: 'Text Channel',        value: String(ChannelType.GuildText)        },
            { name: 'Announcement Channel', value: String(ChannelType.GuildAnnouncement) },
            { name: 'Forum Channel',        value: String(ChannelType.GuildForum)       },
            { name: 'Media Channel',        value: String(ChannelType.GuildMedia)       },
            { name: 'Voice Channel',        value: String(ChannelType.GuildVoice)       },
            { name: 'Stage Channel',        value: String(ChannelType.GuildStageVoice)  }
          )
      )
      .addStringOption((opt) =>
        opt.setName('name').setDescription('The name of the channel').setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('description')
          .setDescription('The description/topic of the channel (optional)')
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('edit')
      .setDescription('Edit an existing channel')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('The channel to edit')
          .setRequired(true)
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.GuildForum,
            ChannelType.GuildMedia,
            ChannelType.GuildVoice,
            ChannelType.GuildStageVoice,
            ChannelType.GuildCategory
          )
      )
      .addStringOption((opt) =>
        opt.setName('name').setDescription('The new name for the channel (optional)')
      )
      .addStringOption((opt) =>
        opt.setName('description').setDescription('The new description/topic (optional)')
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    return interaction.reply({ content: 'Must be run in a guild.', ephemeral: true });
  }

  const sub = interaction.options.getSubcommand();
  if (sub === 'create') {
    const type = Number(interaction.options.getString('type', true)) as GuildChannelTypes;
    const name = interaction.options.getString('name', true);
    const topic = interaction.options.getString('description') ?? undefined;

    try {
      const channel = await interaction.guild.channels.create({ name, type, topic });
      return interaction.reply({ content: `✅ Created ${channel}`, ephemeral: true });
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: '❌ Failed to create channel.', ephemeral: true });
    }
  }

  // EDIT
  const channel = interaction.options.getChannel('channel', true) as
    | TextChannel
    | NewsChannel
    | VoiceChannel
    | StageChannel
    | ForumChannel
    | CategoryChannel
    | PublicThreadChannel
    | PrivateThreadChannel
    | ThreadChannel;

  const newName = interaction.options.getString('name');
  const newTopic = interaction.options.getString('description');

  if (!newName && !newTopic) {
    return interaction.reply({
      content: `❗ No changes provided for ${channel}.`,
      ephemeral: true,
    });
  }

  try {
    if (channel.isThread()) {
      // threads only support renaming
      await channel.setName(newName ?? channel.name);
    } else if ('topic' in channel) {
      // text & news channels support topics
      await channel.edit({
        name: newName ?? channel.name,
        topic: newTopic ?? channel.topic,
      });
    } else {
      // voice, stage, forum, category
      await channel.edit({ name: newName ?? channel.name });
    }

    return interaction.reply({
      content: `✅ Updated ${channel}.`,
      ephemeral: true,
    });
  } catch (err) {
    console.error(err);
    return interaction.reply({
      content: `❌ Failed to update: ${String(err)}`,
      ephemeral: true,
    });
  }
}