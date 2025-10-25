import EventEmitter from 'events';
import type { Client } from 'discord.js';
import { getInstallationIdForRepo } from '../Services/GitHubApp.js';

/**
 * Represents a function that performs a polling action.
 * These functions are typically used for periodic tasks or checks.
 * @param client The client instance to use for the polling action.
 * @returns A promise that resolves when the polling action is complete.
 */
type GitHubPollFn = (client: Client) => Promise<number>;

/**
 * Manages polling for the Discord-Datamining GitHub repository, acting as an
 * intelligent gatekeeper to switch between webhook-driven updates and active polling.
 */
class GitHubUpdateGate extends EventEmitter {
    private client?: Client;
    private pollFn?: GitHubPollFn;
    private continuousInterval?: NodeJS.Timeout | null = null;
    private temporaryInterval?: NodeJS.Timeout | null = null;
    private temporaryTimeout?: NodeJS.Timeout | null = null;
    private consecutiveEmptyPolls = 0;
    private appModeActive = false; // true => rely on webhooks (App installed)
    private readonly repoOwner = 'Discord-Datamining';
    private readonly repoName = 'Discord-Datamining';
    private readonly POLL_INTERVAL_MS = 15_000;
    private readonly TEMP_POLL_MAX_DURATION_MS = 15 * 60_000; // 15 minutes safety cap
    private readonly RECHECK_APP_MS = 10 * 60_000;
    private recheckTimer?: NodeJS.Timeout | null = null;

    async init(client: Client, pollFn: GitHubPollFn) {
        this.client = client;
        this.pollFn = pollFn;
        await this.evaluateAppMode();
        this.recheckTimer = setInterval(() => this.evaluateAppMode().catch(err => {
            console.warn('[GitHubGate] Failed to re-evaluate app installation:', err);
        }), this.RECHECK_APP_MS);
    }

    private async evaluateAppMode() {
        try {
            const id = await getInstallationIdForRepo(this.repoOwner, this.repoName);
            const installed = id != null;
            if (installed && !this.appModeActive) {
                this.appModeActive = true;
                this.stopContinuousPolling();
                console.log('[GitHubGate] GitHub App detected — entering webhook-first mode (polling paused).');
            } else if (!installed && this.appModeActive) {
                this.appModeActive = false;
                console.log('[GitHubGate] GitHub App not found — falling back to continuous polling.');
                this.startContinuousPolling();
            } else if (!installed && !this.continuousInterval) {
                this.startContinuousPolling();
            }
        } catch (err) {
            console.warn('[GitHubGate] Could not determine GitHub App installation:', err);
            this.enableTemporaryPolling();
        }
    }

    private startContinuousPolling() {
        if (!this.pollFn || !this.client || this.continuousInterval) return;
        this.pollFn(this.client).catch(err => console.error('[GitHubGate] Initial poll failed:', err));
        this.continuousInterval = setInterval(() => {
            if (!this.pollFn || !this.client) return;
            this.pollFn(this.client).catch(err => console.error('[GitHubGate] Continuous poll error:', err));
        }, this.POLL_INTERVAL_MS);
        console.log('[GitHubGate] Continuous commit polling started.');
    }

    private stopContinuousPolling() {
        if (this.continuousInterval) {
            clearInterval(this.continuousInterval);
            this.continuousInterval = null;
            console.log('[GitHubGate] Continuous commit polling stopped.');
        }
    }

    async requestImmediatePoll(): Promise<number> {
        if (!this.pollFn || !this.client) return 0;
        try {
            return await this.pollFn(this.client);
        } catch (err) {
            console.error('[GitHubGate] Immediate poll failed:', err);
            this.handleTransientError(err);
            throw err;
        }
    }

    enableTemporaryPolling() {
        if (!this.pollFn || !this.client) return;
        if (this.continuousInterval) {
            console.log('[GitHubGate] Continuous polling active — temporary polling not started.');
            return;
        }
        if (this.temporaryInterval) {
            console.log('[GitHubGate] Temporary polling is already active.');
            this.consecutiveEmptyPolls = 0; // Reset counter to give it more time
            return;
        }

        this.consecutiveEmptyPolls = 0;
        const MAX_EMPTY_POLLS = 2;

        const runTemporaryPoll = async () => {
            if (!this.pollFn || !this.client) return;
            try {
                const processedCount = await this.pollFn(this.client);
                this.consecutiveEmptyPolls = (processedCount > 0) ? 0 : this.consecutiveEmptyPolls + 1;
                if (this.consecutiveEmptyPolls >= MAX_EMPTY_POLLS) {
                    console.log(`[GitHubGate] Backlog cleared (${this.consecutiveEmptyPolls} consecutive empty polls). Disabling temporary polling.`);
                    this.disableTemporaryPollingAndRecheck();
                }
            } catch (err) {
                console.error('[GitHubGate] Temporary poll failed:', err);
            }
        };

        this.temporaryInterval = setInterval(runTemporaryPoll, this.POLL_INTERVAL_MS);
        runTemporaryPoll(); // Run one immediately

        this.temporaryTimeout = setTimeout(() => {
            console.warn('[GitHubGate] Temporary polling reached max duration. Disabling.');
            this.disableTemporaryPollingAndRecheck();
        }, this.TEMP_POLL_MAX_DURATION_MS);

        console.log('[GitHubGate] Temporary polling enabled. Will stop when backlog is clear or after timeout.');
    }

    private disableTemporaryPollingAndRecheck() {
        if (this.temporaryInterval) clearInterval(this.temporaryInterval);
        if (this.temporaryTimeout) clearTimeout(this.temporaryTimeout);
        this.temporaryInterval = null;
        this.temporaryTimeout = null;
        this.consecutiveEmptyPolls = 0;
        this.evaluateAppMode().catch(err => {
            console.warn('[GitHubGate] Failed to re-evaluate after temporary polling:', err);
        });
        console.log('[GitHubGate] Temporary polling disabled; re-evaluating app-mode.');
    }

    /**
     * Called when a network/transient error is observed when interacting with GitHub.
     * If error looks transient, enable temporary polling so we can recover any missed events.
     */
    handleTransientError(err: any) {
        const code = err?.code || err?.status || err?.name || '';
        const transientCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'];
        if ((typeof code === 'string' && transientCodes.includes(code)) || (err?.message || '').toLowerCase().includes('network') || err?.name === 'FetchError') {
            console.warn(`[GitHubGate] Detected transient network error (${code}) - enabling temporary polling fallback.`);
            this.enableTemporaryPolling();
        }
    }
    
    isAppModeActive = () => this.appModeActive;
}


/**
 * Defines the signature for a function that performs a single status poll.
 * These functions are typically executed periodically to check the status of
 * a service, an API, or an internal state.
 *
 * @param client - The client instance to be used for the polling operation,
 * providing context and necessary methods (e.g., for making API calls or updating status).
 * @returns A promise that resolves when the polling operation is complete.
 */
type StatusPollFn = (client: Client) => Promise<void>;

/**
 * Manages updates for Discord Status. Relies on webhooks but falls back to
 * polling if webhook signals have not been received for a few minutes.
 */
class StatusUpdateGate {
    private client?: Client;
    private pollFn?: StatusPollFn;
    private lastWebhookTimestamp = 0;
    private pollingInterval?: NodeJS.Timeout;
    private isPolling = false;
    private readonly POLLING_INTERVAL_MS = 60_000;
    private temporaryTimeout?: NodeJS.Timeout | null = null;
    private readonly TEMP_POLL_MAX_DURATION_MS = 15 * 60_000; // 15 minutes safety cap

    init(client: Client, pollFn: StatusPollFn) {
        this.client = client;
        this.pollFn = pollFn;
        this.lastWebhookTimestamp = 0;
        console.log('[StatusGate] Initialized.');
    }

    webhookReceived() {
        this.lastWebhookTimestamp = Date.now();
        if (this.isPolling) {
            console.log('[StatusGate] Webhook signal received. Reverting to webhook-first mode.');
            this.stopPolling();
        }
    }

    private startPolling() {
        if (this.isPolling || !this.pollFn || !this.client) return;
        this.isPolling = true;
        this.pollFn(this.client).catch(err => console.error('[StatusGate] Initial poll failed:', err));
        this.pollingInterval = setInterval(() => {
            if (!this.pollFn || !this.client) return;
            this.pollFn(this.client).catch(err => console.error('[StatusGate] Continuous status poll error:', err));
        }, this.POLLING_INTERVAL_MS);
        console.log('[StatusGate] Started polling for Discord Status updates.');
    }

    private stopPolling() {
        if (!this.isPolling) return;
        if (this.pollingInterval) clearInterval(this.pollingInterval);
        this.pollingInterval = undefined;
        this.isPolling = false;
        console.log('[StatusGate] Stopped polling for Discord Status updates.');
    }

    enableTemporaryPolling() {
        try {
            if (this.isPolling) {
                if (this.temporaryTimeout) {
                    clearTimeout(this.temporaryTimeout);
                }
                this.temporaryTimeout = setTimeout(() => {
                    console.warn('[StatusGate] Temporary polling safety timeout reached — stopping temporary polling.');
                    this.stopPolling();
                }, this.TEMP_POLL_MAX_DURATION_MS);
                return;
            }

            this.startPolling();

            this.temporaryTimeout = setTimeout(() => {
                console.warn('[StatusGate] Temporary polling safety timeout reached — stopping temporary polling.');
                this.stopPolling();
            }, this.TEMP_POLL_MAX_DURATION_MS);

            console.log('[StatusGate] Temporary polling enabled due to processing error. Will stop when webhook resumes or after timeout.');
        } catch (err) {
            console.error('[StatusGate] enableTemporaryPolling error:', err);
        }
    }

    /**
     * Public helper to be called when background processing of an incoming webhook fails.
     * This triggers the temporary polling fallback.
     */
    handleProcessingError(err: any) {
        try {
            console.warn('[StatusGate] handleProcessingError called - switching to temporary polling fallback.', err);
            this.enableTemporaryPolling();
        } catch (e) {
            console.error('[StatusGate] handleProcessingError error:', e);
        }
    }
}

export const gitHubUpdateGate = new GitHubUpdateGate();
export const statusUpdateGate = new StatusUpdateGate();