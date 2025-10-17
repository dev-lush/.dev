import { Client, Message, NewsChannel, DiscordAPIError } from 'discord.js';
import { Subscription } from '../Models/Subscription.js';

const FIVE_HOURS = 5 * 60 * 60 * 1000;
/**
 * Stores the channel ID and the timestamp when it was rate-limited for publishing.
 * This is an in-memory cache to prevent spamming crosspost attempts to a channel
 * that has hit its hourly limit.
 * @see RATE_LIMIT_DURATION
 */
const rateLimitedChannels = new Map<string, number>();
/**
 * The duration in milliseconds to wait before retrying a rate-limited channel.
 * @default 10 minutes
 */
const RATE_LIMIT_DURATION = 10 * 60 * 1000; // 10 minutes

/**
 * A queue of channels that need to be re-scanned for unpublished messages
 * after a rate limit has expired. The value is the client instance.
 */
const retryQueue = new Map<string, Client>();

/**
 * Processes the retry queue, attempting to republish messages for channels
 * whose rate limit has expired.
 */
async function processRetryQueue() {
  const now = Date.now();
  for (const [channelId, client] of retryQueue.entries()) {
    const rateLimitEnd = rateLimitedChannels.get(channelId);
    if (!rateLimitEnd || now >= rateLimitEnd) {
      console.log(`[AutoPublish] Retrying channel ${channelId} after rate limit.`);
      await republishMessages(client, channelId);
      retryQueue.delete(channelId); // Remove from queue after processing
    }
  }
}

// Periodically check the retry queue.
setInterval(processRetryQueue, 60 * 1000); // Check every minute


/**
 * Safely crossposts a message in an announcement channel.
 * Handles common errors, such as hitting the publish limit, the message already being crossposted,
 * or the message/channel being deleted.
 * @param message The message to crosspost.
 */
export async function crosspostMessage(message: Message): Promise<void> {
  try {
    if (!(message.channel instanceof NewsChannel) || !message.crosspostable) return;
    
    await message.crosspost();
    console.log(`[AutoPublish] Crossposted message ${message.id} in channel ${message.channelId}`);
  } catch (error: any) {
    if (error instanceof DiscordAPIError) {
      switch (error.code) {
        case 20031: // Maximum number of publishes in channel has been reached (10/hr)
          rateLimitedChannels.set(message.channelId, Date.now() + RATE_LIMIT_DURATION);
          retryQueue.set(message.channelId, message.client);
          console.warn(`[AutoPublish] Channel ${message.channelId} is rate-limited. Queued for retry in ${RATE_LIMIT_DURATION / 60000} minutes.`);
          break;
        case 10017: // Unknown publish
          // This can happen if a message is deleted before it's crossposted. Safe to ignore.
          break;
        case 10008: // Unknown Message
        case 10003: // Unknown Channel
          // The message or channel was deleted. Safe to ignore.
          break;
        default:
          console.error(`[AutoPublish] Discord API error when crossposting ${message.id}:`, error);
      }
    } else {
      console.error(`[AutoPublish] Unexpected error when crossposting ${message.id}:`, error);
    }
  }
}

/**
 * Scans announcement channels for recent, unpublished bot messages that appear to be
 * subscription posts and attempts to publish them.
 * This acts as a fallback for any announcements that failed to publish initially.
 * @param client The Discord client instance.
 * @param specificChannelId If provided, only this channel will be scanned.
 */
export async function republishMessages(client: Client, specificChannelId?: string): Promise<void> {
  const now = Date.now();
  // Clear expired rate limits before starting a new run.
  for (const [channelId, timestamp] of rateLimitedChannels.entries()) {
    if (now > timestamp) {
      rateLimitedChannels.delete(channelId);
    }
  }

  const cutoff = now - FIVE_HOURS;

  let channelIds: string[];

  if (specificChannelId) {
    channelIds = [specificChannelId];
  } else {
    const subs = await Subscription.find({ autoPublish: true }).lean().exec();
    channelIds = Array.from(new Set(subs.map(s => s.channelId)));
  }

  if (channelIds.length === 0) return;
  if (!specificChannelId) {
    console.log(`[AutoPublish] Checking ${channelIds.length} announcement channel(s) for unpublished messages...`);
  }

  for (const channelId of channelIds) {
    if (rateLimitedChannels.has(channelId) && !specificChannelId) continue;

    let channel: NewsChannel;
    try {
      const fetchedChannel = await client.channels.fetch(channelId);
      if (!(fetchedChannel instanceof NewsChannel)) continue;
      channel = fetchedChannel;
    } catch (err) {
      console.warn(`[AutoPublish] Could not fetch channel ${channelId}:`, err);
      continue;
    }

    try {
      const fetched = await channel.messages.fetch({ limit: 50 });
      const candidates = Array.from(fetched.values()).filter((msg) => 
        msg.author?.id === client.user?.id &&
        msg.createdTimestamp >= cutoff &&
        (msg as any).interactionMetadata == null && // Skip interaction responses
        msg.crosspostable &&
        isSubscriptionMessage(msg)
      );

      if (candidates.length === 0) continue;

      // Sort oldest-first to publish in chronological order.
      candidates.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      console.log(`[AutoPublish] Found ${candidates.length} unpublished candidate(s) in #${channel.name}. Attempting to publish...`);

      for (const msg of candidates) {
        await crosspostMessage(msg);
      }
    } catch (err) {
      console.error(`[AutoPublish] Error while scanning channel ${channelId}:`, err);
    }
  }
}

/**
 * A heuristic to determine if a message was generated by the subscription system.
 * It checks for buttons linking to discordstatus.com or the GitHub datamining repository.
 * @param message The message to check.
 * @returns True if the message is likely a subscription message, false otherwise.
 */
function isSubscriptionMessage(message: Message): boolean {
  if (!message.components || message.components.length === 0) return false;

  // When examining message components, cast to any[] to avoid TopLevelComponent union typing issues.
  // We expect action rows with components (buttons/selects). Use a safe cast and defensive checks.
  const rows = (message.components as any[]) ?? [];
  try {
    for (const row of rows) {
      const comps = row?.components as any[] | undefined;
      if (comps && comps.length > 0) {
        for (const comp of comps) {
          if (comp.type === 2 && comp.style === 5 && comp.url) { // Button, Link style
            if (comp.url.includes('discordstatus.com') || comp.url.includes('github.com/discord/datamining')) {
              return true;
            }
          }
        }
      }
    }
  } catch {
    // If there's any error while processing components, we assume it's not a subscription message.
  }
  return false;
}