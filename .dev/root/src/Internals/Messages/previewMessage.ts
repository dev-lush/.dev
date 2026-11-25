import path from "node:path";
import {
  AttachmentPayload,
  MessageFlags,
  NewsChannel,
  TextChannel,
  type Client
} from "discord.js";
import { RoleMention } from "../../Models/RoleMention.js";
import {
  Subscription,
  SubscriptionType,
  type SubscriptionDocument
} from "../../Models/Subscription.js";
import { fetchAsGitHubApp } from "../../Utils/githubApp.js";
import { crosspostOnce } from "../../Utils/crosspost.js";
import { SERVICE_HEADERS } from "./statusMessage.js";

export interface GitHubCommitComment {
  id: number;
  url: string;
  html_url: string;
  commit_id: string;
  body: string;
  created_at: string;
  attachments?: Array<{
    url: string;
    download_url: string;
    name: string;
    content_type?: string;
  }>;
  user: {
    login: string;
    html_url: string;
  };
}

interface CommentSection {
  title: string;
  content: string;
  category: string;
}

const MAX_COMPONENT_TEXT = 3800;
const MAX_ATTACHMENTS = 10;
const MAX_DISCORD_FILE_SIZE = 10 * 1024 * 1024;
const PREVIEW_MEDIA = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm"
]);

/** Parses Discord-Datamining style markdown sections and categories. */
export function parsePreviewSections(body: string): CommentSection[] {
  const regex = /##+\s*(.+?)\r?\n+([\s\S]*?)(?=\r?\n##+|$)/g;
  const known = new Map([
    ["strings", "Strings"],
    ["experiments", "Experiments"],
    ["experiment", "Experiments"],
    ["endpoints", "Endpoints"],
    ["dismissible content", "Dismissible Content"]
  ]);
  const sections: CommentSection[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(body))) {
    const title = match[1].trim();
    const content = match[2].trim();
    const normalizedTitle = title.toLowerCase();
    const category = /\bexperiment/i.test(normalizedTitle)
      ? "Experiments"
      : known.get(normalizedTitle) ?? "Miscellaneous";
    sections.push({ title, content, category });
  }
  return sections;
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._\-[\]()]/g, "")
    .replace(/^[_.]+|[_.]+$/g, "") || "attachment";
}

function uniqueFilename(name: string, files: AttachmentPayload[]): string {
  const used = new Set(files.map((file) => file.name));
  if (!used.has(name)) return name;
  const extension = path.extname(name);
  const base = path.basename(name, extension);
  let number = 1;
  while (used.has(`${base}-${number}${extension}`)) number++;
  return `${base}-${number}${extension}`;
}

async function getRoleMentions(
  subscription: SubscriptionDocument,
  sections: CommentSection[]
): Promise<string | undefined> {
  const mappings = await RoleMention.find({
    guildId: subscription.guildId,
    subscriptionId: subscription._id
  });
  const pings = new Set<string>();

  for (const mapping of mappings) {
    if (mapping.type === "universal") pings.add(`<@&${mapping.roleId}>`);
  }
  const categories = new Set(sections.map((section) => section.category));
  if (!categories.size) categories.add("Miscellaneous");
  for (const mapping of mappings) {
    if (mapping.type === "event" && categories.has(mapping.category)) {
      pings.add(`<@&${mapping.roleId}>`);
    }
  }
  return pings.size ? [...pings].join(" ") : undefined;
}

function splitMarkdownContent(
  body: string,
  commentId: number,
  files: AttachmentPayload[]
): any[] {
  const components: any[] = [];
  const diffRegex = /```diff\s+([\s\S]*?)```/g;
  let cursor = 0;
  let diffIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = diffRegex.exec(body))) {
    const preceding = body.slice(cursor, match.index);
    if (preceding.trim()) components.push(...splitTextComponent(preceding, commentId, files, diffIndex));
    cursor = diffRegex.lastIndex;

    const diff = match[1].trim();
    if (diff.length > MAX_COMPONENT_TEXT) {
      const name = uniqueFilename(
        `${commentId}${diffIndex ? `-(${diffIndex + 1})` : ""}.txt`,
        files
      );
      files.push({ attachment: Buffer.from(diff, "utf8"), name });
      components.push({
        type: 13,
        file: { url: `attachment://${name}`, name }
      });
      diffIndex++;
    } else if (diff) {
      components.push({ type: 10, content: `\`\`\`diff\n${diff}\n\`\`\`` });
    }
  }
  const trailing = body.slice(cursor);
  if (trailing.trim()) components.push(...splitTextComponent(trailing, commentId, files, diffIndex));
  return components;
}

function splitTextComponent(
  text: string,
  commentId: number,
  files: AttachmentPayload[],
  startingFileIndex: number
): any[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= MAX_COMPONENT_TEXT) {
    return [{ type: 10, content: trimmed }];
  }

  const name = `${commentId}-(${startingFileIndex + 1}).txt`;
  const uniqueName = uniqueFilename(name, files);
  files.push({ attachment: Buffer.from(trimmed, "utf8"), name: uniqueName });
  return [{ type: 13, file: { url: `attachment://${uniqueName}`, name: uniqueName } }];
}

/**
 * Downloads an image or file. GitHub-hosted URLs use the App installation token;
 * unrelated public URLs are fetched normally to avoid sending App credentials elsewhere.
 *
 * @param rawUrl URL extracted from the commit comment.
 * @param owner GitHub repository owner.
 * @param repo GitHub repository name.
 * @returns A fetch Response when the download succeeds.
 */
async function downloadPreviewAttachment(
  rawUrl: string,
  owner: string,
  repo: string
): Promise<Response> {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    throw new Error("Invalid attachment URL");
  }

  if (hostname === "github.com" || hostname.endsWith(".githubusercontent.com")) {
    return fetchAsGitHubApp(rawUrl, {}, { owner, repo });
  }
  return fetch(rawUrl);
}

/** Builds the Discord Previews Components V2 payload and attachment files. */
export async function buildPreviewPayload(
  subscription: SubscriptionDocument | null,
  comment: GitHubCommitComment,
  owner: string,
  repo: string
) {
  const sections = parsePreviewSections(comment.body ?? "");
  const components: any[] = [
    { type: 10, content: `# ${SERVICE_HEADERS.discordPreviews}` },
    {
      type: 10,
      content: `**[@${comment.user.login}](${comment.user.html_url})** in commit [\`${comment.commit_id.slice(0, 7)}\`](https://github.com/${owner}/${repo}/commit/${comment.commit_id}) posted a comment:`
    },
    { type: 14, spacing: 2 }
  ];
  const files: AttachmentPayload[] = [];

  if (sections.length) {
    for (let index = 0; index < sections.length; index++) {
      components.push({ type: 10, content: `## ${sections[index].title}` });
      components.push(...splitMarkdownContent(sections[index].content, comment.id, files));
      if (index < sections.length - 1) components.push({ type: 14 });
    }
  } else {
    components.push(...splitMarkdownContent(comment.body ?? "", comment.id, files));
  }

  const imageRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
  const attachmentUrls = new Set<string>();
  for (const attachment of comment.attachments ?? []) {
    attachmentUrls.add(attachment.download_url || attachment.url);
  }
  let imageMatch: RegExpExecArray | null;
  while ((imageMatch = imageRegex.exec(comment.body ?? ""))) {
    attachmentUrls.add(imageMatch[1]);
  }

  const media: any[] = [];
  const fileComponents: any[] = [];
  for (const rawUrl of attachmentUrls) {
    if (files.length + media.length + fileComponents.length >= MAX_ATTACHMENTS) break;
    try {
      const response = await downloadPreviewAttachment(rawUrl, owner, repo);
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type")?.split(";")[0]
        ?? "application/octet-stream";
      const rawName = decodeURIComponent(rawUrl.split(/[/?#]/).filter(Boolean).pop() ?? `attachment-${comment.id}`);
      let name = sanitizeFilename(rawName);
      if (!path.extname(name)) {
        const extension = contentType === "image/png" ? ".png"
          : contentType === "image/jpeg" ? ".jpg"
          : contentType === "image/gif" ? ".gif"
          : contentType === "image/webp" ? ".webp"
          : contentType === "video/mp4" ? ".mp4"
          : contentType === "video/webm" ? ".webm"
          : ".txt";
        name += extension;
      }
      name = uniqueFilename(name, files);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_DISCORD_FILE_SIZE) continue;

      files.push({ attachment: buffer, name });
      if (PREVIEW_MEDIA.has(contentType)) {
        media.push({ media: { url: `attachment://${name}` } });
      } else {
        fileComponents.push({ type: 13, file: { url: `attachment://${name}`, name } });
      }
    } catch (error) {
      console.warn("[previewMessage] Attachment download failed:", error);
    }
  }

  if (media.length) {
    components.push({ type: 14 }, { type: 12, items: media });
  }
  if (fileComponents.length) {
    components.push({ type: 14 }, ...fileComponents);
  }

  components.push(
    { type: 14, spacing: 2 },
    {
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: `${owner}/${repo}`,
        emoji: { id: "1404064225839546481", name: "GitHub" },
        url: comment.html_url
      }]
    }
  );

  const payload: any = {
    components: [{ type: 17, components }],
    files,
    flags: MessageFlags.IsComponentsV2
  };
  const mentions = subscription
    ? await getRoleMentions(subscription, sections)
    : undefined;
  if (mentions) payload.components.push({ type: 10, content: mentions });
  return payload;
}

/** Dispatches one webhook comment to every preview subscription without polling. */
export async function dispatchPreviewComment(
  client: Client,
  comment: GitHubCommitComment,
  owner: string,
  repo: string
): Promise<number> {
  const subscriptions = await Subscription.find({
    type: SubscriptionType.DiscordPreviews
  });
  let sentCount = 0;

  for (const subscription of subscriptions) {
    if (subscription.lastPreviewCommentId >= comment.id) continue;
    const channel = await client.channels.fetch(subscription.channelId).catch(() => null);
    if (!(channel instanceof TextChannel || channel instanceof NewsChannel)) continue;

    try {
      const payload = await buildPreviewPayload(
        subscription as unknown as SubscriptionDocument,
        comment,
        owner,
        repo
      );
      const sent = await channel.send({
        components: payload.components,
        files: payload.files,
        flags: MessageFlags.IsComponentsV2
      });
      if (subscription.autoPublish && channel instanceof NewsChannel) {
        await crosspostOnce(sent, channel);
      }
      subscription.lastPreviewCommentId = comment.id;
      await subscription.save();
      sentCount++;
    } catch (error) {
      console.error(
        `[previewMessage] Failed to deliver comment ${comment.id} to subscription ${subscription._id}:`,
        error
      );
    }
  }
  return sentCount;
}
