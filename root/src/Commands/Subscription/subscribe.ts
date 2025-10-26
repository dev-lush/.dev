import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  TextChannel,
  NewsChannel,
  MessageFlags,
  InteractionContextType,
  ApplicationIntegrationType,
  ChannelType,
} from 'discord.js';
import { Subscription, SubscriptionType } from '../../Models/Subscription.js';
import { warnMissingPerms } from '../../System Messages/System/permissionNotifier.js';
import { commandGuard } from '../../Utils/commandGuard.js';

/**
 * @description Subscribes a channel to receive updates for a specific category.
 */
export default {
  data: new SlashCommandBuilder()
    .setName('subscribe')
    .setDescription('Subscribe to Discord Status or Discord Previews.')
    .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
    .setContexts([InteractionContextType.Guild])
    .addStringOption(option =>
      option.setName('category')
        .setDescription('The type of updates to subscribe to.')
        .setRequired(true)
        .addChoices(
          { name: 'Discord Status', value: SubscriptionType.STATUS },
          { name: 'Discord Previews', value: SubscriptionType.PREVIEWS }
        )
    )
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('The channel where updates will be sent.')
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    )
    .addBooleanOption(option =>
      option.setName('auto-publish')
        .setDescription('Auto-publish messages if in announcement channel.')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild &
      PermissionFlagsBits.ManageChannels ||
      PermissionFlagsBits.Administrator
    ),

  /**
   * Handles the execution of the /subscribe command.
   * @param interaction The chat input command interaction.
   */
  async execute(interaction: ChatInputCommandInteraction) {
    const passed = await commandGuard(interaction, {
      guildOnly: true,
      requireBotPermissions: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
      requireMemberPermissions: ['ManageGuild', 'ManageChannels'],
    });
    if (!passed) return;

    const category = interaction.options.getString('category', true) as SubscriptionType;
    const channelInput = interaction.options.getChannel('channel');
    const autoPublish = interaction.options.getBoolean('auto-publish') ?? false;

    const targetChannel = channelInput ?? interaction.channel;
    if (!targetChannel || !(targetChannel instanceof TextChannel || targetChannel instanceof NewsChannel)) {
      return interaction.reply({
        content: '<:Cross:1425291759952593066> Must select a valid text or announcement channel.',
        flags: MessageFlags.Ephemeral
      });
    }

    // Check if the bot has necessary permissions in the target channel.
    const me = interaction.guild?.members.me;
    if (!me || !targetChannel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages'])) {
      return interaction.reply({
        content: '<:Cross:1425291759952593066> The app is unable to **view** or **send messages** in that channel.',
        flags: MessageFlags.Ephemeral
      });
    }

    // Warn if auto-publish is enabled but the bot lacks Manage Messages permission.
    if (autoPublish && targetChannel instanceof NewsChannel) {
      const canPublish = targetChannel.permissionsFor(me)?.has('ManageMessages');
      if (!canPublish) {
        await interaction.followUp({
          content: '<:Caution:1432028786957746177> Auto-publish is enabled, but the app lacks the `Manage Messages` permission required to [crosspost](<https://support.discord.com/hc/en-us/articles/360032008192-Announcement-Channel-FAQ#:~:text=Grant%20permissions%20only%20to%20trusted%20members.%20Send%20Messages%20permission%20lets%20members%20publish%20their%20own%20messages,%20Manage%20Messages%20allows%20them%20to%20publish%20any%20message%20in%20the%20channel.%20You%20can%20configure%20these%20settings%20in%20the%20Permissions%20tab.>) in announcement channels.',
          flags: MessageFlags.Ephemeral
        });
      }
    } else if (autoPublish && !(targetChannel instanceof NewsChannel)) {
      return interaction.reply({
        content: '<:Caution:1432028786957746177> Auto-publish is only supported in [announcement channels](<https://support.discord.com/hc/en-us/articles/360032008192-Announcement-Channel-FAQ>).',
        flags: MessageFlags.Ephemeral
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Enforce a subscription limit per guild.
    const subCount = await Subscription.countDocuments({ guildId: interaction.guildId! });
    if (subCount >= 10) {
      return interaction.editReply({
        content: '<:Cross:1425291759952593066> This server has reached the maximum of 10 subscriptions.',
      });
    }

    // Check for duplicate subscriptions.
    const existing = await Subscription.findOne({
      userId: interaction.user.id,
      guildId: interaction.guildId!,
      channelId: targetChannel.id,
      type: category
    });

    if (existing) {
      return interaction.editReply({
        content: `Already subscribed to **${category === SubscriptionType.STATUS ? 'Discord Status' : 'Discord Previews'}** in ${targetChannel}. Use </unsubscribe:1389407822843744412> to remove subscription(s).`,
      });
    }

    const newSub = await Subscription.create({
      userId: interaction.user.id,
      guildId: interaction.guildId!,
      channelId: targetChannel.id,
      type: category,
      autoPublish
    });

    // Perform an initial permission check and warn the user if needed.
    await warnMissingPerms(interaction.client, interaction.guild!, newSub);

    return interaction.editReply({
      content: `<:Checkmark:1425291737550557225> Subscribed to **${category === SubscriptionType.STATUS ? 'Discord Status' : 'Discord Previews'}** in ${targetChannel}.`
    });
  }
};