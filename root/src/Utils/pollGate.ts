import EventEmitter from 'events';
import type { Client } from 'discord.js';
import { getInstallationIdForRepo } from '../Services/GitHubApp.js';

/**
 * Represents a function that performs a polling action.
 * These functions are typically used for periodic tasks or checks.
 * @param client The client instance to use for the polling action.
 * @returns A promise that resolves when the polling action is complete.
 */
type PollFn = (client: Client) => Promise<number>;

/**
 * Manages polling for a GitHub repository, acting as an intelligent gatekeeper to
 * switch between webhook-driven updates and active polling.
 *
 * The primary goal of PollGate is to minimize unnecessary API calls by relying on
 * webhooks from an installed GitHub App whenever possible. It dynamically switches
 * between two main states:
 *
 * 1.  **App Mode (Webhook-First)**: When the GitHub App is detected as installed in the
 *     target repository (`appModeActive = true`), continuous polling is stopped. The system
 *     assumes that updates will be received via webhooks. This is the preferred,
 *     efficient mode.
 *
 * 2.  **Continuous Polling Mode**: If the GitHub App is not installed, PollGate falls
 *     back to polling the repository at a regular interval to check for new commits.
 *
 * The class periodically re-evaluates the app's installation status to automatically
 * transition between these modes.
 *
 * @remarks
 * In addition to the two main modes, PollGate implements a **Temporary Polling**
 * mechanism. This is a short-term, frequent polling state that is activated as a
 * safety net under specific conditions, such as:
 * - After a transient network error occurs during a GitHub API call.
 * - If a manually requested poll fails.
 * - If the initial check for the GitHub App installation fails.
 *
 * This temporary polling ensures that no events are missed if a webhook fails to
 * deliver or during periods of network instability. After a configurable duration,
 * temporary polling ceases, and the system re-evaluates the app installation to
 * return to the appropriate long-term mode.
 */
class PollGate extends EventEmitter {
    private client?: Client;
    private pollFn?: PollFn;
    private continuousInterval?: NodeJS.Timeout | null = null;
    private temporaryInterval?: NodeJS.Timeout | null = null;
    private temporaryTimeout?: NodeJS.Timeout | null = null;
    private appModeActive = false; // true => rely on webhooks (App installed)
    private readonly repoOwner = 'Discord-Datamining';
    private readonly repoName = 'Discord-Datamining';
    private readonly POLL_INTERVAL_MS = 15_000;
    private readonly TEMP_POLL_DURATION_MS = 5 * 60_1000; // 5 minutes
    private readonly RECHECK_APP_MS = 10 * 60_1000; // re-check installation every 10 minutes
    private recheckTimer?: NodeJS.Timeout | null = null;

    /**
     * Initializes the polling controller.
     *
     * This method stores the client and the polling function, performs an initial
     * evaluation of the application's mode, and then starts a periodic timer
     * to re-evaluate the mode at a fixed interval.
     *
     * @param client - The main client instance.
     * @param pollFn - The function to execute when polling is active.
     * @returns A promise that resolves once the initial evaluation is complete.
     */
    async init(client: Client, pollFn: PollFn) {
        this.client = client;
        this.pollFn = pollFn;

        await this.evaluateAppMode();

        // start periodic re-check of installation state
            this.recheckTimer = setInterval(() => this.evaluateAppMode().catch(err => {
            console.warn('[PollGate] failed to re-evaluate app installation:', err);
        }), this.RECHECK_APP_MS);
    }

    /**
     * Evaluates the GitHub App installation status for the repository and adjusts the polling strategy.
     *
     * This method checks if the GitHub App is installed for the configured repository.
     * - If the app is installed, it activates `appModeActive`, stops continuous polling, and relies on webhooks.
     * - If the app is not installed (or was uninstalled), it deactivates `appModeActive` and falls back to continuous polling.
     * - On startup, if the app is not installed, it initiates continuous polling.
     * - If an error occurs during the check, it enables temporary polling as a fail-safe mechanism to ensure
     *   data freshness.
     * @private
     * @async
     */
    private async evaluateAppMode() {
        try {
            const id = await getInstallationIdForRepo(this.repoOwner, this.repoName);
            const installed = id != null;
            if (installed && !this.appModeActive) {
                this.appModeActive = true;
                this.stopContinuousPolling();
                console.log('[PollGate] GitHub App detected — entering webhook-first mode (polling paused).');
            } else if (!installed && this.appModeActive) {
                this.appModeActive = false;
                console.log('[PollGate] GitHub App not found — falling back to continuous polling.');
                this.startContinuousPolling();
            } else if (!installed && !this.continuousInterval) {
                // startup case where app not installed
                this.startContinuousPolling();
            } else {
            // no state change
            }
        } catch (err) {
            console.warn('[PollGate] Could not determine GitHub App installation:', err);
            // If we can't check installation, be conservative: enable temporary polling
            this.enableTemporaryPolling(this.TEMP_POLL_DURATION_MS);
        }
    }

    /**
     * Starts the continuous polling mechanism.
     *
     * This method initiates a regular polling cycle. It first checks if a polling
     * function (`pollFn`) and a client instance (`client`) are available, and ensures
     * that polling is not already active by checking for an existing `continuousInterval`.
     *
     * It executes the polling function immediately once upon starting. After the initial
     * run, it sets up an interval to call the polling function repeatedly at a fixed
     * rate defined by `POLL_INTERVAL_MS`.
     *
     * Errors during both the initial and subsequent polls are caught and logged to the console.
     * The interval ID is stored in `this.continuousInterval`, which is also used to
     * prevent multiple polling loops from running simultaneously.
     * @private
     */
    private startContinuousPolling() {
            if (!this.pollFn || !this.client) return;
            if (this.continuousInterval) return; // already running
            // run first immediately
            this.pollFn(this.client).catch(err => {
            console.error('[PollGate] initial poll failed:', err);
        });
        this.continuousInterval = setInterval(() => {
            if (!this.pollFn || !this.client) return;
            this.pollFn(this.client).catch(err => {
                console.error('[PollGate] continuous poll error:', err);
                // On transient errors, enable temporary polling (already running) or leave for handleTransientError
            });
        }, this.POLL_INTERVAL_MS);
        console.log('[PollGate] Continuous commit polling started.');
    }

    /**
     * Stops the continuous polling process.
     *
     * This method checks if a continuous polling interval is active. If so,
     * it clears the interval timer to halt the periodic execution and resets the
     * interval property to null. A confirmation message is logged to the console.
     * @private
     */
    private stopContinuousPolling() {
        if (this.continuousInterval) {
            clearInterval(this.continuousInterval);
            this.continuousInterval = null;
            console.log('[PollGate] Continuous commit polling stopped.');
        }
    }

    /**
     * Request an immediate, one-off poll. Returns when poll completes (or rejects).
     */
    async requestImmediatePoll(): Promise<number> {
        if (!this.pollFn || !this.client) return 0;
        try {
            const processed = await this.pollFn(this.client);
            return processed;
        } catch (err) {
            // propagate error but also trigger fallback behaviour
            console.error('[PollGate] immediate poll failed:', err);
            this.handleTransientError(err);
            throw err;
        }
    }

    /**
     * Enable temporary, frequent polling (used as a fallback after transient network errors or webhook failures).
     * After `durationMs` it will stop and re-evaluate app-mode (so webhooks can resume if available).
     */
    enableTemporaryPolling(durationMs = this.TEMP_POLL_DURATION_MS) {
        if (!this.pollFn || !this.client) return;

        // If continuous polling is already active, nothing to do.
        if (this.continuousInterval) {
            console.log('[PollGate] continuous polling active — temporary polling not started.');
            return;
        }

        // If a temporary interval already running, extend the timeout.
        if (this.temporaryInterval) {
            if (this.temporaryTimeout) {
                clearTimeout(this.temporaryTimeout);
            }
            this.temporaryTimeout = setTimeout(() => this.disableTemporaryPollingAndRecheck(), durationMs);
            console.log('[PollGate] extended temporary polling window by', durationMs, 'ms');
            return;
        }

        // Start temporary interval
        this.temporaryInterval = setInterval(() => {
        if (!this.pollFn || !this.client) return;
        this.pollFn(this.client).catch(err => {
            console.error('[PollGate] temporary poll failed:', err);
        });
        }, this.POLL_INTERVAL_MS);

        // run one immediately
        this.pollFn(this.client).catch(err => {
        console.error('[PollGate] initial temporary poll failed:', err);
        });

        this.temporaryTimeout = setTimeout(() => this.disableTemporaryPollingAndRecheck(), durationMs);
        console.log('[PollGate] Temporary polling enabled for', durationMs, 'ms');
    }

    private disableTemporaryPollingAndRecheck() {
        if (this.temporaryInterval) {
            clearInterval(this.temporaryInterval);
            this.temporaryInterval = null;
        }
        if (this.temporaryTimeout) {
            clearTimeout(this.temporaryTimeout);
            this.temporaryTimeout = null;
        }
        // After temporary polling ends, re-evaluate installation and restore app-mode / continuous mode
        this.evaluateAppMode().catch(err => {
            console.warn('[PollGate] failed to evaluate after temporary polling:', err);
        });
        console.log('[PollGate] Temporary polling disabled; re-evaluating app-mode.');
    }

    /**
     * Called when a network/transient error is observed when interacting with GitHub.
     * If error looks transient, enable temporary polling so we can recover any missed events.
     */
    handleTransientError(err: any) {
        const code = err && (err.code || err.status || err.name) || '';
        const transientCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'];
        // GitHubApiError and other network failures will fall through here — be conservative.
        if (typeof code === 'string' && transientCodes.includes(code)) {
            console.warn('[PollGate] detected transient network error', code, '- enabling temporary polling fallback.');
            this.enableTemporaryPolling();
        } else {
            // also allow enabling temporary polling when unspecified network error occurs
            if (err && (err.message || '').toLowerCase().includes('network') || (err && err.name === 'FetchError')) {
                console.warn('[PollGate] network-like error detected — enabling temporary polling fallback.');
                this.enableTemporaryPolling();
            }
        }
    }

    /**
     * Force re-check if app is installed now.
     */
    async refreshAppMode() {
        await this.evaluateAppMode();
    }

    isAppModeActive() {
        return this.appModeActive;
    }

    // graceful shutdown (clear timers)
    shutdown() {
        if (this.continuousInterval) {
            clearInterval(this.continuousInterval);
            this.continuousInterval = null;
        }
        if (this.temporaryInterval) {
            clearInterval(this.temporaryInterval);
            this.temporaryInterval = null;
        }
        if (this.temporaryTimeout) {
            clearTimeout(this.temporaryTimeout);
            this.temporaryTimeout = null;
        }
        if (this.recheckTimer) {
            clearInterval(this.recheckTimer);
            this.recheckTimer = null;
        }
    }
}

const singleton = new PollGate();
export default singleton;