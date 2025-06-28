export function formatDiscordTimestamps(date: Date): {
  relative: string;
  longDate: string;
  shortTime: string;
} {
  const timestampSeconds = Math.floor(date.getTime() / 1000);

  return {
    relative: `<t:${timestampSeconds}:R>`,
    longDate: `<t:${timestampSeconds}:D>`,
    shortTime: `<t:${timestampSeconds}:t>`
  };
}