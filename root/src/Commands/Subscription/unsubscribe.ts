import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  AutocompleteInteraction,
  PermissionFlagsBits,
  CacheType,
  MessageFlags,
  InteractionContextType,
  ApplicationIntegrationType
} from 'discord.js';
import { Subscription, SubscriptionType } from '../../Models/Subscription.js';
import { RoleMentionsHandler } from '../../Models/RoleMentionsHandler.js';
import { format } from 'date-fns';
import { commandGuard } from '../../Utils/commandGuard.js';

export default {
  data: new SlashCommandBuilder()
    .setName('unsubscribe')
    .setDescription('Unsubscribe from updates in a specific channel.')
    .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
    .setContexts([InteractionContextType.Guild])
    .addStringOption(opt =>
      opt.setName('subscription')
        .setDescription('Subscription to unsubscribe from.')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild &
      PermissionFlagsBits.ManageChannels ||
      PermissionFlagsBits.Administrator
    ),

  /**
   * Handles autocomplete for the 'subscription' option, showing a user's active subscriptions.
   * @param interaction The autocomplete interaction.
   */
  async autocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'subscription') return;

    const subs = await Subscription.find({ guildId: interaction.guildId });

    const choices = await Promise.all(subs.map(async sub => {
      const guild = interaction.guild!;
      const channel = guild.channels.cache.get(sub.channelId)
        ?? await guild.channels.fetch(sub.channelId).catch(() => null);
      const user = await interaction.client.users.fetch(sub.userId).catch(() => null);

      const category = sub.type === SubscriptionType.STATUS ? 'Discord Status' : 'Discord Previews';
      const channelName = channel?.isTextBased() ? `#${channel.name}` : 'Unknown Channel';
      const username = user?.username ?? 'Unknown User';
      const date = sub.createdAt
        ? format(sub.createdAt, 'd MMMM yyyy')
        : 'Unknown Date';

      return {
        name: `${channelName}: ${category} | ${username} | ${date}`,
        value: sub._id.toString()
      };
    }));

    await interaction.respond(choices.slice(0, 25));
  },

  /**
   * Executes the /unsubscribe command.
   * @param interaction The chat input command interaction.
   */
  async execute(interaction: ChatInputCommandInteraction<CacheType>) {
    const passed = await commandGuard(interaction, {
      guildOnly: true,
      requireMemberPermissions: ['ManageGuild', 'ManageChannels']
    });
    if (!passed) return;

    const subId = interaction.options.getString('subscription', true);
    const sub = await Subscription.findById(subId);
    if (!sub) {
      return interaction.reply({ content: '<:Cross:1425291759952593066> Subscription not found. If you haven\'t made a subscription, run the </subscribe:1389407822843744411> command.', flags: MessageFlags.Ephemeral });
    }

    await RoleMentionsHandler.deleteMany({
      guildId: sub.guildId,
      type: sub.type,
      value: { $regex: `^${sub._id.toString()}:` }
    });

    await Subscription.findByIdAndDelete(subId);

    const categoryName = sub.type === SubscriptionType.STATUS ? 'Discord Status' : 'Discord Previews';

    return interaction.reply({
      content: `<:Checkmark:1425291737550557225> Successfully unsubscribed from **${categoryName}** in <#${sub.channelId}>.`,
      flags: MessageFlags.Ephemeral
    });
  }
};