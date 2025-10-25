/**
 * @file
 * Utility helpers for building and encoding Discord audit log reasons.
 *
 * - Builds a default "Executed on behalf of <@user-id>" prefix for every action.
 * - Supports an optional custom reason that appears below the "Executed..." line.
 * - Produces a URL-encoded value ready for the X-Audit-Log-Reason header and truncates safely to 512 bytes.
 *
 * Usage:
 *  - For discord.js methods that accept a reason (ban, kick, timeout):
 *      const reasonPlain = buildAuditLogReasonPlain(interaction.user.id, interaction.options.getString('reason'));
 *      await member.timeout(ms, reasonPlain);
 *
 *  - For raw REST calls (any other action), add the header:
 *      const headers = getAuditLogHeaders(interaction.user.id, interaction.options.getString('reason'));
 *      await fetch(`${DISCORD_API}/channels/${channel.id}`, { method: 'PATCH', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ ... }) });
 */
export const AUDIT_LOG_REASON_HEADER = 'X-Audit-Log-Reason';
export const AUDIT_LOG_REASON_LIMIT_BYTES = 512;
/**
 * Build the plain (unencoded) audit log reason string.
 * @example
 *   ```md
 *   With reason executed on behalf of <@userId>:
 *   <optional custom reason on next line>
 *   ```
 *
 * @param userId The user id to attribute the execution to.
 * @param customReason Optional user-provided reason.
 * @returns plain reason (unencoded, may be truncated to fit byte limit after encoding)
 */
export function buildAuditLogReasonPlain(userId, customReason) {
    const executed = `executed on behalf of <@${userId}>`;
    if (!customReason || customReason.trim().length === 0) {
        return executed;
    }
    // Place custom reason below the executed line.
    const combined = `${executed}:\n‘${customReason.trim()}’`;
    // We'll not naively assume encode length; return combined and let encode/truncate handle bytes.
    return combined;
}
/**
 * URL-encodes and truncates a plain reason so that the final encoded header fits within Discord's limit.
 * Uses encodeURIComponent for encoding.
 *
 * @param plain The plain reason text to encode.
 * @param limitBytes Maximum allowed bytes for the header after encoding (default: AUDIT_LOG_REASON_LIMIT_BYTES).
 * @returns The URL-encoded string safe to set as the X-Audit-Log-Reason header.
 */
export function buildAuditLogReasonHeaderValue(plain, limitBytes = AUDIT_LOG_REASON_LIMIT_BYTES) {
    // Quick path: if encoded size already fits, return it.
    let encoded = encodeURIComponent(plain);
    if (Buffer.byteLength(encoded, 'utf8') <= limitBytes) {
        return encoded;
    }
    // Otherwise, we need to truncate the plain string so that encodeURIComponent(truncated) fits.
    // We'll attempt to truncate only the custom reason portion if possible.
    // If plain includes newline, split prefix/extras:
    const newlineIndex = plain.indexOf('\n');
    let prefix = plain;
    let extra = '';
    if (newlineIndex !== -1) {
        prefix = plain.slice(0, newlineIndex); // "executed on behalf <@...>"
        extra = plain.slice(newlineIndex + 1);
    }
    // Start with full prefix (should be small), then attempt to append as much of extra as will fit.
    // We'll binary-search the truncation length for speed.
    const maxExtraLen = extra.length;
    let low = 0;
    let high = maxExtraLen;
    let best = '';
    // Helper that tests byte size after encoding
    const fits = (candidateExtra) => {
        const test = candidateExtra.length > 0 ? `${prefix}\n${candidateExtra}` : prefix;
        const enc = encodeURIComponent(test);
        return Buffer.byteLength(enc, 'utf8') <= limitBytes;
    };
    // If even prefix alone exceeds (very unlikely), progressively trim the prefix.
    if (!fits('')) {
        // Trim prefix until it fits
        let p = prefix;
        while (p.length > 0 && !fits('')) {
            p = p.slice(0, -1);
        }
        // final best is the trimmed prefix
        const final = p;
        return encodeURIComponent(final);
    }
    // Binary search for the largest extra length that fits.
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = extra.slice(0, mid);
        if (fits(candidate)) {
            best = candidate;
            low = mid + 1;
        }
        else {
            high = mid - 1;
        }
    }
    const finalPlain = best.length > 0 ? `${prefix}\n${best}` : prefix;
    return encodeURIComponent(finalPlain);
}
/**
 * Convenience: returns headers object containing the properly encoded X-Audit-Log-Reason header.
 *
 * @param userId The user id to include in "Executed on behalf <@userId>" prefix.
 * @param customReason Optional user-supplied reason (e.g. from the command).
 * @returns {Record<string,string>} headers object; if reason is empty it still returns the Executed prefix encoded.
 */
export function getAuditLogHeaders(userId, customReason) {
    const plain = buildAuditLogReasonPlain(userId, customReason);
    const encoded = buildAuditLogReasonHeaderValue(plain);
    return {
        [AUDIT_LOG_REASON_HEADER]: encoded
    };
}
/**
 * Helper to read the 'reason' option from an interaction if present and produce headers.
 * Useful inside command handlers.
 *
 * @example
 *  const headers = headersFromInteraction(interaction);
 *  await fetch(..., { headers: { Authorization: `Bot ${token}`, 'Content-Type':'application/json', ...headers }});
 */
export function headersFromInteraction(interaction) {
    const custom = interaction.options.getString('reason') ?? undefined;
    return getAuditLogHeaders(interaction.user.id, custom);
}
