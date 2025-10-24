import fetch, { RequestInit, Response } from 'node-fetch';
import fs from 'fs';
import { createSign, createPrivateKey } from 'crypto';
import dotenv from 'dotenv';

if (!process.env.GITHUB_APP_ID) {
    dotenv.config({ override: false });
}

/**
 * Loads and correctly formats the GitHub App private key from environment variables.
 *
 * This function handles multiple ways of providing the key:
 * 1.  `GITHUB_APP_PRIVATE_KEY_B64`: The base64-encoded body of the key. This is what you are using.
 * 2.  `GITHUB_APP_PRIVATE_KEY`: The full PEM key as a string (can handle `\n` escapes).
 * 3.  `GITHUB_APP_PRIVATE_KEY_PATH`: A file path to the `.pem` file.
 *
 * Crucially, if the key is provided as a single-line base64 string, this function will
 * automatically format it by chunking it into 64-character lines and wrapping it with
 * the required PEM headers, resolving the parsing error.
 *
 * @returns The correctly formatted PEM private key as a string, or `null`.
 */
function loadPrivateKey(): string | null {
    let keySource: string | null = null;

    if (process.env.GITHUB_APP_PRIVATE_KEY_B64 && process.env.GITHUB_APP_PRIVATE_KEY_B64.trim()) {
        keySource = process.env.GITHUB_APP_PRIVATE_KEY_B64.trim();
        // This is assumed to be the base64 content of the key. We don't decode it here.
    } else if (process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_PRIVATE_KEY.trim()) {
        keySource = process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
    } else if (process.env.GITHUB_APP_PRIVATE_KEY_PATH && process.env.GITHUB_APP_PRIVATE_KEY_PATH.trim()) {
        try {
            keySource = fs.readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
        } catch (err) {
            console.warn(`[GitHubApp] Failed to read private key from path: ${process.env.GITHUB_APP_PRIVATE_KEY_PATH}`);
            return null;
        }
    }

    if (!keySource) {
        return null;
    }

    keySource = keySource.trim();

    // If it's already a full, valid PEM key, return it as is.
    if (keySource.startsWith('-----BEGIN')) {
        return keySource;
    }
    
    // Otherwise, assume it's the raw base64 body and format it into a valid PEM string.
    // This correctly handles your single-line GITHUB_APP_PRIVATE_KEY_B64 variable.
    const keyBody = keySource.replace(/\s/g, '');
    const chunkedBody = keyBody.match(/.{1,64}/g)?.join('\n') || '';
    
    // GitHub App keys are typically PKCS#1 RSA keys.
    return `-----BEGIN RSA PRIVATE KEY-----\n${chunkedBody}\n-----END RSA PRIVATE KEY-----`;
}

const APP_ID = process.env.GITHUB_APP_ID;
const PRIVATE_KEY = loadPrivateKey();

if (!APP_ID) {
    console.warn('[GitHubApp] Warning: GITHUB_APP_ID not set. GitHub App features will be disabled.');
}

if (!PRIVATE_KEY) {
    console.warn('[GitHubApp] Warning: GITHUB_APP_PRIVATE_KEY / GITHUB_APP_PRIVATE_KEY_PATH not set or unreadable. GitHub App auth disabled.');
}

function base64url(input: string | Buffer) {
    return Buffer.from(input)
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

/**
 * Build an App JWT (RS256). Valid for ~9 minutes.
 */
export function buildAppJWT(): string {
    if (!APP_ID || !PRIVATE_KEY) throw new Error('GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY not configured');

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
        iat: now - 60,
        exp: now + 9 * 60,
        iss: Number(APP_ID),
    };

    const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const keyObject = createPrivateKey(PRIVATE_KEY);
    const signature = signer.sign(keyObject, 'base64');
    const signatureUrl = signature.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${unsigned}.${signatureUrl}`;
}

type TokenCacheEntry = { token: string; expiresAt: number }; // ms epoch
const installationTokenCache = new Map<number, TokenCacheEntry>();
const installationIdCache = new Map<string, number>(); // "owner/repo" -> installationId

async function safeParseJSON(text: string): Promise<any> {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
}

/**
 * List installations for this App.
 */
export async function listAppInstallations(): Promise<any[]> {
    const jwt = buildAppJWT();
    const url = 'https://api.github.com/app/installations';
    const res = await fetch(url, {
        headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gitapp.dev'
        }
    });
    const txt = await res.text();
    if (!res.ok) {
        throw new Error(`Failed to list installations: ${res.status} ${res.statusText} - ${txt}`);
    }
    // parse defensively
    const parsed = await safeParseJSON(txt);
    return Array.isArray(parsed) ? parsed : [];
}

/**
 * Get installation id for an owner/repo.
 * Returns null if not installed or not accessible.
 */
export async function getInstallationIdForRepo(owner: string, repo: string): Promise<number | null> {
    const cacheKey = `${owner}/${repo}`;
    if (installationIdCache.has(cacheKey)) {
        return installationIdCache.get(cacheKey)!;
    }
    const jwt = buildAppJWT();
    const url = `https://api.github.com/repos/${owner}/${repo}/installation`;
    const res = await fetch(url, {
        headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gitapp.dev'
        }
    });
    if (res.status === 404) return null;
    const txt = await res.text();
    if (!res.ok) {
        throw new Error(`Failed to get installation for ${owner}/${repo}: ${res.status} ${res.statusText} - ${txt}`);
    }
    const data: any = await safeParseJSON(txt);
    if (data && typeof data.id === 'number') {
        installationIdCache.set(cacheKey, data.id);
        return data.id;
    }
    return null;
}

/**
 * Get or create an installation access token (cached).
 * installationId: numeric id.
 */
export async function getInstallationToken(installationId: number): Promise<string> {
    const now = Date.now();
    const cached = installationTokenCache.get(installationId);
    if (cached && cached.expiresAt - 30_000 > now) {
        return cached.token;
    }

    const jwt = buildAppJWT();
    const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gitapp.dev'
        }
    });
    const txt = await res.text();
    if (!res.ok) {
        throw new Error(`Failed to create installation token: ${res.status} ${res.statusText} - ${txt}`);
    }
    const data: any = await safeParseJSON(txt);
    if (!data || typeof data.token !== 'string') {
        throw new Error('Invalid installation token response from GitHub');
    }
    const expiresAt = data.expires_at ? new Date(data.expires_at).getTime() : (Date.now() + 50 * 60 * 1000);
    installationTokenCache.set(installationId, { token: data.token, expiresAt });
    return data.token;
}

/**
 * Generic fetch helper that authenticates as the App installation for a repo.
 * If installationId is provided use it; otherwise owner+repo will be resolved.
 * Passes through RequestInit and returns node-fetch Response.
 */
export async function fetchAsApp(
    url: string,
    init: RequestInit = {},
    opts?: { installationId?: number; owner?: string; repo?: string; acceptPreview?: string }
): Promise<Response> {
    if (!PRIVATE_KEY || !APP_ID) {
        throw new Error('GitHub App not configured (GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY missing).');
    }
    let installationId = opts?.installationId;
    if (!installationId) {
        if (!opts?.owner || !opts?.repo) {
        throw new Error('Either installationId or owner+repo must be provided to fetchAsApp.');
        }
        const id = await getInstallationIdForRepo(opts.owner, opts.repo);
        if (!id) throw new Error(`App is not installed on ${opts.owner}/${opts.repo}`);
        installationId = id;
    }

    const token = await getInstallationToken(installationId);
    const headers = Object.assign({}, (init.headers as any) || {}, {
        Authorization: `Bearer ${token}`,
        Accept: opts?.acceptPreview ?? 'application/vnd.github+json',
        'User-Agent': 'gitapp.dev'
    });

    // node-fetch types sometimes conflict in TS projects; cast merged to any to avoid type mismatch.
    const merged: any = Object.assign({}, init, { headers });
    return fetch(url, merged as RequestInit);
}