import {
    Client,
    TextChannel,
    NewsChannel,
    MessageFlags,
    AttachmentPayload
} from 'discord.js';
import path from 'path';
import { Subscription, SubscriptionType, CommitCommentCheckpoint } from '../Models/Subscription.js';
import { RoleMentionsHandler, IRoleMentionDoc } from '../Models/RoleMentionsHandler.js';
import { fetchWithToken, getAvailableToken, GitHubApiError } from '../Models/GitHubToken.js';
import { crosspostMessage } from './autoPublisher.js';

/**
 * Timestamp of the last warning about missing GitHub tokens, to prevent log spam.
 */
let lastRateLimitWarn = 0;
/**
 * Flag to track if this is the first polling cycle since the bot started.
 * Used to prevent sending a flood of old comments on the very first run.
 */
let isFirstPoll = true;

/**
 * Determines the MIME type of a file based on its URL's extension.
 * @param url The URL of the file.
 * @returns A string representing the content type (e.g., 'image/png').
 */
function getContentType(url: string): string {
    const extension = (url.split('?')[0].split('.').pop() || '').toLowerCase();
    switch (extension) {
        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';
        case 'png':
            return 'image/png';
        case 'gif':
            return 'image/gif';
        case 'mp4':
            return 'video/mp4';
        case 'mov':
            return 'video/quicktime';
        case 'webm':
            return 'video/webm';
        default:
            // Default for unknown types
            return 'application/octet-stream';
    }
}

/**
 * @interface Section
 * @description Represents a parsed section from a commit comment's body, typically delineated by markdown headers.
 */
interface Section { title: string; content: string; category: string; }

/**
 * @interface CommitCommentMessageOptions
 * @description A structured set of options required to build a Discord message payload from a commit comment.
 */
interface CommitCommentMessageOptions {
  sha: string;
  commentId: number;
  commentUrl: string;
  author: string;
  authorUrl: string;
  body: string;
  createdAt: string;
  roleMentions: Record<string, string>;
  attachments?: GitHubCommentAttachment[];
  allRolesForSub?: IRoleMentionDoc[];
  isNewComment?: boolean;
}

/**
 * @interface GitHubCommentAttachment
 * @description Represents an attachment included in a GitHub commit comment.
 */
export interface GitHubCommentAttachment {
  url: string;
  download_url: string;
  name: string;
  content_type?: string;
}

/**
 * @interface GitHubComment
 * @description Represents the structure of a commit comment object from the GitHub API.
 */
export interface GitHubComment {
  id: number;
  url:string;
  commit_id: string;
  html_url: string;
  user: { login: string; html_url: string };
  body: string;
  created_at: string;
  attachments?: GitHubCommentAttachment[];
}

/**
 * @interface GitHubCommit
 * @description Represents the essential structure of a commit object from the GitHub API for polling purposes.
 */
interface GitHubCommit {
  sha: string;
  commit: {
    author: { date: string };
  };
}

/**
 * Sanitizes a filename by replacing spaces with underscores and removing characters
 * that are not alphanumeric, underscores, hyphens, or periods.
 * @param filename The original filename.
 * @returns A sanitized filename string.
 */
function sanitizeFilename(filename: string): string {
  // Replace spaces and other whitespace with underscores
  let sanitized = filename.replace(/\s/g, '_');
  // Remove any character that is not a letter, number, dot, underscore, or hyphen.
  sanitized = sanitized.replace(/[^a-zA-Z0-9._-]/g, '');
  return sanitized;
}

/**
 * Generates a unique filename to avoid collisions within a single message payload.
 * If the desired name already exists, it appends a counter (e.g., 'file-1.txt').
 * @param desiredName The preferred filename.
 * @param existingFiles The list of files already added to the payload.
 * @returns A unique filename string.
 */
function getUniqueFilename(desiredName: string, existingFiles: AttachmentPayload[]): string {
    const existingNames = new Set(existingFiles.map(f => f.name));
    if (!existingNames.has(desiredName)) {
        return desiredName;
    }

    const ext = path.extname(desiredName);
    const base = path.basename(desiredName, ext);
    
    let counter = 1;
    let newName: string;

    do {
        newName = `${base}-${counter}${ext}`;
        counter++;
    } while (existingNames.has(newName));

    return newName;
}

/**
 * Checks if any GitHub tokens are available in the database.
 * @returns {Promise<boolean>} True if at least one token is loaded and active.
 */
export async function isTokenLoaded(): Promise<boolean> {
    const token = await getAvailableToken();
    return !!token;
}

/**
 * Constructs a complex Discord message payload from a GitHub commit comment.
 * This function handles parsing markdown, extracting attachments, formatting content into
 * sections, managing character limits by moving content to file attachments, and generating role pings.
 * @param options The structured data from the commit comment.
 * @param sections The comment body parsed into sections.
 * @returns A Discord message payload object, including components and files.
 */
export async function buildCommitCommentPayload(
    options: CommitCommentMessageOptions, 
    sections: Section[]
) {
    const { sha, commentId, commentUrl, author, authorUrl, body, attachments = [], allRolesForSub = [], isNewComment = true } = options;
    const shortSha = `[\`${sha.slice(0, 7)}\`](https://github.com/Discord-Datamining/Discord-Datamining/commit/${sha})`;

    // --- START: Pings logic ---
    let pings: string | undefined;
    if (allRolesForSub.length > 0) {
        const universalRole = allRolesForSub.find(r => r.value.endsWith(':universal'));
        const categoryRoles = Object.fromEntries(
            allRolesForSub
                .filter(r => !r.value.endsWith(':universal'))
                .map(r => [r.value.split(':')[1], `<@&${r.roleId}>`])
        );

        const pingsSet = new Set<string>();
        if (universalRole) {
            pingsSet.add(`<@&${universalRole.roleId}>`);
        }

        const categories = new Set<string>(sections.map(s => s.category));
        if (categories.size === 0) categories.add('Miscellaneous');
        
        for (const category of categories) {
            if (categoryRoles[category]) {
                pingsSet.add(categoryRoles[category]);
            }
        }
        const uniquePings = Array.from(pingsSet);
        if (uniquePings.length > 0) {
            pings = uniquePings.join(' ');
        }
    }
    // --- END: Pings logic ---

    // Combine API attachments with any attachments parsed from the markdown body
    const combinedAttachments: GitHubCommentAttachment[] = [...attachments];
    const urlRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
    let match;
    while ((match = urlRegex.exec(body)) !== null) {
        const url = match[1];
        // Avoid duplicating if the URL is already in the attachments list from the API
        if (!combinedAttachments.some(att => att.download_url === url || att.url === url)) {
            const nameWithQuery = url.substring(url.lastIndexOf('/') + 1);
            const name = nameWithQuery.split('?')[0]; // Strip query params
            combinedAttachments.push({
                url: url,
                download_url: url,
                name: name.length > 0 ? name : 'attachment',
                content_type: getContentType(url)
            });
        }
    }

    // Build components
    const comps: any[] = [];
    comps.push({ type: 10, content: '# <:Discord_Previews:1404064048110370976> Discord Previews' });
    
    const verb = isNewComment ? 'a new' : 'a';
    
    comps.push(
      { type: 10, content: `**[@${author}](${authorUrl})** in commit ${shortSha} posted ${verb} comment:` },
      { type: 14, spacing: 2 }
    );

    // Prepare attachments
    const files: AttachmentPayload[] = [];
    let totalLength = comps.reduce((acc, c) => acc + (c.content?.length || 0), 0);

    const supportedMediaTypes = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm'];
    const processedAttachmentUrls = new Set<string>();

    const processContent = async (content: string, sectionIdx: number) => {
        const parts = content.split(/(!\[[^\]]*\]\([^\)]+\))/g).filter(p => p);
        let textBuffer = '';
        let imageGroup: GitHubCommentAttachment[] = [];

        const flushImageGroup = async () => {
            if (imageGroup.length === 0) return;

            const mediaItems: any[] = [];
            const fileItems: any[] = [];
            const MAX_ATTACHMENTS = 10;
            const attachmentsToProcess = imageGroup.slice(0, Math.max(0, MAX_ATTACHMENTS - files.length));

            for (const [i, attachment] of attachmentsToProcess.entries()) {
                processedAttachmentUrls.add(attachment.url);
                processedAttachmentUrls.add(attachment.download_url);

                try {
                    const resp = await fetchWithToken(attachment.url, { headers: { 'Accept': 'application/octet-stream' } }, false);
                    if (resp.ok) {
                        const finalContentType = resp.headers.get('content-type')?.split(';')[0] || attachment.content_type || 'application/octet-stream';
                        const arrBuf = await resp.arrayBuffer();
                        if (arrBuf.byteLength > 0) {
                            const uniqueDisplayName = getUniqueFilename(attachment.name, files);

                            if (supportedMediaTypes.includes(finalContentType)) {
                                files.push({ attachment: Buffer.from(arrBuf), name: uniqueDisplayName });
                                mediaItems.push({ media: { url: `attachment://${uniqueDisplayName}` } });
                            } else {
                                files.push({ attachment: Buffer.from(arrBuf), name: uniqueDisplayName });
                                fileItems.push({ type: 13, file: { url: `attachment://${uniqueDisplayName}`, name: uniqueDisplayName } });
                            }
                        }
                    }
                } catch (error) {
                    console.error(`Failed to process attachment ${attachment.url}:`, error);
                }
            }

            if (mediaItems.length > 0) {
                comps.push({ type: 12, items: mediaItems });
                if (fileItems.length > 0) comps.push({ type: 14 });
            }
            if (fileItems.length > 0) comps.push(...fileItems);
            imageGroup = [];
        };

        const flushTextBuffer = () => {
            let trimmed = textBuffer.trim();
            if (trimmed) {
                const diffRegex = /```diff\s+([\s\S]*?)```/g;
                const diffsToProcess: { fullMatch: string, content: string }[] = [];
                let match;
                
                while ((match = diffRegex.exec(trimmed)) !== null) {
                    diffsToProcess.push({ fullMatch: match[0], content: match[1].trim() });
                }

                let diffsAttachedCount = 0;
                diffsToProcess.forEach((diff) => {
                    const estimatedLength = totalLength + trimmed.length;
                    const shouldMoveToAttachment = diff.content.length > 3500 || estimatedLength > 3800;

                    if (shouldMoveToAttachment) {
                        const displayNameNumPart = diffsToProcess.length > 1 ? `-(${diffsAttachedCount + 1})` : '';
                        const displayName = `${commentId}${displayNameNumPart}.txt`;
                        
                        files.push({ attachment: Buffer.from(diff.content, 'utf8'), name: displayName });
                        
                        comps.push({ type: 13, file: { url: `attachment://${displayName}`, name: displayName } });
                        
                        trimmed = trimmed.replace(diff.fullMatch, '');
                        diffsAttachedCount++;
                    }
                });

                const finalContent = trimmed.trim();
                if (finalContent) {
                    comps.push({ type: 10, content: finalContent });
                    totalLength += finalContent.length;
                }
            }
            textBuffer = '';
        };

        for (const part of parts) {
            if (/^!\[[^\]]*\]\([^\)]+\)$/.test(part.trim())) {
                flushTextBuffer();
                const urlMatch = /!\[[^\]]*\]\(([^)]+)\)/.exec(part);
                if (urlMatch) {
                    const url = urlMatch[1];
                    const attachment = combinedAttachments.find(a => a.download_url === url || a.url === url);
                    if (attachment) imageGroup.push(attachment);
                }
            } else {
                await flushImageGroup();
                textBuffer += part;
            }
        }
        flushTextBuffer();
        await flushImageGroup();
    };

    if (sections.length) {
        for (let idx = 0; idx < sections.length; idx++) {
            comps.push({ type: 10, content: `## ${sections[idx].title}` });
            await processContent(sections[idx].content, idx);
            if (idx < sections.length - 1) comps.push({ type: 14 });
        }
    } else {
        await processContent(body, 0);
    }

    const remainingAttachments = combinedAttachments.filter(att => 
        !processedAttachmentUrls.has(att.url) && !processedAttachmentUrls.has(att.download_url)
    );

    if (remainingAttachments.length > 0) {
        comps.push({ type: 14 });
        comps.push({ type: 10, content: `## <:Inbox:1408012066106638336> Additional Files` });
        const CHUNK_SIZE = 5;
        for (let i = 0; i < remainingAttachments.length; i += CHUNK_SIZE) {
            const chunk = remainingAttachments.slice(i, i + CHUNK_SIZE);
            const buttonComponents = chunk.map(attachment => {
                const isMedia = supportedMediaTypes.includes(getContentType(attachment.download_url || attachment.name));
                return {
                    type: 2, style: 5,
                    label: attachment.name.length > 80 ? `${attachment.name.slice(0, 77)}...` : attachment.name,
                    emoji: { id: isMedia ? '1408014009000792154' : '1407965102304530452', name: isMedia ? 'Medias' : 'File' },
                    url: attachment.download_url
                };
            });
            comps.push({ type: 1, components: buttonComponents });
        }
    }

    // Footer button
    comps.push({ type: 14, spacing: 2 });
    comps.push({
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: 'github.com/Discord-Datamining',
        emoji: { id: '1404064225839546481', name: 'GitHub' },
        url: commentUrl
      }]
    });

    // Build final payload
    const container = { type: 17, components: comps };
    const payload: any = { components: [container] };

    if (files.length > 0) {
        payload.files = files;
    }

    if (pings) {
        payload.components.push({ type: 10, content: pings });
    }

    return payload;
}

/**
 * Parses a raw markdown string (from a commit comment body) into structured sections.
 * It uses markdown headers (##) as delimiters.
 * @param body The raw markdown content of the comment.
 * @returns An array of `Section` objects.
 */
export function parseSections(body: string): Section[] {
  const regex = /##+\s*(.+?)\r?\n+([\s\S]*?)(?=\r?\n##+|$)/g;
  const known = ['Strings', 'Experiments', 'Endpoints', 'Dismissible Content'];
  const out: Section[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(body)) !== null) {
    const raw = m[1].trim();
    const content = m[2].trim();
    const isExp = /\bExperiment[s]?\b/i.test(raw);
    const matched = known.find(h => h.toLowerCase() === raw.toLowerCase());
    const category = isExp ? 'Experiments' : (matched ?? 'Miscellaneous');
    out.push({ title: raw, content, category });
  }
  return out;
}

/**
 * The main polling function that periodically checks for new commit comments.
 * It uses multiple strategies (fetching recent commits and repository events) to reliably
 * find new comments since the last checkpoint. It then processes these comments and
 * dispatches them to subscribed channels.
 * @param client The Discord client instance.
 */
export async function checkNewCommitComments(client: Client) {
    if (!await isTokenLoaded()) {
        if (Date.now() - lastRateLimitWarn > 60000) {
            console.warn('[commitMessage] Skipping polling: No active GitHub tokens available');
            lastRateLimitWarn = Date.now();
        }
        return;
    }

    try {
        let cp = await CommitCommentCheckpoint.findById('global');

        // 1. Initial Checkpoint Creation (if none exists)
        if (!cp) {
            console.log('No valid checkpoint found. Creating a new one...');
            try {
                let startCommentId = 0;
                const pickMaxId = (ids: number[]) => ids.reduce((m, v) => (v > m ? v : m), 0);

                // Scan recent events
                try {
                    const EVENT_PAGES = 3;
                    const eventCommentIds: number[] = [];
                    for (let page = 1; page <= EVENT_PAGES; page++) {
                        const eventsRes = await fetchWithToken(`https://api.github.com/repos/Discord-Datamining/Discord-Datamining/events?per_page=100&page=${page}`, undefined, true);
                        if (!eventsRes.ok) break;
                        const events = await eventsRes.json() as any[];
                        if (events.length === 0) break;
                        for (const ev of events) {
                            if (ev?.type === 'CommitCommentEvent' && ev?.payload?.comment?.id) {
                                eventCommentIds.push(ev.payload.comment.id);
                            }
                        }
                        if (events.length < 100) break;
                    }
                    const maxFromEvents = pickMaxId(eventCommentIds);
                    if (maxFromEvents > startCommentId) startCommentId = maxFromEvents;
                } catch (e) { console.warn('[init-checkpoint] Events scan failed:', e); }

                // Scan recent commits' comments
                try {
                    const commitsRes = await fetchWithToken(`https://api.github.com/repos/Discord-Datamining/Discord-Datamining/commits?per_page=100`);
                    if (commitsRes.ok) {
                        const recentCommits = await commitsRes.json() as GitHubCommit[];
                        const commitCommentIds: number[] = [];
                        for (const commit of recentCommits) {
                            const commentsOnCommitRes = await fetchWithToken(`https://api.github.com/repos/Discord-Datamining/Discord-Datamining/commits/${commit.sha}/comments`);
                            if (commentsOnCommitRes.ok) {
                                const comments = await commentsOnCommitRes.json() as GitHubComment[];
                                comments.forEach(c => commitCommentIds.push(c.id));
                            }
                        }
                        const maxFromCommits = pickMaxId(commitCommentIds);
                        if (maxFromCommits > startCommentId) startCommentId = maxFromCommits;
                    }
                } catch (e) { console.warn('[init-checkpoint] Commits scan failed:', e); }

                console.log(`[init-checkpoint] Determined starting checkpoint ID: ${startCommentId}`);
                cp = new CommitCommentCheckpoint({ _id: 'global', lastProcessedCommentId: startCommentId });
                await cp.save();
            } catch (error: any) {
                if (error.code === 11000) { // E11000 is the duplicate key error code
                    console.log('[init-checkpoint] Checkpoint was created by another process. Polling will continue on the next cycle.');
                } else {
                    console.error('[init-checkpoint] Failed to create initial checkpoint:', error);
                }
            }
            return; // Exit to start fresh on the next poll
        }

        // 2. Collect new comments from multiple sources to ensure reliability
        const allComments = new Map<number, GitHubComment>();

        // --- Strategy 1: Fetch recent commits (Primary, deep scan) ---
        try {
            const commitsRes = await fetchWithToken(
                `https://api.github.com/repos/Discord-Datamining/Discord-Datamining/commits?per_page=75`,
                undefined, false
            );

            if (commitsRes.ok) {
                const recentCommits = await commitsRes.json() as GitHubCommit[];
                for (const commit of recentCommits) {
                    try {
                        const commentsOnCommitRes = await fetchWithToken(
                            `https://api.github.com/repos/Discord-Datamining/Discord-Datamining/commits/${commit.sha}/comments`,
                            undefined, true
                        );
                        if (commentsOnCommitRes.ok) {
                            const commentsOnCommit = await commentsOnCommitRes.json() as GitHubComment[];
                            for (const comment of commentsOnCommit) {
                                if (comment.id > cp.lastProcessedCommentId) {
                                    allComments.set(comment.id, comment);
                                }
                            }
                        }
                    } catch (error) {
                        // A 404 is common for commits with no comments, so we don't need to log it as a major error.
                        if (!(error instanceof GitHubApiError && error.status === 404)) {
                           console.error(`[polling] Failed to fetch comments for commit ${commit.sha}:`, error);
                        }
                    }
                }
            } else {
                console.error(`[polling] GitHub API error on /commits endpoint: ${commitsRes.status}`);
            }
        } catch (error) {
            console.error('[polling] Error during /commits polling strategy:', error);
        }

        // --- Strategy 2: Fetch recent events (Backup, fast scan) ---
        try {
            let shouldContinueFetching = true;
            const MAX_EVENT_PAGES = 5; // Safety break to avoid excessive API calls

            for (let page = 1; page <= MAX_EVENT_PAGES && shouldContinueFetching; page++) {
                const eventsRes = await fetchWithToken(
                    `https://api.github.com/repos/Discord-Datamining/Discord-Datamining/events?per_page=100&page=${page}`,
                    undefined, true
                );

                if (!eventsRes.ok) {
                    console.error(`[polling] GitHub API error on /events endpoint: ${eventsRes.status}`);
                    break;
                }

                const events = await eventsRes.json() as any[];
                if (events.length === 0) break;

                for (const event of events) {
                    if (event.type === 'CommitCommentEvent' && event.payload?.comment) {
                        const comment = event.payload.comment as GitHubComment;
                        if (comment.id > cp.lastProcessedCommentId) {
                            allComments.set(comment.id, comment);
                        } else {
                            // We've reached a comment we've already processed. Stop fetching.
                            shouldContinueFetching = false;
                            break;
                        }
                    }
                }
                if (events.length < 100) break; // Stop if we process a partial page
            }
        } catch (error) {
            console.error('[polling] Error during /events polling strategy:', error);
        }

        // 3. Process collected comments
        const newComments = Array.from(allComments.values()).sort((a, b) => a.id - b.id);
        if (newComments.length === 0) {
            if (isFirstPoll) isFirstPoll = false;
            return;
        }

        console.log(`[polling] Found ${newComments.length} new commit comments to process from combined strategies.`);
        let lastSuccessfullyProcessedId = cp.lastProcessedCommentId || 0;

        // 4. Process new comments with robust checkpointing
        for (const comment of newComments) {
            if (!await isTokenLoaded()) {
                console.warn('[polling] No GitHub tokens available — stopping current polling run.');
                break;
            }

            try {
                const subs = await Subscription.find({ type: SubscriptionType.PREVIEWS }).exec();
                if (!subs || subs.length === 0) continue;

                for (const sub of subs) {
                    if (sub.lastCommentId && comment.id <= sub.lastCommentId) continue;

                    try {
                        const sections = parseSections(comment.body || '');
                        const allRolesForSub = await RoleMentionsHandler.find({
                            guildId: sub.guildId,
                            type: SubscriptionType.PREVIEWS,
                            value: { $regex: `^${sub._id}:` }
                        });

                        const payload = await buildCommitCommentPayload({
                            sha: comment.commit_id,
                            commentId: comment.id,
                            commentUrl: comment.html_url,
                            author: comment.user?.login ?? 'unknown',
                            authorUrl: comment.user?.html_url ?? '',
                            body: comment.body || '',
                            createdAt: comment.created_at,
                            roleMentions: {},
                            attachments: comment.attachments || [],
                            allRolesForSub
                        }, sections);

                        const channel = await client.channels.fetch(sub.channelId).catch(() => null);
                        if (channel && (channel instanceof TextChannel || channel instanceof NewsChannel)) {
                            await channel.send({
                                ...payload,
                                flags: MessageFlags.IsComponentsV2
                            });
                        } else {
                            console.warn(`[polling] Channel not found or not sendable for subscription ${sub._id} -> ${sub.channelId}`);
                        }

                        try {
                            sub.lastCommentId = comment.id;
                            await sub.save();
                        } catch (saveErr: unknown) {
                            // saveErr typed as unknown to satisfy strict typing.
                            // Log full error to console for debugging.
                            console.error(`[polling] Failed to persist lastCommentId for subscription ${sub._id} (guild ${sub.guildId}, channel ${sub.channelId}):`, saveErr);
                        }

                    } catch (subErr) {
                        console.error(`[polling] Error processing subscription ${sub._id} for comment ${comment.id}:`, subErr);
                    }
                }
            } catch (err) {
                console.error(`[polling] Error processing comment ${comment.id}:`, err);
            } finally {
                try {
                    const res = await CommitCommentCheckpoint.updateOne(
                        { _id: 'global', lastProcessedCommentId: { $lt: comment.id } },
                        { $set: { lastProcessedCommentId: comment.id } },
                        { upsert: true }
                    );
                    if (res.modifiedCount > 0 || res.upsertedCount > 0) {
                        console.log(`[polling] Checkpoint advanced to comment ${comment.id}.`);
                    }
                    if (comment.id > lastSuccessfullyProcessedId) {
                        lastSuccessfullyProcessedId = comment.id;
                    }
                } catch (updErr) {
                    console.error(`[polling] Failed to update global checkpoint for comment ${comment.id}:`, updErr);
                }
            }
        }

        if (lastSuccessfullyProcessedId > cp.lastProcessedCommentId) {
            await CommitCommentCheckpoint.findByIdAndUpdate('global', { $set: { lastProcessedCommentId: lastSuccessfullyProcessedId } })
                .catch(err => console.error('[polling] Failed to persist final batch checkpoint update:', err));
        }

    } catch (error) {
        console.error('Failed to check new commit comments:', error);
    }
}

/**
 * Processes a single commit comment, typically triggered by a webhook.
 * It fetches the full comment data (to include attachments), finds all relevant subscriptions,
 * builds the message payload, and sends it to the appropriate channels. It also updates
 * the global checkpoint to prevent the poller from processing the same comment again.
 * @param client The Discord client instance.
 * @param comment The GitHub comment object from the webhook payload or poller.
 */
export async function processSingleCommitComment(client: Client, comment: GitHubComment) {
    // The comment from the webhook payload doesn't have attachments.
    // We need to fetch the full comment data from its API URL to get them.
    let fullComment: GitHubComment;
    try {
        const commentResponse = await fetchWithToken(comment.url, undefined, true);
        if (!commentResponse.ok) {
            console.error(`Failed to fetch full comment data for ${comment.id}: ${commentResponse.status}`);
            fullComment = comment; // Proceed with the partial data from the webhook
        } else {
            fullComment = await commentResponse.json() as GitHubComment;
        }
    } catch (error) {
        console.error(`Error fetching full comment for webhook event ${comment.id}:`, error);
        fullComment = comment; // Fallback to original comment data on error
    }

    const subs = await Subscription.find({ type: SubscriptionType.PREVIEWS });
    if (!subs.length) return;

    const byChan = new Map<string, (typeof subs)>();
    subs.forEach(s => {
        byChan.set(s.channelId, [...(byChan.get(s.channelId) || []), s]);
    });

    for (const [chanId, arr] of byChan) {
        const ch = await client.channels.fetch(chanId).catch(() => null);
        if (!(ch instanceof TextChannel || ch instanceof NewsChannel)) continue;

        for (const sub of arr) {
            if (sub.lastCommentId && fullComment.id <= sub.lastCommentId) continue;

            const allRolesForSub = await RoleMentionsHandler.find({
                guildId: ch.guild.id,
                type: SubscriptionType.PREVIEWS,
                value: { $regex: `^${sub._id}:` }
            });

            const sections = parseSections(fullComment.body);

            const payload = await buildCommitCommentPayload({
                sha: fullComment.commit_id,
                commentId: fullComment.id,
                commentUrl: fullComment.html_url,
                author: fullComment.user.login,
                authorUrl: fullComment.user.html_url,
                body: fullComment.body,
                createdAt: fullComment.created_at,
                roleMentions: {},
                attachments: fullComment.attachments || [],
                allRolesForSub,
                isNewComment: true // Webhook comments are always new
            }, sections);

            try {
                const sent = await ch.send({
                    components: payload.components,
                    files: payload.files,
                    flags: MessageFlags.IsComponentsV2,
                });

                if (sub.autoPublish && ch instanceof NewsChannel) {
                    await crosspostMessage(sent);
                }

                sub.lastCommentId = fullComment.id;
                await sub.save();
            } catch (err) {
                console.error(`❌ Failed to send webhook preview message to ${ch.id}:`, err);
            }
        }
    }
    
    // Also update the global checkpoint when a message is processed via webhook
    try {
        /** 
         * Atomically update the checkpoint only if the new comment ID is greater.
         * This prevents a race condition where an older webhook might overwrite a newer checkpoint set by the poller or another webhook.
         */
        const result = await CommitCommentCheckpoint.updateOne(
            { _id: 'global', lastProcessedCommentId: { $lt: fullComment.id } },
            { $set: { lastProcessedCommentId: fullComment.id } },
            { upsert: true } // Creates the document if it doesn't exist
        );

        if (result.modifiedCount > 0 || result.upsertedCount > 0) {
            console.log(`[webhook] Checkpoint advanced to ${fullComment.id}`);
        }
    } catch (error) {
        console.error('Failed to update global checkpoint from webhook:', error);
    }
}