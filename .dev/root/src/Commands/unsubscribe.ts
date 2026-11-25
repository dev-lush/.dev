import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction
} from "discord.js";
import {
  Subscription,
  SubscriptionType
} from "../Models/Subscription.js";
import {
  getCommandMention,
  type CommandModule
} from "../Modules/commandRegistry.js";
import { RoleMention } from "../Models/RoleMention.js";

const names: Record<SubscriptionType, string> = {
  [SubscriptionType.DiscordStatus]: "Discord Status",
  [SubscriptionType.CloudflareStatus]: "Cloudflare Status",
  [SubscriptionType.GitHubStatus]: "GitHub Status",
  [SubscriptionType.DiscordPreviews]: "Discord Previews"
};

/**
 * Guild command module for removing subscriptions and their role mappings.
 *
 * Subscription IDs are shown through autocomplete and are restricted to the
 * current guild by the execution guard.
 */
const command: CommandModule = {
  category: "guild",
  requiredBotPermissions: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages
  ],
  guard: {
    guildOnly: true,
    requireMemberPermissions: [
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ManageChannels
    ]
  },
  data: new SlashCommandBuilder()
    .setName("unsubscribe")
    .setDescription("Remove a status or preview subscription")
    .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
    .setContexts([InteractionContextType.Guild])
    .addStringOption((option) =>
      option
        .setName("subscription")
        .setDescription("Subscription to remove")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageChannels
    ),

  async autocomplete(interaction) {
    const autocomplete = interaction as AutocompleteInteraction;
    if (!autocomplete.guild) {
      await autocomplete.respond([]);
      return;
    }

    const subscriptions = await Subscription.find({
      guildId: autocomplete.guild.id
    }).sort({ createdAt: -1 }).limit(25);

    const choices = [];
    for (const subscription of subscriptions) {
      const channel = autocomplete.guild.channels.cache.get(subscription.channelId);
      const date = subscription.createdAt
        ? subscription.createdAt.toISOString().slice(0, 10)
        : "Unknown date";
      choices.push({
        name: `#${channel?.isTextBased() && "name" in channel ? channel.name : "unknown"}: ${names[subscription.type as SubscriptionType]} | ${date}`.slice(0, 100),
        value: subscription._id.toString()
      });
    }

    await autocomplete.respond(choices);
  },

  async execute(interaction) {
    const chatInteraction = interaction as ChatInputCommandInteraction;
    const subscriptionId = chatInteraction.options.getString("subscription", true);
    const subscription = await Subscription.findById(subscriptionId);

    if (!subscription || subscription.guildId !== chatInteraction.guildId) {
      const subscribeMention = getCommandMention("subscribe", undefined, chatInteraction.guildId ?? undefined);
      await chatInteraction.reply({
        content: `Subscription not found. ${subscribeMention ? `Use ${subscribeMention} to create one.` : "Use /subscribe to create one."}`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await Promise.all([
      RoleMention.deleteMany({
        guildId: subscription.guildId,
        subscriptionId: subscription._id
      }),
      Subscription.findByIdAndDelete(subscriptionId)
    ]);
    await chatInteraction.reply({
      content: `Unsubscribed from **${names[subscription.type as SubscriptionType]}** in <#${subscription.channelId}>.`,
      flags: MessageFlags.Ephemeral
    });
  }
};

export default command;
