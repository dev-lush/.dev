import { MessageFlags } from "discord.js";
import { SubscriptionType } from "../../Models/Subscription.js";

export interface StatusUpdate {
  id: string;
  status: string;
  body: string;
  createdAt: string;
  displayAt: string;
}

export interface StatusIncident {
  id: string;
  name: string;
  status: string;
  impact: string;
  createdAt: string;
  updatedAt: string;
  shortlink?: string;
  scheduledFor?: string;
  affectedComponents: string[];
  updates: StatusUpdate[];
}

export interface StatusServiceDefinition {
  title: string;
  header: string;
  baseUrl: string;
  apiBaseUrl: string;
  subscriptionType: SubscriptionType;
}

/** Discord service header emojis used in status and preview Components V2 messages. */
export const SERVICE_HEADERS = {
  discordStatus: "<:Discord_Status:1430905087127191674> Discord Status",
  githubStatus: "<:GitHub_Status:1574468838165192844> GitHub Status",
  cloudflareStatus: "<:Cloudflare_Status:1574468840534843526> Cloudflare Status",
  discordPreviews: "<:Discord_Previews:1404064048110370976> Discord Previews"
} as const;

export const STATUS_SERVICES: Record<"discord" | "github" | "cloudflare", StatusServiceDefinition> = {
  discord: {
    title: "Discord Status",
    header: SERVICE_HEADERS.discordStatus,
    baseUrl: "https://discordstatus.com",
    apiBaseUrl: "https://discordstatus.com/api/v2",
    subscriptionType: SubscriptionType.DiscordStatus
  },
  github: {
    title: "GitHub Status",
    header: SERVICE_HEADERS.githubStatus,
    baseUrl: "https://www.githubstatus.com",
    apiBaseUrl: "https://www.githubstatus.com/api/v2",
    subscriptionType: SubscriptionType.GitHubStatus
  },
  cloudflare: {
    title: "Cloudflare Status",
    header: SERVICE_HEADERS.cloudflareStatus,
    baseUrl: "https://cloudflarestatus.com",
    apiBaseUrl: "https://cloudflarestatus.com/api/v2",
    subscriptionType: SubscriptionType.CloudflareStatus
  }
};

const COLORS: Record<string, number> = {
  none: 0x2c2f33,
  minor: 0xfee75c,
  major: 0xe67e22,
  critical: 0xed4245,
  maintenance: 0x3498db,
  resolved: 0x57f287,
  completed: 0x57f287
};

function formatList(values: string[]): string {
  if (values.length === 0) return "None";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function titleCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function discordTimestamp(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.valueOf())) return "";
  const unix = Math.floor(time.valueOf() / 1000);
  return `<t:${unix}:R>. <t:${unix}:D> - <t:${unix}:t>`;
}

/**
 * Normalizes Statuspage update bodies for Discord Components V2 text blocks.
 *
 * Statuspage may return HTML even for incident updates that otherwise look like
 * plain text. This function converts line-break and paragraph tags to Markdown
 * line breaks, strips the remaining tags, and decodes common HTML entities.
 *
 * @param value Raw Statuspage update body.
 * @returns Clean Discord-safe text with uniform paragraph spacing.
 */
export function normalizeStatusText(value: string): string {
  if (!value) return "";

  let normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|blockquote)>/gi, "\n\n")
    .replace(/<(?:p|div|section|article|blockquote)(?:\s[^>]*)?>/gi, "")
    .replace(/<li(?:\s[^>]*)?>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<(?:\/)?(?:ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x0*([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#([0-9]+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    );

  normalized = normalized
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  return normalized;
}

/**
 * Indents every continuation line beneath a numbered Statuspage update.
 *
 * Discord renders Markdown list items as one visual block. Prefixing the first
 * line with `- ` and continuation lines with two spaces keeps paragraph breaks,
 * wrapped lines, and nested text from escaping the update section.
 *
 * @param value Normalized update body.
 * @returns An update body with consistent Markdown indentation.
 */
export function indentStatusUpdateBody(value: string): string {
  const lines = normalizeStatusText(value).split("\n");

  if (!lines.length) return "";

  return lines
    .map((line, index) => {
      if (!line) return "  ";
      const trimmed = line.trimStart();
      const nestedList = /^[-*]\s+/.test(trimmed);
      if (index === 0) return nestedList ? `  ${trimmed}` : `- ${trimmed}`;
      return nestedList ? `  ${trimmed}` : `  ${trimmed}`;
    })
    .join("\n");
}

/** Builds the Components V2 status payload shared by all supported Statuspage hosts. */
export function buildStatusPayload(
  service: StatusServiceDefinition,
  incident: StatusIncident,
  mentions?: string,
  forceOriginalColor = false
) {
  const isMaintenance =
    Boolean(incident.scheduledFor) ||
    incident.name.toLowerCase().includes("maintenance");
  const blocks: any[] = [];

  let header = `# ${service.header}\n${incident.name}`;
  if (incident.affectedComponents.length) {
    header += `\n-# ${isMaintenance ? "This scheduled maintenance affected" : "This incident affected"}: ${formatList(incident.affectedComponents)}`;
  }
  blocks.push({ type: 10, content: header }, { type: 14, spacing: 2 });

  const updates = [...incident.updates].sort(
    (a, b) => new Date(a.createdAt).valueOf() - new Date(b.createdAt).valueOf()
  );
  if (!updates.length) {
    const timestamp = discordTimestamp(incident.createdAt);
    blocks.push({
      type: 10,
      content: `## ${titleCase(incident.status)}\nNo detailed updates available.\n-# Posted ${timestamp}`
    });
  } else {
    const counts = updates.reduce<Record<string, number>>((result, update) => {
      result[update.status] = (result[update.status] ?? 0) + 1;
      return result;
    }, {});
    const statusCounters: Record<string, number> = {};
    const groups: Array<{ status: string; updates: typeof updates }> = [];
    for (const update of updates) {
      const current = groups.at(-1);
      if (current?.status === update.status) {
        current.updates.push(update);
      } else {
        groups.push({ status: update.status, updates: [update] });
      }
    }

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      const needsNumbering = (counts[group.status] ?? 0) > 1;

      if (!needsNumbering) {
        const update = group.updates[0];
        const timestamp = discordTimestamp(update.displayAt || update.createdAt);
        blocks.push({
          type: 10,
          content: `## ${titleCase(update.status)}\n${normalizeStatusText(update.body)}\n-# Posted ${timestamp}`
        });
      } else {
        blocks.push({ type: 10, content: `## ${titleCase(group.status)}` });

        for (let updateIndex = 0; updateIndex < group.updates.length; updateIndex++) {
          const update = group.updates[updateIndex];
          statusCounters[group.status] = (statusCounters[group.status] ?? 0) + 1;
          const timestamp = discordTimestamp(update.displayAt || update.createdAt);
          blocks.push({
            type: 10,
            content: `### Update #${statusCounters[group.status]}\n${indentStatusUpdateBody(update.body)}\n  -# Posted ${timestamp}`
          });

          if (updateIndex < group.updates.length - 1) {
            blocks.push({ type: 14, divider: false });
          }
        }
      }

      if (groupIndex < groups.length - 1) {
        blocks.push({ type: 14, spacing: 1 });
      }
    }
  }

  blocks.push(
    { type: 14, spacing: 2 },
    {
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: `${service.baseUrl.replace("https://", "")}/incidents`,
        emoji: isMaintenance
          ? { id: "1406555813874634772", name: "Utilities" }
          : { id: "1404064140066291723", name: "Bug" },
        url: incident.shortlink || `${service.baseUrl}/incidents/${incident.id}`
      }]
    }
  );

  if (mentions) blocks.push({ type: 10, content: mentions });

  const status = incident.status.toLowerCase();
  const impact = incident.impact.toLowerCase();
  const resolved = status === "resolved" || status === "completed";
  const accent = resolved && !forceOriginalColor
    ? COLORS.resolved
    : COLORS[impact] ?? (isMaintenance ? COLORS.maintenance : COLORS.none);

  return {
    components: [{ type: 17, components: blocks, accent_color: accent }],
    flags: MessageFlags.IsComponentsV2 as 32768
  };
}
