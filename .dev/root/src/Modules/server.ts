import express, { type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { Client } from "discord.js";
import mongoose from "mongoose";
import type { InstallationType } from "../Config/config.js";
import type { readConfig } from "../Config/config.js";
import { OAuthInstallation } from "../Models/OAuthInstallation.js";
import {
  dispatchStatusWebhook,
  fetchStatusIncident,
  isStatusProvider,
  normalizeWebhookIncident
} from "./statusService.js";
import { fetchAsGitHubApp } from "../Utils/githubApp.js";
import {
  dispatchPreviewComment,
  type GitHubCommitComment
} from "../Internals/Messages/previewMessage.js";

type Config = ReturnType<typeof readConfig>;

/**
 * Verifies an HMAC-SHA256 webhook signature using constant-time comparison.
 * A missing secret intentionally disables verification for local development,
 * while production deployments should always configure the matching secret.
 *
 * @param rawBody Exact unparsed request bytes; never parse or reserialize before verification.
 * @param signatureHeader GitHub or Statuspage signature header value.
 * @param secret Shared HMAC secret.
 * @returns Whether the signature is valid.
 */
function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | string[] | undefined,
  secret: string
): boolean {
  const signature = typeof signatureHeader === "string"
    ? signatureHeader
    : signatureHeader?.[0];
  if (!signature) return false;

  const suppliedHex = signature.replace(/^sha256=/, "");
  const expectedHex = createHmac("sha256", secret).update(rawBody).digest("hex");
  const supplied = Buffer.from(suppliedHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return supplied.length === expected.length &&
    timingSafeEqual(supplied, expected);
}

/**
 * Verifies a Statuspage endpoint credential embedded as a URL query parameter.
 * Statuspage webhook delivery does not provide the GitHub-style HMAC header,
 * so authentication is performed against the exact `token` query value instead.
 *
 * @param suppliedToken Token parsed from the incoming Statuspage webhook URL.
 * @param secret Provider-specific shared token configured in the environment.
 * @returns Whether the supplied and configured tokens match.
 */
function verifyStatusWebhookToken(
  suppliedToken: unknown,
  secret: string | undefined
): boolean {
  if (!secret) return true;
  if (typeof suppliedToken !== "string") return false;

  const supplied = Buffer.from(suppliedToken, "utf8");
  const expected = Buffer.from(secret, "utf8");
  return supplied.length === expected.length &&
    timingSafeEqual(supplied, expected);
}

/**
 * Resolves provider-specific Statuspage URL-token authentication, falling back
 * to one shared status token for compatibility with existing deployments.
 *
 * @param provider Statuspage provider route key.
 * @returns The provider token or shared fallback token.
 */
function getStatusWebhookSecret(
  provider: "discord" | "github" | "cloudflare"
): string | undefined {
  const providerSecrets = {
    discord: process.env.DISCORD_STATUS_WEBHOOK_TOKEN,
    github: process.env.GITHUB_STATUS_WEBHOOK_TOKEN,
    cloudflare: process.env.CLOUDFLARE_STATUS_WEBHOOK_TOKEN
  };
  return providerSecrets[provider]?.trim() || process.env.STATUS_WEBHOOK_SECRET?.trim();
}

const USER_SCOPES = ["identify", "applications.commands", "guilds.members.read", "guilds", "connections"];
const GUILD_SCOPES = [
  "bot",
  "applications.commands",
  "applications.commands.permissions.update",
  "guilds",
  "guilds.members.read",
  "identify",
  "connections"
];

/** Starts the Express server for OAuth installation and callback handling. */
export function startServer(config: Config, client: Client): Server {
  const app = express();
  const pendingStates = new Map<string, InstallationType>();
  const publicDirectoryCandidates = [
    path.resolve(process.cwd(), "root/public"),
    path.resolve(process.cwd(), "public"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public")
  ];
  const publicDirectory =
    publicDirectoryCandidates.find((directory) => existsSync(directory)) ??
    publicDirectoryCandidates[0];

  app.disable("x-powered-by");
  app.use(express.static(publicDirectory));

  app.get("/authorized", (_request: Request, response: Response) => {
    response.sendFile(path.join(publicDirectory, "authorized.html"));
  });

  app.get("/invite", (_request: Request, response: Response) => {
    response.redirect("/install/guild");
  });

  if (process.env.DISCORD_STATUS_WEBHOOK_TOKEN ||
      process.env.GITHUB_STATUS_WEBHOOK_TOKEN ||
      process.env.CLOUDFLARE_STATUS_WEBHOOK_TOKEN ||
      process.env.STATUS_WEBHOOK_SECRET ||
      process.env.GITHUB_WEBHOOK_SECRET) {
    console.log("Webhook authentication is enabled");
  } else {
    console.warn("Webhook secrets are not configured; webhook authentication is currently disabled");
  }

  app.post(
    "/webhooks/status/:provider",
    express.raw({ type: "*/*", limit: "1mb" }),
    async (request: Request, response: Response) => {
      const providerValue = Array.isArray(request.params.provider)
        ? request.params.provider[0]
        : request.params.provider;
      if (!isStatusProvider(providerValue)) {
        response.status(404).json({ error: "Unknown status provider" });
        return;
      }

      const secret = getStatusWebhookSecret(providerValue);
      if (!verifyStatusWebhookToken(request.query.token, secret)) {
        response.status(401).json({ error: "Invalid Statuspage webhook token" });
        return;
      }

      try {
        const payload = JSON.parse((request.body as Buffer).toString("utf8")) as unknown;
        const webhookIncident = normalizeWebhookIncident(payload);
        if (!webhookIncident) {
          response.status(400).json({ error: "Invalid Statuspage webhook payload" });
          return;
        }

        const incident = await fetchStatusIncident(providerValue, webhookIncident.id);
        if (!incident) {
          response.status(502).json({ error: "Could not fetch the canonical incident" });
          return;
        }

        await dispatchStatusWebhook(client, providerValue, incident);
        response.status(202).json({ accepted: true, incidentId: incident.id });
      } catch (error) {
        console.error("Status webhook processing failed", error);
        response.status(500).json({ error: "Status webhook processing failed" });
      }
    }
  );

  app.post(
    "/webhooks/github",
    express.raw({ type: "*/*", limit: "2mb" }),
    async (request: Request, response: Response) => {
      const secret = process.env.GITHUB_WEBHOOK_SECRET;
      if (secret) {
        if (!verifyWebhookSignature(
          request.body as Buffer,
          request.headers["x-hub-signature-256"],
          secret
        )) {
          response.status(401).json({ error: "Invalid GitHub webhook signature" });
          return;
        }
      }

      try {
        const payload = JSON.parse((request.body as Buffer).toString("utf8")) as {
          action?: string;
          comment?: GitHubCommitComment;
          repository?: {
            name: string;
            owner: { login: string };
            full_name: string;
          };
        };
        if (payload.action !== "created" || !payload.comment || !payload.repository) {
          response.status(202).json({ accepted: true, ignored: true });
          return;
        }
        if (request.headers["x-github-event"] !== "commit_comment") {
          response.status(202).json({ accepted: true, ignored: true });
          return;
        }

        const owner = payload.repository.owner.login;
        const repo = payload.repository.name;
        const fullName = `${owner}/${repo}`;
        const configuredRepository = process.env.GITHUB_REPOSITORY?.trim();
        if (configuredRepository && fullName !== configuredRepository) {
          response.status(202).json({
            accepted: true,
            ignored: true,
            reason: "Repository is not configured for Discord Previews"
          });
          return;
        }
        let comment = payload.comment;

        try {
          const fullResponse = await fetchAsGitHubApp(
            payload.comment.url,
            { headers: { Accept: "application/vnd.github+json" } },
            { owner, repo }
          );
          if (fullResponse.ok) {
            comment = await fullResponse.json() as GitHubCommitComment;
          }
        } catch (error) {
          console.warn("[GitHubWebhook] Full comment fetch failed; using webhook payload:", error);
        }

        const sentCount = await dispatchPreviewComment(client, comment, owner, repo);
        response.status(202).json({ accepted: true, commentId: comment.id, sentCount });
      } catch (error) {
        console.error("GitHub webhook processing failed", error);
        response.status(500).json({ error: "GitHub webhook processing failed" });
      }
    }
  );

  app.use(express.json());

  app.get("/health", (_request: Request, response: Response) => {
    response.json({ ok: true });
  });

  app.get("/install/:type", (request: Request, response: Response) => {
    const type = request.params.type as InstallationType;
    if (type !== "user" && type !== "guild") {
      response.status(404).json({ error: "Unknown installation type" });
      return;
    }

    const state = randomBytes(16).toString("hex");
    pendingStates.set(state, type);
    setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000).unref();

    const parameters = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: (type === "user" ? USER_SCOPES : GUILD_SCOPES).join(" "),
      state,
      integration_type: type === "guild" ? "0" : "1"
    });

    if (type === "guild") parameters.set("permissions", config.botPermissions);
    response.redirect(`https://discord.com/oauth2/authorize?${parameters}`);
  });

  app.get("/oauth/callback", async (request: Request, response: Response) => {
    const code = typeof request.query.code === "string" ? request.query.code : null;
    const state = typeof request.query.state === "string" ? request.query.state : null;
    const installationType = state ? pendingStates.get(state) : undefined;

    if (!code || !state || !installationType) {
      response.redirect(303, `${config.successUrl}${config.successUrl.includes("?") ? "&" : "?"}oauth_error=invalid_callback`);
      return;
    }
    pendingStates.delete(state);

    try {
      let tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: config.redirectUri
        })
      });
      if (tokenResponse.status === 429) {
        const retryAfter = Number(tokenResponse.headers.get("retry-after") ?? "1");
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(Math.max(retryAfter, 1), 60) * 1000)
        );
        tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: config.redirectUri
          })
        });
      }
      const tokenBody = await tokenResponse.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        token_type?: string;
      };

      if (!tokenResponse.ok || !tokenBody.access_token) {
        console.error("Discord OAuth token exchange failed", tokenBody);
        response.redirect(303, `${config.successUrl}${config.successUrl.includes("?") ? "&" : "?"}oauth_error=token_exchange_failed`);
        return;
      }

      const identityResponse = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${tokenBody.access_token}` }
      });
      const identity = await identityResponse.json() as { id?: string };

      if (!identityResponse.ok || !identity.id) {
        console.error("Discord OAuth identity request failed", identity);
        response.redirect(303, `${config.successUrl}${config.successUrl.includes("?") ? "&" : "?"}oauth_error=user_identity_failed`);
        return;
      }

      const guildId =
        typeof request.query.guild_id === "string" ? request.query.guild_id : null;
      const scopes = tokenBody.scope?.split(" ") ?? [];
      const tokenExpiresAt =
        typeof tokenBody.expires_in === "number"
          ? new Date(Date.now() + tokenBody.expires_in * 1000)
          : null;

      if (mongoose.connection.readyState === 1) {
        await OAuthInstallation.findOneAndUpdate(
          {
            installationType,
            discordUserId: identity.id,
            guildId: installationType === "guild" ? guildId : null
          },
          {
            $set: {
              applicationId: config.clientId,
              scopes,
              accessToken: tokenBody.access_token,
              refreshToken: tokenBody.refresh_token ?? null,
              tokenExpiresAt
            }
          },
          { upsert: true, setDefaultsOnInsert: true }
        );
      } else {
        console.warn("MongoDB is unavailable; OAuth installation was not persisted.");
      }

      response.redirect(303, config.successUrl);
    } catch (error) {
      console.error("OAuth callback failed", error);
      response.redirect(303, `${config.successUrl}${config.successUrl.includes("?") ? "&" : "?"}oauth_error=callback_failed`);
    }
  });

  return app.listen(config.port, () => {
    console.log(`OAuth server listening at http://localhost:${config.port}`);
  });
}
