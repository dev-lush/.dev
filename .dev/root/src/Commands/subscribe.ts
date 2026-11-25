import {
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextChannel,
  NewsChannel,
  type ChatInputCommandInteraction
} from "discord.js";
import {
  Subscription,
  SubscriptionType,
  type SubscriptionDocument
} from "../Models/Subscription.js";
import {
  type CommandModule
} from "../Modules/commandRegistry.js";
import { warnMissingPerms } from "../Utils/permissionNotifier.js";

const categoryChoices = [
  { name: "Discord Status", value: SubscriptionType.DiscordStatus },
  { name: "Cloudflare Status", value: SubscriptionType.CloudflareStatus },
  { name: "GitHub Status", value: SubscriptionType.GitHubStatus },
  { name: "Discord Previews", value: SubscriptionType.DiscordPreviews }
] as const;

/**
 * Guild command module for creating status or preview subscriptions.
 *
 * The execution path validates guild context and effective channel permissions
 * before saving a subscription, and enforces a ten-document guild limit.
 */
const command: CommandModule = {
  category: "guild",
  requiredBotPermissions: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory
  ],
  guard: {
    guildOnly: true,
    requireBotPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory
    ],
    requireMemberPermissions: [
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ManageChannels
    ]
  },
  data: new SlashCommandBuilder()
    .setName("subscribe")
    .setDescription("Subscribe this server to developer service updates")
    .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
    .setContexts([InteractionContextType.Guild])
    .addStringOption((option) =>
      option
        .setName("category")
        .setDescription("The updates to subscribe to")
        .setRequired(true)
        .addChoices(...categoryChoices)
    )
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel that receives updates")
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    )
    .addBooleanOption((option) =>
      option
        .setName("auto-publish")
        .setDescription("Publish updates in announcement channels")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageChannels
    ),

  async execute(interaction) {
    const chatInteraction = interaction as ChatInputCommandInteraction;
    await chatInteraction.deferReply({ flags: MessageFlags.Ephemeral });

    const category = chatInteraction.options.getString("category", true) as SubscriptionType;
    const channelOption = chatInteraction.options.getChannel("channel");
    const autoPublish = chatInteraction.options.getBoolean("auto-publish") ?? false;
    const guild = chatInteraction.guild;
    const targetChannel = channelOption ?? chatInteraction.channel;

    if (!guild || !(targetChannel instanceof TextChannel || targetChannel instanceof NewsChannel)) {
      await chatInteraction.editReply("Select a valid text or announcement channel.");
      return;
    }

    const botMember = guild.members.me;
    const channelPermissions = botMember?.permissionsIn(targetChannel);
    if (!channelPermissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages
    ])) {
      await chatInteraction.editReply(
        "I cannot view or send messages in the selected channel."
      );
      return;
    }

    if (autoPublish && !(targetChannel instanceof NewsChannel)) {
      await chatInteraction.editReply(
        "Auto-publish is only supported in announcement channels."
      );
      return;
    }

    if (autoPublish && targetChannel instanceof NewsChannel &&
        !channelPermissions.has(PermissionFlagsBits.ManageMessages)) {
      await chatInteraction.editReply(
        "I am missing Manage Messages, so this subscription cannot auto-publish."
      );
      return;
    }

    const subscriptionCount = await Subscription.countDocuments({
      guildId: guild.id
    });
    if (subscriptionCount >= 10) {
      await chatInteraction.editReply(
        "This server has reached the maximum of 10 subscriptions."
      );
      return;
    }

    const existingSubscription = await Subscription.findOne({
      guildId: guild.id,
      channelId: targetChannel.id,
      type: category
    }).select("_id");
    if (existingSubscription) {
      await chatInteraction.editReply(
        "This channel is already subscribed to that service."
      );
      return;
    }

    try {
      const subscription = await Subscription.create({
        creatorId: chatInteraction.user.id,
        guildId: guild.id,
        channelId: targetChannel.id,
        type: category,
        autoPublish
      }) as SubscriptionDocument;
      await warnMissingPerms(chatInteraction.client, guild, subscription);
    } catch (error) {
      const isDuplicate =
        error instanceof Error &&
        ("code" in error) &&
        (error as Error & { code?: number }).code === 11000;
      await chatInteraction.editReply(
        isDuplicate
          ? "This channel is already subscribed to that service."
          : "The subscription could not be saved."
      );
      return;
    }

    await chatInteraction.editReply(
      `Subscribed to **${categoryChoices.find((choice) => choice.value === category)?.name}** in ${targetChannel}.`
    );
  }
};

export default command;
