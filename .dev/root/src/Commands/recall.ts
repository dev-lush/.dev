import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
  NewsChannel,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextChannel,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction
} from "discord.js";
import { Subscription, SubscriptionType, type SubscriptionDocument } from "../Models/Subscription.js";
import {
  fetchStatusIncidents,
  fetchStatusIncident,
  getStatusMentionPings,
  type StatusProvider
} from "../Modules/statusService.js";
import { STATUS_SERVICES, buildStatusPayload } from "../Internals/Messages/statusMessage.js";
import { buildPreviewPayload, type GitHubCommitComment } from "../Internals/Messages/previewMessage.js";
import { fetchAsGitHubApp } from "../Utils/githubApp.js";
import { type CommandModule } from "../Modules/commandRegistry.js";
import { crosspostOnce } from "../Utils/crosspost.js";

/**
 * Builds guild subscription autocomplete entries using channel, service,
 * and creation-date formatting shared by status and preview recalls.
 *
 * @param interaction Autocomplete interaction.
 * @param type Subscription service category.
 * @returns Up to 25 Discord-compatible autocomplete choices.
 */
async function subscriptionChoices(
  interaction: AutocompleteInteraction,
  type: SubscriptionType
) {
  if (!interaction.guildId) return [];
  const subscriptions = await Subscription.find({
    guildId: interaction.guildId,
    type
  }).sort({ createdAt: -1 }).limit(25);

  const names: Record<SubscriptionType, string> = {
    [SubscriptionType.DiscordStatus]: "Discord Status",
    [SubscriptionType.CloudflareStatus]: "Cloudflare Status",
    [SubscriptionType.GitHubStatus]: "GitHub Status",
    [SubscriptionType.DiscordPreviews]: "Discord Previews"
  };

  return subscriptions.map((subscription) => {
    const channel = interaction.guild?.channels.cache.get(subscription.channelId);
    const name = channel?.isTextBased() && "name" in channel
      ? `#${channel.name}`
      : "Unknown channel";
    const date = subscription.createdAt
      ? subscription.createdAt.toISOString().slice(0, 10)
      : "Unknown date";
    return {
      name: `${name}: ${names[type]} | ${date}`.slice(0, 100),
      value: subscription._id.toString()
    };
  });
}

/**
 * Guild-owner `/recall` command. Recall deliveries update subscription
 * tracking so later webhook or manual updates can edit the correct message.
 */
const command: CommandModule = {
  category: "guild",
  guard: {
    guildOnly: true,
    ownerOnly: true,
    requireMemberPermissions: [PermissionFlagsBits.ManageGuild]
  },
  data: new SlashCommandBuilder()
    .setName("recall")
    .setDescription("Recall and track a status incident or preview comment")
    .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
    .setContexts([InteractionContextType.Guild])
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Recall a status incident")
        .addStringOption((option) =>
          option
            .setName("provider")
            .setDescription("Status provider")
            .setRequired(true)
            .addChoices(
              { name: "Discord Status", value: "discord" },
              { name: "GitHub Status", value: "github" },
              { name: "Cloudflare Status", value: "cloudflare" }
            ))
        .addStringOption((option) =>
          option
            .setName("incident")
            .setDescription("Incident or maintenance")
            .setRequired(true)
            .setAutocomplete(true))
        .addStringOption((option) =>
          option
            .setName("subscription")
            .setDescription("Subscription to use")
            .setRequired(true)
            .setAutocomplete(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("previews")
        .setDescription("Recall a commit comment")
        .addStringOption((option) =>
          option
            .setName("comment")
            .setDescription("Commit comment")
            .setRequired(true)
            .setAutocomplete(true))
        .addStringOption((option) =>
          option
            .setName("subscription")
            .setDescription("Subscription to use")
            .setRequired(true)
            .setAutocomplete(true))
    ),

  async autocomplete(interaction: AutocompleteInteraction) {
    const subcommand = interaction.options.getSubcommand();
    const focused = interaction.options.getFocused(true);

    if (focused.name === "subscription") {
      const type = subcommand === "status"
        ? (() => {
            const provider = interaction.options.getString("provider") as StatusProvider | null;
            return provider ? STATUS_SERVICES[provider].subscriptionType : SubscriptionType.DiscordStatus;
          })()
        : SubscriptionType.DiscordPreviews;
      await interaction.respond(await subscriptionChoices(interaction, type));
      return;
    }

    if (subcommand === "status" && focused.name === "incident") {
      const provider = interaction.options.getString("provider") as StatusProvider | null;
      if (!provider) return interaction.respond([]);
      const incidents = await fetchStatusIncidents(provider, 25);
      await interaction.respond(
        incidents
          .filter((incident) =>
            incident.name.toLowerCase().includes(focused.value.toLowerCase()) ||
            incident.id.includes(focused.value)
          )
          .slice(0, 25)
          .map((incident) => ({
            name: `${incident.status === "resolved" ? "" : "[Warning] "}[${incident.id.slice(0, 6)}] - ${incident.name}`.slice(0, 100),
            value: incident.id
          }))
      );
      return;
    }

    if (subcommand === "previews" && focused.name === "comment") {
      const configured = process.env.GITHUB_REPOSITORY?.trim();
      if (!configured) return interaction.respond([]);
      const [owner, repo] = configured.split("/");
      const response = await fetchAsGitHubApp(
        `https://api.github.com/repos/${owner}/${repo}/events?per_page=100`,
        {},
        { owner, repo }
      );
      if (!response.ok) return interaction.respond([]);
      const events = await response.json() as Array<{
        type: string;
        payload?: { comment?: GitHubCommitComment };
      }>;
      await interaction.respond(
        events
          .filter((event) => event.type === "CommitCommentEvent" && event.payload?.comment)
          .map((event) => event.payload!.comment!)
          .filter((comment) =>
            comment.id.toString().includes(focused.value) ||
            comment.body.toLowerCase().includes(focused.value.toLowerCase())
          )
          .slice(0, 25)
          .map((comment) => ({
            name: `[${comment.commit_id.slice(0, 7)}] @${comment.user.login}: ${comment.body.slice(0, 48).replace(/\r?\n/g, " ")}`.slice(0, 100),
            value: comment.id.toString()
          }))
      );
    }
  },

  async execute(interaction) {
    const chatInteraction = interaction as ChatInputCommandInteraction;
    await chatInteraction.deferReply({ flags: MessageFlags.Ephemeral });
    const subcommand = chatInteraction.options.getSubcommand();
    const subscriptionId = chatInteraction.options.getString("subscription", true);
    const subscription = await Subscription.findById(subscriptionId) as SubscriptionDocument | null;

    if (!subscription || subscription.guildId !== chatInteraction.guildId) {
      await chatInteraction.editReply("Subscription not found.");
      return;
    }

    const channel = await chatInteraction.client.channels.fetch(subscription.channelId).catch(() => null);
    if (!(channel instanceof TextChannel || channel instanceof NewsChannel)) {
      await chatInteraction.editReply("The subscribed channel is unavailable.");
      return;
    }

    if (subcommand === "status") {
      const provider = chatInteraction.options.getString("provider", true) as StatusProvider;
      const incidentId = chatInteraction.options.getString("incident", true);
      const incident = await fetchStatusIncident(provider, incidentId);
      if (!incident) {
        await chatInteraction.editReply("Incident not found.");
        return;
      }
      const mention = await getStatusMentionPings(subscription, incident);
      const payload = buildStatusPayload(
        STATUS_SERVICES[provider],
        incident,
        mention
      );
      const sent = await channel.send(payload);
      if (subscription.autoPublish && channel instanceof NewsChannel) {
        await crosspostOnce(sent, channel);
      }
      const resolved =
        incident.status.toLowerCase() === "resolved" ||
        incident.status.toLowerCase() === "completed";
      subscription.trackedIncidents = resolved
        ? subscription.trackedIncidents.filter((item) => item.incidentId !== incident.id)
        : [
            ...subscription.trackedIncidents.filter((item) => item.incidentId !== incident.id),
            {
          incidentId: incident.id,
          messageId: sent.id,
          lastUpdateId: incident.updates.at(-1)?.id ?? null,
          lastUpdatedAt: new Date(incident.updatedAt)
            }
          ];
      await subscription.save();
      await chatInteraction.editReply("Recalled incident and added it to subscription tracking.");
      return;
    }

    const configured = process.env.GITHUB_REPOSITORY?.trim();
    if (!configured) {
      await chatInteraction.editReply("GitHub Previews is not configured.");
      return;
    }
    const [owner, repo] = configured.split("/");
    const commentId = chatInteraction.options.getString("comment", true);
    const response = await fetchAsGitHubApp(
      `https://api.github.com/repos/${owner}/${repo}/comments/${commentId}`,
      {},
      { owner, repo }
    );
    if (!response.ok) {
      await chatInteraction.editReply("Commit comment not found.");
      return;
    }
    const comment = await response.json() as GitHubCommitComment;
    const payload = await buildPreviewPayload(
      subscription,
      comment,
      owner,
      repo
    );
    const sent = await channel.send(payload);
    if (subscription.autoPublish && channel instanceof NewsChannel) {
      await crosspostOnce(sent, channel);
    }
    subscription.lastPreviewCommentId = Math.max(
      subscription.lastPreviewCommentId,
      comment.id
    );
    await subscription.save();
    await chatInteraction.editReply("Recalled commit comment.");
  }
};

export default command;
