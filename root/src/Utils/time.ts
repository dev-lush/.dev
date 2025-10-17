import { parse, formatDistanceToNow, addSeconds } from 'date-fns';

/**
 * Generates a set of Discord-formatted timestamp strings from a Date object.
 * @param date The Date object to format.
 * @returns An object containing various timestamp formats.
 * @see https://discord.com/developers/docs/reference#message-formatting-timestamp-styles
 */
export function formatDiscordTimestamps(date: Date): {
  shortTime: string;
  longTime: string;
  shortDate: string;
  longDate: string;
  longDate_ShortTime: string;
  longDate_dayofWeek_shortTime: string;
  relative: string;  
} {
  const timestampSeconds = Math.floor(date.getTime() / 1000);

  return {
    shortTime: `<t:${timestampSeconds}:t>`,
    longTime: `<t:${timestampSeconds}:T>`,
    shortDate: `<t:${timestampSeconds}:d>`,
    longDate: `<t:${timestampSeconds}:D>`,
    longDate_ShortTime: `<t:${timestampSeconds}:f>`,
    longDate_dayofWeek_shortTime: `<t:${timestampSeconds}:F>`,
    relative: `<t:${timestampSeconds}:R>`
  };
}

/**
 * Parses a duration string (e.g., "1h 30m", "10m", "5s") into seconds.
 * Supports hours (h), minutes (m), and seconds (s).
 * Handles combined formats like "1h30m15s" and raw numbers as seconds.
 *
 * @param durationStr The string representation of the duration.
 * @returns The total duration in seconds.
 */
export function parseDuration(durationStr: string): number {
  if (!durationStr) {
    return 0;
  }

  // If the input is just a number, treat it as seconds.
  if (/^\d+$/.test(durationStr)) {
    return parseInt(durationStr, 10);
  }

  const regex = /(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)?/gi;
  let totalSeconds = 0;
  let match;

  // Add spaces between numbers and letters to handle formats like "1h30m"
  const spacedStr = durationStr.replace(/(\d+)([a-zA-Z]+)/g, '$1 $2 ');

  while ((match = regex.exec(spacedStr)) !== null) {
    const value = parseInt(match[1], 10);
    const unit = match[2] ? match[2].toLowerCase() : 's'; // Default to seconds if no unit

    if (unit.startsWith('h')) {
      totalSeconds += value * 3600;
    } else if (unit.startsWith('m')) {
      totalSeconds += value * 60;
    } else if (unit.startsWith('s')) {
      totalSeconds += value;
    }
  }

  return totalSeconds;
}

/**
 * Formats a duration in seconds into a human-readable string (e.g., "1 hour, 30 minutes, and 15 seconds").
 *
 * @param totalSeconds The duration in seconds.
 * @returns A human-readable string representation of the duration.
 */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) {
    return "0 seconds";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
  }
  if (seconds > 0) {
    parts.push(`${seconds} second${seconds > 1 ? 's' : ''}`);
  }

  // Join with commas and 'and' for natural language feel
  if (parts.length > 1) {
    const last = parts.pop();
    return `${parts.join(', ')} and ${last}`;
  }

  return parts[0] || "0 seconds";
}

/**
 * Calculates the future date when a timeout or slowmode will end.
 * @param durationInSeconds The duration of the timeout in seconds.
 * @returns A Date object representing the end time.
 */
export function getFutureDate(durationInSeconds: number): Date {
    return addSeconds(new Date(), durationInSeconds);
}