import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createPrivateKey, createSign } from "node:crypto";

interface TokenCache {
  token: string;
  expiresAt: number;
}

const installationTokens = new Map<number, TokenCache>();
const installationIds = new Map<string, number>();
let privateKeyCache: { source: string; pem: string } | null = null;

/** Loads a GitHub App PEM key from base64, PEM text, or a file path. */
export async function loadGitHubAppPrivateKey(): Promise<string | null> {
  const regularSource = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  const b64Source = process.env.GITHUB_APP_PRIVATE_KEY_B64?.trim();
  let source: string | null = null;

  if (regularSource) {
    source = regularSource
      .trim()
      .replace(/^['"]|['"]$/g, "")
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\r\n/g, "\n")
      .trim();
  } else if (b64Source) {
    source = b64Source.replace(/\s/g, "");
  } else if (process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim()) {
    try {
      source = (await readFile(process.env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8")).trim();
    } catch (error) {
      console.warn("[GitHubApp] Private key file could not be read:", error);
      return null;
    }
  }

  if (!source) return null;
  if (privateKeyCache?.source === source) return privateKeyCache.pem;

  try {
    let pem = source;
    const compactSource = source.replace(/\s/g, "");
    if (!source.includes("-----BEGIN")) {
      if (/^-----BEGIN/.test(source)) return null;
      const der = Buffer.from(compactSource, "base64");
      let encodedAsDer = false;
      for (const derType of ["pkcs1", "pkcs8"] as const) {
        try {
          const key = createPrivateKey({ key: der, format: "der", type: derType });
          pem = key.export({ format: "pem", type: derType }).toString();
          encodedAsDer = true;
          break;
        } catch {
          // Try PKCS#1, then PKCS#8.
        }
      }
      if (!encodedAsDer) {
        const pemBody = compactSource.match(/.{1,64}/g)?.join("\n") ?? compactSource;
        pem = `-----BEGIN RSA PRIVATE KEY-----\n${pemBody}\n-----END RSA PRIVATE KEY-----`;
      }
    }
    createPrivateKey(pem);
    privateKeyCache = { source, pem };
    return pem;
  } catch (error) {
    console.warn("[GitHubApp] Private key is invalid:", error);
    return null;
  }
}

function base64Url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Builds a short-lived GitHub App JSON Web Token. */
export async function buildGitHubAppJwt(): Promise<string> {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey = await loadGitHubAppPrivateKey();
  if (!appId || !privateKey) {
    throw new Error("GitHub App credentials are not configured");
  }

  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId })
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(createPrivateKey(privateKey)).toString("base64");
  const encodedSignature = signature
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${unsigned}.${encodedSignature}`;
}

async function githubRequest(url: string, init: RequestInit = {}): Promise<Response> {
  const jwt = await buildGitHubAppJwt();
  return fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "gitapp.dev",
      ...init.headers,
      Authorization: `Bearer ${jwt}`
    }
  });
}

/** Resolves a repository installation ID, caching successful lookups. */
export async function getGitHubInstallationId(
  owner: string,
  repo: string
): Promise<number | null> {
  const key = `${owner}/${repo}`;
  const cached = installationIds.get(key);
  if (cached) return cached;

  const response = await githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/installation`
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub installation lookup failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as { id: number };
  installationIds.set(key, data.id);
  return data.id;
}

/** Returns a cached installation access token or creates a replacement. */
export async function getGitHubInstallationToken(installationId: number): Promise<string> {
  const cached = installationTokens.get(installationId);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const jwt = await buildGitHubAppJwt();
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "gitapp.dev",
        Authorization: `Bearer ${jwt}`
      }
    }
  );
  if (!response.ok) {
    throw new Error(`GitHub installation token failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as { token: string; expires_at: string };
  installationTokens.set(installationId, {
    token: data.token,
    expiresAt: new Date(data.expires_at).valueOf()
  });
  return data.token;
}

/** Fetches a GitHub API or media URL using repository installation authentication. */
export async function fetchAsGitHubApp(
  url: string,
  init: RequestInit = {},
  options: { owner: string; repo: string }
): Promise<Response> {
  const installationId = await getGitHubInstallationId(options.owner, options.repo);
  if (!installationId) {
    throw new Error(`GitHub App is not installed on ${options.owner}/${options.repo}`);
  }
  const token = await getGitHubInstallationToken(installationId);
  return fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "gitapp.dev",
      ...init.headers,
      Authorization: `Bearer ${token}`
    }
  });
}
