import EventEmitter from 'events';
import { getInstallationIdForRepo } from '../Services/GitHubApp.js';
/**
 * Manages polling for the Discord-Datamining GitHub repository, acting as an
 * intelligent gatekeeper to switch between webhook-driven updates and active polling.
 */
class GitHubUpdateGate extends EventEmitter {
    client;
    pollFn;
    continuousInterval = null;
    temporaryInterval = null;
    temporaryTimeout = null;
    consecutiveEmptyPolls = 0;
    appModeActive = false; // true => rely on webhooks (App installed)
    repoOwner = 'Discord-Datamining';
    repoName = 'Discord-Datamining';
    POLL_INTERVAL_MS = 15_000;
    TEMP_POLL_MAX_DURATION_MS = 15 * 60_000; // 15 minutes safety cap
    RECHECK_APP_MS = 10 * 60_000;
    recheckTimer = null;
    async init(client, pollFn) {
        this.client = client;
        this.pollFn = pollFn;
        await this.evaluateAppMode();
        this.recheckTimer = setInterval(() => this.evaluateAppMode().catch(err => {
            console.warn('[GitHubGate] Failed to re-evaluate app installation:', err);
        }), this.RECHECK_APP_MS);
    }
    async evaluateAppMode() {
        try {
            const id = await getInstallationIdForRepo(this.repoOwner, this.repoName);
            const installed = id != null;
            if (installed && !this.appModeActive) {
                this.appModeActive = true;
                this.stopContinuousPolling();
                console.log('[GitHubGate] GitHub App detected — entering webhook-first mode (polling paused).');
            }
            else if (!installed && this.appModeActive) {
                this.appModeActive = false;
                console.log('[GitHubGate] GitHub App not found — falling back to continuous polling.');
                this.startContinuousPolling();
            }
            else if (!installed && !this.continuousInterval) {
                this.startContinuousPolling();
            }
        }
        catch (err) {
            console.warn('[GitHubGate] Could not determine GitHub App installation:', err);
            this.enableTemporaryPolling();
        }
    }
    startContinuousPolling() {
        if (!this.pollFn || !this.client || this.continuousInterval)
            return;
        this.pollFn(this.client).catch(err => console.error('[GitHubGate] Initial poll failed:', err));
        this.continuousInterval = setInterval(() => {
            if (!this.pollFn || !this.client)
                return;
            this.pollFn(this.client).catch(err => console.error('[GitHubGate] Continuous poll error:', err));
        }, this.POLL_INTERVAL_MS);
        console.log('[GitHubGate] Continuous commit polling started.');
    }
    stopContinuousPolling() {
        if (this.continuousInterval) {
            clearInterval(this.continuousInterval);
            this.continuousInterval = null;
            console.log('[GitHubGate] Continuous commit polling stopped.');
        }
    }
    async requestImmediatePoll() {
        if (!this.pollFn || !this.client)
            return 0;
        try {
            return await this.pollFn(this.client);
        }
        catch (err) {
            console.error('[GitHubGate] Immediate poll failed:', err);
            this.handleTransientError(err);
            throw err;
        }
    }
    enableTemporaryPolling() {
        if (!this.pollFn || !this.client)
            return;
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
            if (!this.pollFn || !this.client)
                return;
            try {
                const processedCount = await this.pollFn(this.client);
                this.consecutiveEmptyPolls = (processedCount > 0) ? 0 : this.consecutiveEmptyPolls + 1;
                if (this.consecutiveEmptyPolls >= MAX_EMPTY_POLLS) {
                    console.log(`[GitHubGate] Backlog cleared (${this.consecutiveEmptyPolls} consecutive empty polls). Disabling temporary polling.`);
                    this.disableTemporaryPollingAndRecheck();
                }
            }
            catch (err) {
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
    disableTemporaryPollingAndRecheck() {
        if (this.temporaryInterval)
            clearInterval(this.temporaryInterval);
        if (this.temporaryTimeout)
            clearTimeout(this.temporaryTimeout);
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
    handleTransientError(err) {
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
 * Manages updates for Discord Status. Relies on webhooks but falls back to
 * polling if webhook signals have not been received for a few minutes.
 */
class StatusUpdateGate {
    client;
    pollFn;
    lastWebhookTimestamp = 0;
    healthCheckTimer;
    pollingInterval;
    isPolling = false;
    POLLING_INTERVAL_MS = 60_000;
    // Prefer error-driven fallback. Keep silence threshold high so we don't
    // assume webhook failure just because incidents are infrequent.
    WEBHOOK_HEALTH_THRESHOLD_MS = 60 * 60_000; // 60 minutes
    temporaryTimeout = null;
    TEMP_POLL_MAX_DURATION_MS = 15 * 60_000; // 15 minutes safety cap
    init(client, pollFn) {
        this.client = client;
        this.pollFn = pollFn;
        this.lastWebhookTimestamp = Date.now();
        this.healthCheckTimer = setInterval(() => this.checkWebhookHealth(), this.POLLING_INTERVAL_MS);
        console.log('[StatusGate] Initialized and watching webhook health.');
    }
    webhookReceived() {
        this.lastWebhookTimestamp = Date.now();
        if (this.isPolling) {
            console.log('[StatusGate] Webhook signal received. Reverting to webhook-first mode.');
            this.stopPolling();
        }
    }
    checkWebhookHealth() {
        if (this.isPolling)
            return;
        const timeSinceLastWebhook = Date.now() - this.lastWebhookTimestamp;
        // Only fall back automatically if we've never seen a webhook (bootstrapping)
        // or if a very long silence has elapsed. Otherwise prefer error-driven fallback.
        if (this.lastWebhookTimestamp === 0 || timeSinceLastWebhook > this.WEBHOOK_HEALTH_THRESHOLD_MS) {
            console.warn(`[StatusGate] No status webhook received in over ${Math.round(this.WEBHOOK_HEALTH_THRESHOLD_MS / 60000)} minutes. Falling back to polling.`);
            this.startPolling();
        }
    }
    startPolling() {
        if (this.isPolling || !this.pollFn || !this.client)
            return;
        this.isPolling = true;
        this.pollFn(this.client).catch(err => console.error('[StatusGate] Initial poll failed:', err));
        this.pollingInterval = setInterval(() => {
            if (!this.pollFn || !this.client)
                return;
            this.pollFn(this.client).catch(err => console.error('[StatusGate] Continuous status poll error:', err));
        }, this.POLLING_INTERVAL_MS);
        console.log('[StatusGate] Started polling for Discord Status updates.');
    }
    stopPolling() {
        if (!this.isPolling)
            return;
        if (this.pollingInterval)
            clearInterval(this.pollingInterval);
        this.pollingInterval = undefined;
        this.isPolling = false;
        console.log('[StatusGate] Stopped polling for Discord Status updates.');
    }
    /**
     * Public API to force the status gate into polling mode.
     * Useful when the webhook was received but processing failed and
     * we want to immediately fallback to polling until the webhook flow recovers.
     */
    enableTemporaryPolling() {
        try {
            if (this.isPolling) {
                // Already polling; reset safety timeout.
                if (this.temporaryTimeout) {
                    clearTimeout(this.temporaryTimeout);
                }
                this.temporaryTimeout = setTimeout(() => {
                    console.warn('[StatusGate] Temporary polling safety timeout reached — stopping temporary polling.');
                    this.stopPolling();
                }, this.TEMP_POLL_MAX_DURATION_MS);
                return;
            }
            // Start polling immediately.
            this.startPolling();
            // Safety timeout to avoid infinite polling if webhooks never recover.
            this.temporaryTimeout = setTimeout(() => {
                console.warn('[StatusGate] Temporary polling safety timeout reached — stopping temporary polling.');
                this.stopPolling();
            }, this.TEMP_POLL_MAX_DURATION_MS);
            console.log('[StatusGate] Temporary polling enabled due to processing error. Will stop when webhook resumes or after timeout.');
        }
        catch (err) {
            console.error('[StatusGate] enableTemporaryPolling error:', err);
        }
    }
    /**
     * Public helper to be called when background processing of an incoming webhook fails.
     * This triggers the temporary polling fallback.
     */
    handleProcessingError(err) {
        try {
            console.warn('[StatusGate] handleProcessingError called - switching to temporary polling fallback.', err);
            this.enableTemporaryPolling();
        }
        catch (e) {
            console.error('[StatusGate] handleProcessingError error:', e);
        }
    }
}
export const gitHubUpdateGate = new GitHubUpdateGate();
export const statusUpdateGate = new StatusUpdateGate();
