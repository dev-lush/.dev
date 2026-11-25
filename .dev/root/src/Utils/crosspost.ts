import { Message, NewsChannel } from "discord.js";

/**
 * Crossposts an announcement message once.
 *
 * Discord rejects an already-crossposted message with API error 40033.
 * That response is an expected delivery state and must not roll back or
 * duplicate persisted webhook progress.
 *
 * @param message Announcement message to crosspost.
 * @param channel Owning announcement channel.
 * @returns True when crossposting succeeded or was already complete.
 */
export async function crosspostOnce(
  message: Message,
  channel: NewsChannel
): Promise<boolean> {
  if (message.flags.has("Crossposted")) return true;

  try {
    await message.crosspost();
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 40033) return true;
    throw error;
  }
}
