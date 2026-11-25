import { RoleSelectMenuBuilder } from "discord.js";
import { RoleMention } from "../../Models/RoleMention.js";
import { SubscriptionType } from "../../Models/Subscription.js";
import { SERVICE_HEADERS } from "./statusMessage.js";

export type MentionKind = "universal" | "event" | "impact";

const STATUS_IMPACTS = ["None", "Minor", "Major", "Critical"];
const PREVIEW_CATEGORIES = [
  "Strings",
  "Experiments",
  "Endpoints",
  "Dismissible Content",
  "Miscellaneous"
];

const STATUS_TITLES: Partial<Record<SubscriptionType, string>> = {
  [SubscriptionType.DiscordStatus]: SERVICE_HEADERS.discordStatus,
  [SubscriptionType.CloudflareStatus]: SERVICE_HEADERS.cloudflareStatus,
  [SubscriptionType.GitHubStatus]: SERVICE_HEADERS.githubStatus
};

/** Finds an existing role mapping for a subscription category. */
export async function getExistingRole(
  subscriptionId: string,
  guildId: string,
  kind: MentionKind,
  category: string
) {
  return RoleMention.findOne({
    subscriptionId,
    guildId,
    type: kind,
    category
  });
}

/** Builds a 0-1 role selector and restores its saved default role. */
export function buildRoleSelector(
  subscriptionId: string,
  kind: MentionKind,
  category: string,
  placeholder: string,
  existingRoleId?: string
) {
  const selector = new RoleSelectMenuBuilder()
    .setCustomId(`notify:role:${subscriptionId}:${kind}:${category}`)
    .setPlaceholder(placeholder)
    .setMinValues(0)
    .setMaxValues(1);

  if (existingRoleId) selector.setDefaultRoles(existingRoleId);
  return selector.toJSON();
}

/** Builds the shared status notification panel using the subscription-specific title. */
export async function buildStatusPanel(
  subscriptionType: SubscriptionType,
  subscriptionId: string,
  guildId: string
) {
  const title = STATUS_TITLES[subscriptionType] ?? "Status";
  const universal = await getExistingRole(subscriptionId, guildId, "universal", "universal");
  const incident = await getExistingRole(subscriptionId, guildId, "event", "Incident");
  const maintenance = await getExistingRole(subscriptionId, guildId, "event", "Maintenance");

  const container: any[] = [
    { type: 10, content: `# ${title}\n## Configure role mentions\nSelect a role for universal, event-specific, or impact-specific notifications.` },
    { type: 14, spacing: 2 },
    { type: 10, content: "## Universal Mention\nMentioned for every status update." },
    { type: 1, components: [
      buildRoleSelector(subscriptionId, "universal", "universal", "Select a universal role", universal?.roleId)
    ] },
    { type: 14 },
    { type: 10, content: "## Mention by Event\nAssign roles for incidents or maintenance." },
    { type: 1, components: [
      buildRoleSelector(subscriptionId, "event", "Incident", "Select a role for incidents", incident?.roleId)
    ] },
    { type: 1, components: [
      buildRoleSelector(subscriptionId, "event", "Maintenance", "Select a role for maintenance", maintenance?.roleId)
    ] },
    { type: 14 },
    { type: 10, content: "## Mention by Impact\nAssign roles for specific incident impact levels." }
  ];

  for (const impact of STATUS_IMPACTS) {
    const mapping = await getExistingRole(subscriptionId, guildId, "impact", impact);
    container.push({
      type: 1,
      components: [
        buildRoleSelector(subscriptionId, "impact", impact, `Select a role for ${impact} impact`, mapping?.roleId)
      ]
    });
  }

  return [{ type: 17, components: container }];
}

/** Builds the Discord Previews notification panel. */
export async function buildPreviewPanel(subscriptionId: string, guildId: string) {
  const universal = await getExistingRole(subscriptionId, guildId, "universal", "universal");
  const container: any[] = [
    { type: 10, content: `# ${SERVICE_HEADERS.discordPreviews}\n## Configure role mentions\nSelect a role for all previews or for specific categories.` },
    { type: 14, spacing: 2 },
    { type: 10, content: "## Universal Mention\nMentioned for every Discord Preview comment." },
    { type: 1, components: [
      buildRoleSelector(subscriptionId, "universal", "universal", "Select a universal role", universal?.roleId)
    ] },
    { type: 14 },
    { type: 10, content: "## Mention by Category" }
  ];

  for (const category of PREVIEW_CATEGORIES) {
    const mapping = await getExistingRole(subscriptionId, guildId, "event", category);
    container.push({ type: 10, content: `### ${category}` });
    container.push({
      type: 1,
      components: [
        buildRoleSelector(subscriptionId, "event", category, `Select a role for ${category}`, mapping?.roleId)
      ]
    });
  }

  return [{ type: 17, components: container }];
}
