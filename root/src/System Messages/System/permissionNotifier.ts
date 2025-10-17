import { Client, Guild, NewsChannel, TextChannel, ChannelType } from 'discord.js';
import { ISubscription } from '../../Models/Subscription.js';

/**
 * The cooldown period in milliseconds between sending permission warnings for the same subscription.
 * @default 24 hours
 */
const WARNING_COOLDOWN = 24 * 60 * 60 * 1000;

/**
 * Checks for missing permissions for a given subscription and warns the user or owner if necessary.
 * This function is designed to be called periodically. It uses a timestamp on the subscription
 * document to prevent spamming warnings.
 * @param client The Discord client instance.
 * @param guild The guild where the subscription exists.
 * @param sub The subscription document to check.
 * @returns A promise that resolves when the check is complete.
 */
export async function warnMissingPerms(
  client: Client,
  guild: Guild,
  sub: ISubscription
): Promise<void> {
  if (sub.lastPermissionWarningAt && Date.now() - sub.lastPermissionWarningAt.getTime() < WARNING_COOLDOWN) {
    return;
  }

  const member = await guild.members.fetchMe().catch(() => null);
  if (!member) return;

  const channel = await guild.channels.fetch(sub.channelId).catch(() => null);
  if (!channel || !(channel instanceof TextChannel || channel instanceof NewsChannel)) return;

  const perms = channel.permissionsFor(member);
  if (!perms) return;

  const missingPerms: string[] = [];
  if (!perms.has('ViewChannel')) missingPerms.push('`View Channel`');
  if (!perms.has('SendMessages')) missingPerms.push('`Send Messages`');
  if (!perms.has('ReadMessageHistory')) missingPerms.push('`Read Message History`');
  if (sub.autoPublish && channel.type === ChannelType.GuildAnnouncement && !perms.has('ManageMessages')) {
    missingPerms.push('`Manage Messages` (for auto-publishing)');
  }

  if (missingPerms.length === 0) return;

  const warningMessage = `## <:Warning:1326742459912425494> Unable to send updates
The application has lost permission(s) to post updates in <#${sub.channelId}>, where a subscription exists.
The app is missing the following permission(s): ${missingPerms.join(', ')}.
Please adjust the app's permissions for it to continue providing updates.`;

  let notified = false;
  const user = await client.users.fetch(sub.userId).catch(() => null);
  if (user) {
    try {
      await user.send({ content: warningMessage });
      notified = true;
    } catch {
      // DM failed, will try owner next
    }
  }

  if (!notified) {
    const guildOwner = await guild.fetchOwner().catch(() => null);
    if (guildOwner && guildOwner.id !== user?.id) {
      try {
        await guildOwner.send({ content: warningMessage });
        notified = true;
      } catch {
        // Owner DMs also failed, log this event
        console.warn(`[permissionNotifier] Could not notify user ${user?.id} or owner ${guildOwner.id} for missing perms in channel ${sub.channelId}.`);
      }
    }
  }

  if (notified) {
    sub.lastPermissionWarningAt = new Date();
    await sub.save().catch(err => console.error(`[permissionNotifier] Failed to save warning timestamp for sub ${sub._id}:`, err));
  }
}