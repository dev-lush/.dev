import express from 'express';
import crypto from 'crypto';
import * as dotenv from 'dotenv';
import { handleIncidents, fetchActiveIncidents } from './Utils/discordStatus.js';
import { processSingleCommitComment, checkNewCommitComments } from './Utils/commitMessage.js';
import { Subscription, SubscriptionType } from './Models/Subscription.js';
import { TextChannel, NewsChannel, EmbedBuilder } from 'discord.js';
import nacl from 'tweetnacl';
import fetch from 'node-fetch';
import cookieParser from 'cookie-parser';
import { saveUserToken } from './Models/OAuthToken.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { crosspostMessage } from './Utils/autoPublisher.js';
import { gitHubUpdateGate, statusUpdateGate } from './Utils/pollGate.js';
dotenv.config();
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// The 'fonts' directory is at the root of the .dev folder, two levels up from `root/dist`
const fontsDirectory = path.resolve(__dirname, '..', '..', 'fonts');
// The 'public' directory is inside the `root` folder, one level up from `root/dist`
const publicDirectory = path.resolve(__dirname, '..', 'public');
app.use('/fonts', express.static(fontsDirectory));
app.use(express.static(publicDirectory));
app.use(cookieParser());
const { CLIENT_ID, CLIENT_SECRET, GITHUB_WEBHOOK_SECRET, APP_PUBLIC_KEY, BASE_URL: ENV_BASE_URL, PORT } = process.env;
const port = PORT ? parseInt(PORT) : 3000;
const BASE_URL = ENV_BASE_URL || `http://localhost:${port}`;
// Discord API, OAuth2 scopes, and Guild scopes configuration constants.
const DISCORD_API = 'https://discord.com/api/v10';
const OAUTH_SCOPES = [
    'identify',
    'applications.commands',
    'guilds.members.read',
    'guilds',
    'connections'
];
const GUILD_SCOPES = [
    'bot',
    'applications.commands',
    'applications.commands.permissions.update',
    'guilds',
    'guilds.members.read',
    'identify',
    'connections'
];
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
/**
 * OAuth2 entry point. Redirects the user to Discord's authorization screen.
 * A temporary state is stored in a cookie for security.
 */
app.get('/auth', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('oauth_state', state, {
        httpOnly: true,
        maxAge: 1000 * 60 * 5, // 5 minutes
        secure: isProd,
        sameSite: 'lax'
    });
    const url = new URL(`${DISCORD_API}/oauth2/authorize`);
    url.searchParams.append('client_id', CLIENT_ID);
    url.searchParams.append('redirect_uri', REDIRECT_URI);
    url.searchParams.append('response_type', 'code');
    url.searchParams.append('scope', OAUTH_SCOPES.join(' '));
    url.searchParams.append('state', state);
    url.searchParams.append('integration_type', '1');
    res.redirect(url.toString());
});
/**
 * Guild Install (Bot Invite) entry point. Redirects to Discord's authorization
 * screen with scopes and permissions necessary to add the bot to a server.
 */
app.get('/invite', (req, res) => {
    const PERMISSIONS = '2280930363305208';
    const url = new URL(`${DISCORD_API}/oauth2/authorize`);
    url.searchParams.append('client_id', CLIENT_ID);
    url.searchParams.append('scope', GUILD_SCOPES.join(' '));
    url.searchParams.append('permissions', PERMISSIONS);
    res.redirect(url.toString());
});
/**
 * OAuth2 callback endpoint. Handles the authorization code from Discord,
 * exchanges it for an access token, fetches the user's ID, and saves the token.
 */
app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;
    const storedState = req.cookies['oauth_state'];
    // Verify the state to prevent CSRF attacks.
    if (!code || !state || state !== storedState) {
        console.error('OAuth state mismatch:', { expected: storedState, received: state });
        res.status(400).send('Invalid OAuth state. Please try again.');
        return;
    }
    res.clearCookie('oauth_state');
    try {
        // Exchange the authorization code for an access token.
        const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI
            })
        });
        if (!tokenResponse.ok) {
            throw new Error(`Failed to get token: ${await tokenResponse.text()}`);
        }
        const tokenData = await tokenResponse.json();
        const userId = await getUserId(tokenData.access_token);
        // Save the new token to the database.
        await saveUserToken(userId, tokenData.access_token, tokenData.refresh_token, tokenData.expires_in, tokenData.scope.split(' '), tokenData.token_type);
        res.clearCookie('state');
        // Redirect to the success page URL instead of sending the file.
        res.redirect('/auth-success.html');
    }
    catch (error) {
        console.error('OAuth2 callback error:', error);
        res.status(500).send('Internal Server Error');
    }
});
/**
 * Fetches the user's Discord ID using an access token.
 * @param token The user's OAuth2 access token.
 * @returns The user's Discord ID.
 */
async function getUserId(token) {
    const response = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok)
        throw new Error('Failed to get user info');
    const data = await response.json();
    return data.id;
}
/**
 * Handles incoming push payloads from GitHub webhooks.
 */
export async function processPushPayload(client, payload) {
    try {
        const repo = payload?.repository;
        const commits = Array.isArray(payload?.commits) ? payload.commits : [];
        if (!repo || commits.length === 0) {
            return;
        }
        const repoFullName = repo.full_name;
        const repoUrl = repo.html_url;
        const pusher = payload.pusher?.name ?? 'Unknown';
        const ref = payload.ref;
        const branch = ref.startsWith('refs/heads/') ? ref.substring(11) : ref;
        const subs = await Subscription.find({ type: SubscriptionType.PREVIEWS });
        if (subs.length === 0)
            return;
        console.log(`[GitHub Push] Processing ${commits.length} commit(s) for ${repoFullName} to ${subs.length} subscription(s).`);
        const embed = new EmbedBuilder()
            .setColor(0x23272A)
            .setAuthor({ name: `${repoFullName}:${branch}`, iconURL: 'https://i.imgur.com/qG1im1i.png', url: `${repoUrl}/tree/${branch}` })
            .setDescription(commits
            .map((c) => `[\`${c.id.substring(0, 7)}\`](${c.url}) ${c.message.split('\n')[0]}`)
            .join('\n')
            .substring(0, 4000))
            .setFooter({ text: `Pushed by ${pusher}` })
            .setTimestamp(new Date(payload.head_commit?.timestamp ?? Date.now()));
        for (const sub of subs) {
            try {
                const channel = await client.channels.fetch(sub.channelId);
                if (channel instanceof TextChannel || channel instanceof NewsChannel) {
                    const message = await channel.send({ embeds: [embed] });
                    if (sub.autoPublish && channel instanceof NewsChannel) {
                        await crosspostMessage(message);
                    }
                }
            }
            catch (err) {
                console.error(`[GitHub Push] Failed to send message to channel ${sub.channelId} for subscription ${sub._id}:`, err);
            }
        }
    }
    catch (err) {
        console.error('[Webhook] processPushPayload error:', err);
    }
}
/**
 * Express middleware to handle incoming GitHub webhooks.
 * It verifies the HMAC-SHA256 signature and processes the event in the background
 * using `setImmediate` to avoid blocking the response.
 */
const handleGithubWebhook = async (req, res, next) => {
    // --- Add this logging code for debugging ---
    console.log('--- GitHub Webhook Request Received ---');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    // -----------------------------------------
    if (!GITHUB_WEBHOOK_SECRET) {
        console.warn('GitHub webhook secret is not defined.');
        res.status(500).send('Webhook secret not configured.');
        return;
    }
    const sig = req.headers['x-hub-signature-256'];
    if (!sig) {
        res.status(401).send('Signature missing.');
        return;
    }
    // Verify the signature.
    const reqWithRawBody = req;
    const hmac = crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET);
    const digest = `sha256=${hmac.update(reqWithRawBody.rawBody).digest('hex')}`;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest))) {
        res.status(401).send('Signature verification failed.');
        return;
    }
    res.status(200).send('GitHub Webhook received successfully');
    // Process the webhook payload asynchronously.
    setImmediate(async () => {
        const event = req.headers['x-github-event'];
        const client = req.app.get('client');
        const payload = req.body;
        try {
            if (event === 'commit_comment' && payload.action === 'created') {
                console.log(`✅ GitHub webhook: Received new commit comment ${payload.comment.id}`);
                await processSingleCommitComment(client, payload.comment).catch(async (err) => {
                    console.error('Failed to process webhook commit comment:', err);
                    // fallback: enable temporary polling so any missed comments are recovered
                    try {
                        gitHubUpdateGate.enableTemporaryPolling();
                    }
                    catch (e) { /* best-effort */ }
                });
            }
            else if (event === 'push') {
                setImmediate(async () => {
                    try {
                        await checkNewCommitComments(client);
                    }
                    catch (err) {
                        console.error('[Webhook] Error triggering commit comment processing after push:', err);
                        try {
                            gitHubUpdateGate.enableTemporaryPolling();
                        }
                        catch (e) { }
                    }
                });
            }
            else if (event === 'ping') {
                console.log('✅ GitHub webhook ping received successfully.');
            }
        }
        catch (err) {
            console.error('[Webhook] Unexpected error handling GitHub webhook:', err);
            try {
                gitHubUpdateGate.enableTemporaryPolling();
            }
            catch (e) { }
        }
    });
};
/**
 * Express middleware to handle incoming Discord Status webhooks.
 * It verifies the Ed25519 signature and processes the event in the background.
 */
const handleDiscordStatusWebhook = async (req, res, next) => {
    const PUBLIC_KEY = process.env.APP_PUBLIC_KEY;
    if (!PUBLIC_KEY) {
        console.warn('Discord Status public key is not defined.');
        res.status(500).send('Webhook public key not configured.');
        return;
    }
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    const rawBody = req.body;
    if (!signature || !timestamp || !rawBody) {
        res.status(400).send('Missing signature, timestamp, or body.');
        return;
    }
    try {
        // Verify the signature using the public key.
        const isVerified = nacl.sign.detached.verify(Buffer.concat([Buffer.from(timestamp), rawBody]), Buffer.from(signature, 'hex'), Buffer.from(PUBLIC_KEY, 'hex'));
        if (!isVerified) {
            console.error('Discord Status webhook signature verification failed.');
            res.status(401).send('Invalid signature.');
            return;
        }
        try {
            statusUpdateGate.webhookReceived();
        }
        catch (err) {
            console.warn('[Webhook] statusUpdateGate.webhookReceived() failed:', err);
        }
        res.status(200).send('Webhook received successfully.');
        // Process the webhook payload asynchronously.
        setImmediate(async () => {
            try {
                console.log('Discord Status webhook verified, triggering incident handling.');
                const client = req.app.get('client');
                if (!client) {
                    console.error('Client not available in app context for webhook processing.');
                    return;
                }
                const subscriptions = await Subscription.find({ type: SubscriptionType.STATUS });
                if (subscriptions.length === 0) {
                    return; // No subscriptions, nothing to do.
                }
                // Fetch incidents once to avoid redundant API calls
                const activeIncidents = await fetchActiveIncidents();
                // Trigger incident handling for all relevant subscriptions.
                // Process subscriptions sequentially to avoid overwhelming the server with concurrent requests.
                for (const subscription of subscriptions) {
                    await handleIncidents(client, subscription, activeIncidents).catch(err => console.error(`Failed to handle incidents for subscription ${subscription._id}:`, err));
                }
            }
            catch (err) {
                console.error('Error during background processing of Discord Status webhook:', err);
                try {
                    statusUpdateGate.handleProcessingError(err);
                }
                catch (e) { /* best-effort */ }
            }
        });
    }
    catch (error) {
        console.error('Error in Discord Status webhook handler:', error);
        if (!res.headersSent) {
            res.status(500).send('Internal Server Error during webhook processing.');
        }
    }
};
// Route for GitHub webhooks. Uses `express.json` with a verify function to get the raw body for signature checks.
app.post('/webhook/github', express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}), handleGithubWebhook);
// Route for Discord Status webhooks. Uses `express.raw` as the body is needed in its raw form for signature checks.
app.post('/webhook/discordstatus', express.raw({ type: 'application/json' }), handleDiscordStatusWebhook);
// Global error handler for the Express app.
app.use((err, req, res, next) => {
    console.error('Webhook error:', err);
    if (!res.headersSent) {
        res.status(500).send('Internal Server Error');
    }
});
export default app;
