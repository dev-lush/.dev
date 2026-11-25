import {
  ChannelType,
  NewsChannel,
  TextChannel,
  type Client,
  type Guild
} from "discord.js";
import { Subscription, type SubscriptionDocument } from "../Models/Subscription.js";

const WARNING_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Warns the subscription creator, then the guild owner, when the bot cannot
 * deliver updates to a subscribed text or announcement channel.
 */
export async function warnMissingPerms(
  client: Client,
  guild: Guild,
  subscription: SubscriptionDocument
): Promise<boolean> {
  if (subscription.lastPermissionWarningAt &&
      Date.now() - subscription.lastPermissionWarningAt.getTime() < WARNING_COOLDOWN_MS) {
    return false;
  }

  const botMember = await guild.members.fetchMe().catch(() => null);
  if (!botMember) return false;

  const channel = await guild.channels.fetch(subscription.channelId).catch(() => null);
  if (!(channel instanceof TextChannel || channel instanceof NewsChannel)) return false;

  const permissions = channel.permissionsFor(botMember);
  if (!permissions) return false;

  const missing: string[] = [];
  if (!permissions.has("ViewChannel")) missing.push("`View Channel`");
  if (!permissions.has("SendMessages")) missing.push("`Send Messages`");
  if (!permissions.has("ReadMessageHistory")) missing.push("`Read Message History`");
  if (subscription.autoPublish &&
      channel.type === ChannelType.GuildAnnouncement &&
      !permissions.has("ManageMessages")) {
    missing.push("`Manage Messages` (for auto-publishing)");
  }

  if (missing.length === 0) return false;

  const warningMessage = [
    "## Unable to send updates",
    `The application has lost permission to post updates in <#${subscription.channelId}>.`,
    `Missing permission(s): ${missing.join(", ")}.`,
    "Please adjust the application's permissions so delivery can continue."
  ].join("\n");

  let notified = false;
  const creator = await client.users.fetch(subscription.creatorId).catch(() => null);
  if (creator) {
    try {
      await creator.send({ content: warningMessage });
      notified = true;
    } catch {
      // Fall back to the guild owner.
    }
  }

  if (!notified) {
    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) {
      try {
        await owner.send({ content: warningMessage });
        notified = true;
      } catch {
        console.warn(
          `[permissionNotifier] No DM recipient was reachable for guild ${guild.id}, channel ${subscription.channelId}.`
        );
      }
    }
  }

  if (notified) {
    subscription.lastPermissionWarningAt = new Date();
    await subscription.save().catch((error) =>
      console.error(
        `[permissionNotifier] Could not save warning state for subscription ${subscription._id}:`,
        error
      )
    );
  }

  return notified;
}

/** Checks every persisted subscription for a guild. */
export async function warnGuildSubscriptions(
  client: Client,
  guild: Guild
): Promise<void> {
  const subscriptions = await Subscription.find({ guildId: guild.id });
  await Promise.all(
    subscriptions.map((subscription) =>
      warnMissingPerms(client, guild, subscription as SubscriptionDocument)
    )
  );
}
