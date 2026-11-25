import {
  ApplicationIntegrationType,
  GuildMember,
  Role,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction
} from "discord.js";
import {
  fetchStatusIncidents,
  fetchStatusIncident,
  type StatusProvider
} from "../Modules/statusService.js";
import {
  STATUS_SERVICES,
  buildStatusPayload
} from "../Internals/Messages/statusMessage.js";
import {
  buildPreviewPayload,
  type GitHubCommitComment
} from "../Internals/Messages/previewMessage.js";
import { fetchAsGitHubApp } from "../Utils/githubApp.js";
import { commandGuard, type CommandModule } from "../Modules/commandRegistry.js";

const PROVIDERS: StatusProvider[] = ["discord", "github", "cloudflare"];

/**
 * Checks whether the current member can use external apps and send in the
 * interaction channel. DM and other out-of-guild interactions are public
 * unless an explicit ephemeral choice is selected.
 */
async function canSendPublicly(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (!interaction.inGuild()) return true;
  if (!interaction.guild || !interaction.channel || !("guild" in interaction.channel)) return false;
  const member = interaction.member instanceof GuildMember
    ? interaction.member
    : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return false;
  return member.permissionsIn(interaction.channel).has([
    PermissionFlagsBits.UseExternalApps,
    PermissionFlagsBits.SendMessages
  ]);
}

/**
 * Gets a mentionable user or role only when public delivery is selected.
 *
 * @param interaction Chat-input interaction containing the optional mention.
 * @returns A Discord mention string or undefined for ephemeral responses.
 */
function getMention(interaction: ChatInputCommandInteraction): string | undefined {
  if (interaction.options.getBoolean("ephemeral") !== false) return undefined;
  const mentionable = interaction.options.getMentionable("mention");
  if (!mentionable || !("id" in mentionable)) return undefined;
  if (!interaction.inGuild() && mentionable instanceof Role) return undefined;
  return mentionable instanceof Role
    ? `<@&${mentionable.id}>`
    : `<@${mentionable.id}>`;
}

/**
 * Fetches one commit comment through the GitHub App installation credentials.
 *
 * @param commentId Numeric GitHub commit-comment ID.
 * @param owner Repository owner.
 * @param repo Repository name.
 * @returns The comment payload or null when GitHub does not return it.
 */
async function fetchPreviewComment(
  commentId: string,
  owner: string,
  repo: string
): Promise<GitHubCommitComment | null> {
  const response = await fetchAsGitHubApp(
    `https://api.github.com/repos/${owner}/${repo}/comments/${commentId}`,
    { headers: { Accept: "application/vnd.github+json" } },
    { owner, repo }
  );
  if (!response.ok) return null;
  return response.json() as Promise<GitHubCommitComment>;
}

/**
 * Universal `/send` command for static status or commit-comment payloads.
 * It never reads or updates a subscription and is safe to use from DMs.
 */
const command: CommandModule = {
  category: "guild",
  guard: {
    guildOnly: false
  },
  data: new SlashCommandBuilder()
    .setName("send")
    .setDescription("Send a status incident or GitHub Preview without a subscription")
    .setIntegrationTypes(
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall
    )
    .setContexts(
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Send a status incident")
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
        .addMentionableOption((option) =>
          option
            .setName("mention")
            .setDescription("User or role to mention")
            .setRequired(false))
        .addBooleanOption((option) =>
          option
            .setName("ephemeral")
            .setDescription("Send only to you")
            .setRequired(false))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("previews")
        .setDescription("Send a Discord Previews commit comment")
        .addStringOption((option) =>
          option
            .setName("comment")
            .setDescription("Commit comment ID")
            .setRequired(true)
            .setAutocomplete(true))
        .addMentionableOption((option) =>
          option
            .setName("mention")
            .setDescription("User or role to mention")
            .setRequired(false))
        .addBooleanOption((option) =>
          option
            .setName("ephemeral")
            .setDescription("Send only to you")
            .setRequired(false))
    ),

  async autocomplete(interaction: AutocompleteInteraction) {
    const subcommand = interaction.options.getSubcommand();
    const focused = interaction.options.getFocused(true);

    if (subcommand === "status" && focused.name === "incident") {
      const provider = interaction.options.getString("provider") as StatusProvider | null;
      if (!provider || !PROVIDERS.includes(provider)) {
        await interaction.respond([]);
        return;
      }
      const incidents = await fetchStatusIncidents(provider, 25);
      await interaction.respond(
        incidents
          .filter((incident) =>
            incident.name.toLowerCase().includes(focused.value.toLowerCase()) ||
            incident.id.includes(focused.value)
          )
          .slice(0, 25)
          .map((incident) => {
            const unresolved = incident.status !== "resolved" ? "[Warning] " : "";
            const impact = incident.impact !== "none" ? ` - ${incident.impact}` : "";
            return {
              name: `${unresolved}[${incident.id.slice(0, 6)}]${impact} | ${incident.name}`.slice(0, 100),
              value: incident.id
            };
          })
      );
      return;
    }

    if (subcommand === "previews" && focused.name === "comment") {
      const configured = process.env.GITHUB_REPOSITORY?.trim();
      if (!configured) {
        await interaction.respond([]);
        return;
      }
      const [owner, repo] = configured.split("/");
      try {
        const response = await fetchAsGitHubApp(
          `https://api.github.com/repos/${owner}/${repo}/events?per_page=100`,
          {},
          { owner, repo }
        );
        if (!response.ok) {
          await interaction.respond([]);
          return;
        }
        const events = await response.json() as Array<{
          type: string;
          payload?: { comment?: GitHubCommitComment };
        }>;
        const choices = events
          .filter((event) => event.type === "CommitCommentEvent" && event.payload?.comment)
          .map((event) => event.payload!.comment!)
          .filter((comment) =>
            comment.id.toString().includes(focused.value) ||
            comment.body.toLowerCase().includes(focused.value.toLowerCase()) ||
            comment.commit_id.toLowerCase().includes(focused.value.toLowerCase())
          )
          .slice(0, 25)
          .map((comment) => ({
            name: `[${comment.commit_id.slice(0, 7)}] @${comment.user.login}: ${comment.body.slice(0, 48).replace(/\r?\n/g, " ")}`.slice(0, 100),
            value: comment.id.toString()
          }));
        await interaction.respond(choices);
      } catch (error) {
        console.error("[send autocomplete] GitHub lookup failed", error);
        await interaction.respond([]);
      }
    }
  },

  async execute(interaction) {
    const chatInteraction = interaction as ChatInputCommandInteraction;
    const passed = await commandGuard(chatInteraction, { guildOnly: false });
    if (!passed) return;

    const requestedEphemeral = chatInteraction.options.getBoolean("ephemeral");
    let ephemeral = requestedEphemeral === null
      ? true
      : requestedEphemeral;
    if (chatInteraction.inGuild() && !(await canSendPublicly(chatInteraction))) {
      ephemeral = true;
    }
    await chatInteraction.deferReply({
      flags: ephemeral
        ? MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
        : MessageFlags.IsComponentsV2
    });

    const subcommand = chatInteraction.options.getSubcommand();
    try {
      if (subcommand === "status") {
        const provider = chatInteraction.options.getString("provider", true) as StatusProvider;
        const incidentId = chatInteraction.options.getString("incident", true);
        const incident = await fetchStatusIncident(provider, incidentId);
        if (!incident) {
          await chatInteraction.editReply("Incident not found.");
          return;
        }

        const mention = ephemeral ? undefined : getMention(chatInteraction);
        const payload = buildStatusPayload(
          STATUS_SERVICES[provider],
          incident,
          mention,
          true
        );
        await chatInteraction.editReply(payload);
        return;
      }

      const configured = process.env.GITHUB_REPOSITORY?.trim();
      if (!configured) {
        await chatInteraction.editReply("GitHub Previews is not configured.");
        return;
      }
      const [owner, repo] = configured.split("/");
      const commentId = chatInteraction.options.getString("comment", true);
      const comment = await fetchPreviewComment(commentId, owner, repo);
      if (!comment) {
        await chatInteraction.editReply("Commit comment not found.");
        return;
      }

      const payload = await buildPreviewPayload(null, comment, owner, repo);
      const mention = ephemeral ? undefined : getMention(chatInteraction);
      if (mention) payload.components.push({ type: 10, content: mention });
      await chatInteraction.editReply(payload);
    } catch (error) {
      console.error("[send] Failed to build static output", error);
      await chatInteraction.editReply("The requested update could not be sent.");
    }
  }
};

export default command;
