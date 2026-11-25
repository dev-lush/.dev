import "dotenv/config";

export type InstallationType = "user" | "guild";

/**
 * Reads and validates environment configuration used by Discord, OAuth,
 * MongoDB, and the HTTP server.
 *
 * @returns A normalized runtime configuration object.
 * @throws When a required Discord credential is absent.
 */
export function readConfig() {
  const required = ["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"] as const;
  const missing = required.filter((name) => !process.env[name]);

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    botToken: process.env.DISCORD_BOT_TOKEN!,
    clientId: process.env.DISCORD_CLIENT_ID!,
    clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    publicKey: process.env.DISCORD_PUBLIC_KEY,
    redirectUri: process.env.OAUTH_REDIRECT_URI ?? "http://localhost:3000/oauth/callback",
    botPermissions: process.env.DISCORD_BOT_PERMISSIONS ?? "3072",
    mongodbUri: process.env.MONGODB_URI,
    port: Number(process.env.PORT ?? 3000),
    successUrl: process.env.OAUTH_SUCCESS_URL ?? "/authorized"
  };
}
