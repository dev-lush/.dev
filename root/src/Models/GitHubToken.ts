import mongoose, { Schema, Document, model } from 'mongoose';
import dotenv from 'dotenv';
import fetch, { RequestInit, Response } from 'node-fetch';

/**
 * Represents an error that occurred during a GitHub API request.
 * It includes the HTTP status code and status text from the response.
 *
 * @extends Error
 *
 * @param message The error message.
 * @param status The HTTP status code of the failed API response.
 * @param statusText The HTTP status text of the failed API response.
 */
export class GitHubApiError extends Error {
    constructor(message: string, public status: number, public statusText: string) {
        super(message);
        this.name = 'GitHubApiError';
    }
}

/**
 * @interface IGitHubToken
 * @description Represents the structure of a GitHub token document in the database.
 */
export interface IGitHubToken extends Document {
    token: string;
    usageCount: number;
    lastUsed: Date;
    rateLimitRemaining: number;
    rateLimitReset: Date;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Mongoose schema for storing and managing GitHub Personal Access Tokens.
 * This schema tracks token usage, rate limits, and activity status.
 *
 * @property {string} token - The GitHub Personal Access Token string. It is a required and unique field.
 * @property {number} usageCount - The number of times the token has been used. Defaults to 0.
 * @property {Date} lastUsed - The timestamp of the last time the token was used. Defaults to the current date and time.
 * @property {number} rateLimitRemaining - The remaining number of requests allowed by the GitHub API for this token within the current rate limit window. Defaults to 5000.
 * @property {Date} rateLimitReset - The timestamp (in UTC epoch seconds) when the current rate limit window resets. Defaults to the current date and time.
 * @property {boolean} isActive - A flag to determine if the token is currently active and can be used. Defaults to true.
 * @property {Date} createdAt - Automatically managed by Mongoose, records the creation timestamp.
 * @property {Date} updatedAt - Automatically managed by Mongoose, records the last update timestamp.
 */
const GitHubTokenSchema = new Schema<IGitHubToken>(
    {
        token: { type: String, required: true, unique: true },
        usageCount: { type: Number, default: 0 },
        lastUsed: { type: Date, default: Date.now },
        rateLimitRemaining: { type: Number, default: 5000 },
        rateLimitReset: { type: Date, default: Date.now },
        isActive: { type: Boolean, default: true }
    },
    { timestamps: true }
);

export const GitHubToken = mongoose.models.GitHubToken || 
    model<IGitHubToken>('GitHubToken', GitHubTokenSchema);

/**
 * Initializes the GitHub token pool by reading tokens from environment variables
 * (`GITHUB_TOKEN` and `GITHUB_ADDITIONAL_TOKENS`) and adding them to the database.
 */
export async function initializeGitHubTokens(): Promise<void> {
    dotenv.config();
    
    // Get main token
    const mainToken = process.env.GITHUB_TOKEN;
    if (mainToken) {
        await addToken(mainToken).catch(err => {
            if (err.code !== 11000) { // Ignore duplicate key errors
                console.error('Failed to add main GitHub token:', err);
            }
        });
    }

    // Get additional tokens
    const additionalTokens = process.env.GITHUB_ADDITIONAL_TOKENS;
    if (additionalTokens) {
        const tokens = additionalTokens.split(',').map(t => t.trim());
        for (const token of tokens) {
            await addToken(token).catch(err => {
                if (err.code !== 11000) { // Ignore duplicate key errors
                    console.error('Failed to add additional GitHub token:', err);
                }
            });
        }
    }

    // Log the number of available tokens
    const activeTokens = await GitHubToken.countDocuments({ isActive: true });
    console.log(`✅ Initialized ${activeTokens} GitHub tokens`);
}

/**
 * Adds a new GitHub token to the database.
 * @param token The GitHub token string.
 * @returns The created token document.
 */
export async function addToken(token: string): Promise<IGitHubToken> {
    return GitHubToken.create({ token });
}

/**
 * Retrieves the best available GitHub token from the pool.
 * It prioritizes active tokens with remaining rate limit requests.
 * @returns A promise that resolves to a token document, or null if none are available.
 */
export async function getAvailableToken(): Promise<IGitHubToken | null> {
    return GitHubToken.findOne({
        isActive: true,
        $or: [
            { rateLimitRemaining: { $gt: 0 } },
            { rateLimitReset: { $lt: new Date() } }
        ]
    }).sort({ rateLimitRemaining: -1 });
}

/**
 * Updates a token's usage statistics and rate limit information after an API call.
 * @param token The token string that was used.
 * @param remaining The value from the 'x-ratelimit-remaining' header.
 * @param resetTime The value from the 'x-ratelimit-reset' header, converted to a Date.
 */
export async function updateTokenStatus(
    token: string,
    remaining: number,
    resetTime: Date
): Promise<void> {
    await GitHubToken.updateOne(
        { token },
        {
            $inc: { usageCount: 1 },
            $set: {
                lastUsed: new Date(),
                rateLimitRemaining: remaining,
                rateLimitReset: resetTime
            }
        }
    );
}

/**
 * Marks a token as inactive, typically after a 401 Unauthorized error.
 * @param token The token string to deactivate.
 */
export async function deactivateToken(token: string): Promise<void> {
    await GitHubToken.updateOne(
        { token },
        { $set: { isActive: false } }
    );
}

/**
 * Gets the authorization headers for a GitHub API request using an available token.
 * @deprecated This function is less flexible than `fetchWithToken`.
 * @returns A record containing the 'Authorization' header.
 */
export async function getGitHubHeaders(): Promise<Record<string, string>> {
    const token = await getAvailableToken();
    if (!token) {
        throw new Error('No GitHub tokens available');
    }
    return { 'Authorization': `token ${token.token}` };
}

/**
 * A robust wrapper around `node-fetch` for making authenticated GitHub API requests.
 * It automatically handles token selection, rotation, rate limit tracking, request retries
 * on network errors or rate limits, and deactivation of invalid tokens. It also correctly
 * handles attachment download redirects.
 * @param url The URL to fetch.
 * @param init Optional `RequestInit` object for fetch.
 * @param usePreview Whether to use the 'full+json' preview media type for richer data.
 * @returns A promise that resolves to the `Response` object.
 */
export async function fetchWithToken(url: string, init?: RequestInit, usePreview?: boolean): Promise<Response> {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1500; // 1.5 seconds

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const token = await getAvailableToken();
        if (!token) {
            throw new Error('No GitHub tokens available');
        }

        const baseHeaders: Record<string, string> = {
            'Authorization': `token ${token.token}`
        };

        const headers = { ...(init?.headers as Record<string, string>) };

        if (!headers['Accept']) {
            if (isAttachmentUrl(url)) {
                headers['Accept'] = 'application/octet-stream';
            } else if (usePreview) {
                headers['Accept'] = 'application/vnd.github.full+json';
            } else {
                headers['Accept'] = 'application/vnd.github.v3+json';
            }
        }

        let finalHeaders = { ...headers }; // Initialize finalHeaders with the provided headers

        // Conditionally add Authorization header
        if (!url.includes('user-images.githubusercontent.com')) {
            finalHeaders = { ...baseHeaders, ...headers };
        }

        const isAttachmentDownload = isAttachmentUrl(url) || (finalHeaders['Accept'] || '').includes('application/octet-stream');

        try {
            const response = await fetch(url, {
                ...init,
                headers: finalHeaders,
                redirect: isAttachmentDownload ? 'manual' : 'follow'
            });

            const remaining = parseInt(response.headers.get('x-ratelimit-remaining') || '0');
            const resetTime = new Date(parseInt(response.headers.get('x-ratelimit-reset') || '0') * 1000);
            await updateTokenStatus(token.token, remaining, resetTime);

            if (isAttachmentDownload && response.status === 302) {
                const redirectUrl = response.headers.get('location');
                if (!redirectUrl) throw new Error('No redirect URL provided for attachment');
                return fetch(redirectUrl);
            }

            if (!response.ok && response.status !== 302 && response.status !== 304) {
                const body = await response.text().catch(() => 'No response body');
                // Don't log the full body for 403, as it's noisy and expected when a token is exhausted.
                if (response.status !== 403) {
                    console.error(`GitHub API error (${url}):`, { status: response.status, statusText: response.statusText, body });
                }
                throw new GitHubApiError(`GitHub API error: ${response.status} ${response.statusText}`, response.status, response.statusText);
            }

            return response;
        } catch (error: any) {
            // Deactivate token on invalid credentials and retry
            if (error instanceof GitHubApiError && error.status === 401) {
                console.warn(`[fetchWithToken] Token ending in ...${token.token.slice(-4)} is invalid. Deactivating it and retrying.`);
                await deactivateToken(token.token);
                if (attempt < MAX_RETRIES) {
                    continue;
                }
            }
            // Handle rate limit error (403) by retrying with another token without deactivating.
            // The token's rate limit status was already updated by `updateTokenStatus` before the error was thrown.
            else if (error instanceof GitHubApiError && error.status === 403) {
                console.warn(`[fetchWithToken] Token ending in ...${token.token.slice(-4)} was rate-limited. Retrying with another token.`);
                if (attempt < MAX_RETRIES) {
                    continue; // Continue to the next attempt in the loop to get a new token
                }
            }

            // Retry on specific network errors
            if (attempt < MAX_RETRIES && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) {
                console.warn(`Attempt ${attempt} failed for ${url} with ${error.code}. Retrying in ${RETRY_DELAY / 1000}s...`);
                await new Promise(res => setTimeout(res, RETRY_DELAY * attempt));
                continue;
            }
            
            // For all other errors, or if retries are exhausted, fail.
            console.error(`Failed to fetch ${url} after ${attempt} attempts:`, error);
            throw error;
        }
    }
    throw new Error(`Failed to fetch ${url} after ${MAX_RETRIES} retries.`);
}

/**
 * Checks if a URL points to a GitHub attachment that requires special handling.
 * @param url The URL to check.
 * @returns True if the URL is for an attachment download.
 */
function isAttachmentUrl(url: string): boolean {
    return url.includes('/download/') || url.includes('/raw/');
}