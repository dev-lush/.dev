import { NewsChannel, MessageFlags } from "discord.js";
import fetch from "node-fetch";
import { formatDiscordTimestamps } from "./time.js";
import { RoleMentionsHandler } from "../Models/RoleMentionsHandler.js";
import { crosspostMessage } from "./autoPublisher.js";
const INCIDENTS_API_URL = "https://discordstatus.com/api/v2/incidents.json";
const MAINTENANCES_API_URL = "https://discordstatus.com/api/v2/scheduled-maintenances.json";
const UNRESOLVED_INCIDENTS_API_URL = "https://discordstatus.com/api/v2/incidents/unresolved.json";
const ACTIVE_MAINTENANCES_API_URL = "https://discordstatus.com/api/v2/scheduled-maintenances/active.json";
const SINGLE_INCIDENT_API_URL = "https://discordstatus.com/api/v2/incidents/"; // Needs /:id.json
/**
 * A map of incident impacts/statuses to Discord embed colors.
 */
const colorMap = {
    minor: 0xFEE75C,
    major: 0xE67E22,
    critical: 0xED4245,
    none: 0x2C2F33,
    resolved: 0x57F287,
    completed: 0x57F287,
    maintenance: 0x3498DB,
};
/**
 * Formats an array of affected components into a human-readable string.
 * @param comps Array of affected component objects.
 * @returns A formatted string, e.g., "API and Gateway".
 */
function formatComponents(comps) {
    if (!comps || comps.length === 0)
        return "None";
    const names = comps.map((c) => c.name);
    if (names.length === 1)
        return names[0];
    if (names.length === 2)
        return `${names[0]} and ${names[1]}`;
    const last = names.pop();
    return `${names.join(', ')}, and ${last}`;
}
/**
 * Capitalizes the first letter of a string and replaces underscores with spaces.
 * @param str The input string (e.g., "under_maintenance").
 * @returns The formatted string (e.g., "Under maintenance").
 */
function capitalize(str) {
    const spacedStr = str.replace(/_/g, ' ');
    return spacedStr.charAt(0).toUpperCase() + spacedStr.slice(1);
}
async function fetchAllPaginatedData(baseUrl, dataKey, pageLimit = Infinity) {
    const allItems = [];
    let page = 1;
    let hasMore = true;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1500;
    while (hasMore && page <= pageLimit) {
        const url = `${baseUrl}?page=${page}&per_page=100`;
        let success = false;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const res = await fetch(url);
                if (!res.ok) {
                    // Don't retry on 4xx client errors, but do on 5xx server errors
                    if (res.status >= 500 && attempt < MAX_RETRIES) {
                        console.warn(`Attempt ${attempt} for ${url} failed with status ${res.status}. Retrying...`);
                        await new Promise(res => setTimeout(res, RETRY_DELAY * attempt));
                        continue;
                    }
                    console.error(`Failed to fetch from ${url}: ${res.status}`);
                    hasMore = false; // Stop paginating on persistent error
                    break; // Break from retry loop
                }
                const data = await res.json();
                const items = data[dataKey];
                if (items && items.length > 0) {
                    allItems.push(...items);
                    page++;
                }
                else {
                    hasMore = false;
                }
                success = true;
                break; // Break from retry loop on success
            }
            catch (error) {
                if (attempt < MAX_RETRIES && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) {
                    console.warn(`Attempt ${attempt} failed for ${url} with ${error.code}. Retrying in ${RETRY_DELAY / 1000}s...`);
                    await new Promise(res => setTimeout(res, RETRY_DELAY * attempt));
                    continue;
                }
                console.error(`Error fetching paginated data from ${url}:`, error);
                hasMore = false; // Stop paginating on persistent error
                break; // Break from retry loop
            }
        }
        if (!success) {
            hasMore = false; // Ensure we stop if all retries fail
        }
    }
    return allItems;
}
/**
 * Fetches all historical incidents and maintenances from the Discord Status API, handling pagination.
 * @param pageLimit The maximum number of pages to fetch, as a safeguard.
 * @returns A promise that resolves to an array of all incidents, sorted by creation date.
 */
export async function fetchIncidents(pageLimit = 25) {
    try {
        const [incidentsData, maintenancesData] = await Promise.all([
            fetchAllPaginatedData(INCIDENTS_API_URL, 'incidents', pageLimit),
            fetchAllPaginatedData(MAINTENANCES_API_URL, 'scheduled_maintenances', pageLimit)
        ]);
        // De-duplicate incidents that might appear in both lists (e.g., a past maintenance)
        const allItemsMap = new Map();
        [...incidentsData, ...maintenancesData].forEach(item => {
            if (item) { // Ensure item is not null/undefined before setting
                allItemsMap.set(item.id, item);
            }
        });
        const allItems = Array.from(allItemsMap.values());
        allItems.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        return allItems;
    }
    catch (error) {
        console.error('❌ Failed to fetch incidents and maintenances:', error);
        return [];
    }
}
/**
 * Fetches only the currently active/unresolved incidents and maintenances.
 * @returns A promise that resolves to an array of active incidents.
 */
export async function fetchActiveIncidents() {
    try {
        const [unresolvedRes, activeMaintRes] = await Promise.all([
            fetch(UNRESOLVED_INCIDENTS_API_URL),
            fetch(ACTIVE_MAINTENANCES_API_URL)
        ]);
        if (!unresolvedRes.ok)
            console.error(`Failed to fetch unresolved incidents: ${unresolvedRes.status}`);
        if (!activeMaintRes.ok)
            console.error(`Failed to fetch active maintenances: ${activeMaintRes.status}`);
        const unresolvedData = unresolvedRes.ok ? await unresolvedRes.json() : { incidents: [] };
        const activeMaintData = activeMaintRes.ok ? await activeMaintRes.json() : { scheduled_maintenances: [] };
        const allItems = [...unresolvedData.incidents, ...activeMaintData.scheduled_maintenances];
        allItems.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        return allItems;
    }
    catch (error) {
        console.error('❌ Failed to fetch active incidents and maintenances:', error);
        return [];
    }
}
/**
 * Builds a rich, multi-part Discord message component payload for a given incident.
 * @param incident The incident object.
 * @param forceOriginalColor If true, uses the incident's impact color even if it's resolved.
 * @returns A message component payload object.
 */
export function buildStatusContainer(incident, forceOriginalColor = false) {
    const blocks = [];
    const isMaintenance = !!incident.scheduled_for || incident.name.toLowerCase().includes('maintenance');
    let headerContent = `# <:Discord_Status:1430905087127191674> Discord Status\n${incident.name}`;
    // Consolidate all affected components from the incident and its updates
    const allComponents = new Set();
    if (incident.affected_components) {
        incident.affected_components.forEach(c => allComponents.add(c.name));
    }
    if (incident.incident_updates) {
        incident.incident_updates.forEach(update => {
            if (update.affected_components) {
                update.affected_components.forEach(c => allComponents.add(c.name));
            }
        });
    }
    if (allComponents.size > 0) {
        const affectedText = isMaintenance ? 'This scheduled maintenance affected' : 'This incident affected';
        const formattedComponents = formatComponents(Array.from(allComponents).map(name => ({ name, status: '' })));
        headerContent += `\n-# ${affectedText}: ${formattedComponents}`;
    }
    blocks.push({ type: 10, content: headerContent });
    blocks.push({ type: 14, spacing: 2 });
    if (incident.incident_updates && incident.incident_updates.length > 0) {
        const sortedUpdates = [...incident.incident_updates].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        // Count occurrences of each status to determine if numbering is needed
        const statusCounts = {};
        for (const update of sortedUpdates) {
            statusCounts[update.status] = (statusCounts[update.status] || 0) + 1;
        }
        // Group consecutive updates by status
        const groupedUpdates = [];
        if (sortedUpdates.length > 0) {
            let currentGroup = { status: sortedUpdates[0].status, updates: [sortedUpdates[0]] };
            for (let i = 1; i < sortedUpdates.length; i++) {
                const update = sortedUpdates[i];
                if (update.status === currentGroup.status) {
                    currentGroup.updates.push(update);
                }
                else {
                    groupedUpdates.push(currentGroup);
                    currentGroup = { status: update.status, updates: [update] };
                }
            }
            groupedUpdates.push(currentGroup);
        }
        const statusCounters = {}; // Persistent counters for each status type
        // Process each group of updates
        for (let i = 0; i < groupedUpdates.length; i++) {
            const group = groupedUpdates[i];
            const needsNumbering = statusCounts[group.status] > 1;
            if (!needsNumbering) {
                // This status only appears once in the entire incident, so no numbering.
                const update = group.updates[0];
                const timestamps = formatDiscordTimestamps(new Date(update.display_at || update.created_at));
                const posted = `-# Posted ${timestamps.relative}. ${timestamps.longDate} - ${timestamps.shortTime}`;
                blocks.push({
                    type: 10,
                    content: `## ${capitalize(update.status)}\n${update.body}\n${posted}`
                });
            }
            else {
                // This status appears multiple times, so we need to number the updates.
                blocks.push({ type: 10, content: `## ${capitalize(group.status)}` });
                for (let j = 0; j < group.updates.length; j++) {
                    const update = group.updates[j];
                    statusCounters[group.status] = (statusCounters[group.status] || 0) + 1;
                    const updateNum = statusCounters[group.status];
                    const timestamps = formatDiscordTimestamps(new Date(update.display_at || update.created_at));
                    const posted = ` -# Posted ${timestamps.relative}. ${timestamps.longDate} - ${timestamps.shortTime}`;
                    const content = `### Update #${updateNum}\n- ${update.body}\n${posted}`;
                    blocks.push({ type: 10, content });
                    // Add an invisible separator between sub-updates in the same group
                    if (j < group.updates.length - 1) {
                        blocks.push({ type: 14, divider: false });
                    }
                }
            }
            // Add a visible separator between different status groups
            if (i < groupedUpdates.length - 1) {
                blocks.push({ type: 14, spacing: 1 });
            }
        }
    }
    else {
        const timestamps = formatDiscordTimestamps(new Date(incident.created_at));
        const posted = `-# Posted ${timestamps.relative}. ${timestamps.longDate} - ${timestamps.shortTime}`;
        blocks.push({
            type: 10,
            content: `## ${capitalize(incident.status)}\nNo detailed updates available.\n${posted}`
        });
    }
    const buttonEmoji = isMaintenance
        ? { id: "1406555813874634772", name: "Utilities" }
        : { id: "1404064140066291723", name: "Bug" };
    blocks.push({ type: 14, spacing: 2 }, {
        type: 1,
        components: [{
                type: 2,
                style: 5,
                label: "discordstatus.com/incidents",
                emoji: buttonEmoji,
                url: `https://discordstatus.com/incidents/${incident.id}`
            }]
    });
    const lowerImpact = incident.impact?.toLowerCase() ?? 'none';
    const lowerStatus = incident.status.toLowerCase();
    let accent;
    const isResolved = lowerStatus === 'resolved' || lowerStatus === 'completed';
    if (isResolved && !forceOriginalColor) {
        accent = colorMap.resolved;
    }
    else if (lowerImpact !== 'none' && colorMap[lowerImpact]) {
        accent = colorMap[lowerImpact];
    }
    else if (isMaintenance) {
        accent = colorMap.maintenance;
    }
    else {
        accent = colorMap.none;
    }
    return {
        type: 17,
        components: blocks,
        accent_color: accent
    };
}
/**
 * Determines the appropriate role mention pings for an incident based on a subscription's settings.
 * @param incident The incident object.
 * @param subscription The subscription configuration.
 * @returns A string of role mentions, or undefined if none apply.
 */
export async function getStatusMentionPings(incident, subscription) {
    const pings = new Set();
    const isMaintenance = !!incident.scheduled_for || incident.name.toLowerCase().includes('maintenance');
    const impact = incident.impact ? capitalize(incident.impact.toLowerCase()) : 'None';
    const keysToFetch = [
        `${subscription._id}:universal`,
        isMaintenance ? `${subscription._id}:Maintenance` : `${subscription._id}:Incident`,
        `${subscription._id}:${impact}`
    ];
    const records = await RoleMentionsHandler.find({
        guildId: subscription.guildId,
        type: subscription.type,
        value: { $in: keysToFetch }
    });
    const roleMap = new Map(records.map(r => [r.value, `<@&${r.roleId}>`]));
    // Add in order: universal, category, impact
    if (roleMap.has(keysToFetch[0]))
        pings.add(roleMap.get(keysToFetch[0]));
    if (roleMap.has(keysToFetch[1]))
        pings.add(roleMap.get(keysToFetch[1]));
    if (roleMap.has(keysToFetch[2]))
        pings.add(roleMap.get(keysToFetch[2]));
    const uniquePings = [...pings];
    return uniquePings.length > 0 ? uniquePings.join(' ') : undefined;
}
/**
 * Constructs the final Discord message payload for an incident, including the container and any mentions.
 * @param incident The incident object.
 * @param mention An optional string of role mentions to include.
 * @returns A complete Discord message payload object.
 */
export function buildStatusPayload(incident, mention) {
    const container = buildStatusContainer(incident);
    const payload = {
        components: [container]
    };
    if (mention) {
        payload.components.push({ type: 10, content: mention });
    }
    return payload;
}
/**
 * The core logic for handling status updates for a single subscription.
 * It fetches active incidents, compares them to the incidents already tracked by the subscription,
 * and then sends new messages, edits existing ones, or marks them as resolved.
 * @param client The Discord client instance.
 * @param subscription The subscription document to process.
 * @param incidents An optional, pre-fetched list of active incidents to process.
 */
export async function handleIncidents(client, subscription, incidents) {
    try {
        const channel = await client.channels.fetch(subscription.channelId).catch(() => null);
        if (!channel) {
            // If channel is gone, the subscription will be cleaned up by the orphaned sub cleaner.
            return;
        }
        const activeIncidents = incidents ?? await fetchActiveIncidents();
        const trackedIncidents = [...subscription.incidents];
        let wasModified = false;
        const activeIncidentIds = new Set(activeIncidents.map(i => i.id));
        const trackedIncidentIds = new Set(trackedIncidents.map(i => i.incidentId));
        // 1. Process new incidents
        for (const incident of activeIncidents) {
            if (!trackedIncidentIds.has(incident.id)) {
                // This is a new, active incident.
                console.log(`✅ New incident ${incident.id} detected for channel ${channel.id}`);
                const mentionString = await getStatusMentionPings(incident, subscription);
                const payload = buildStatusPayload(incident, mentionString);
                try {
                    const sent = await channel.send({
                        components: payload.components,
                        flags: MessageFlags.IsComponentsV2
                    });
                    if (subscription.autoPublish && channel instanceof NewsChannel) {
                        await crosspostMessage(sent);
                    }
                    subscription.incidents.push({
                        incidentId: incident.id,
                        messageId: sent.id,
                        lastUpdatedAt: new Date(incident.updated_at),
                        lastUpdateId: incident.incident_updates?.[0]?.id
                    });
                    wasModified = true;
                }
                catch (err) {
                    console.error(`❌ Failed to create message for new incident ${incident.id} in channel ${channel.id}:`, err);
                }
            }
        }
        // 2. Process updates for currently tracked incidents
        for (const tracked of trackedIncidents) {
            const activeVersion = activeIncidents.find(i => i.id === tracked.incidentId);
            if (activeVersion) {
                // Incident is still active, check for updates.
                const lastUpdateId = activeVersion.incident_updates?.[0]?.id;
                if (tracked.lastUpdateId !== lastUpdateId && tracked.messageId) {
                    console.log(`🔄 Updating incident ${activeVersion.id} for channel ${channel.id}`);
                    const mentionString = await getStatusMentionPings(activeVersion, subscription);
                    const payload = buildStatusPayload(activeVersion, mentionString);
                    try {
                        const message = await channel.messages.fetch(tracked.messageId);
                        await message.edit({
                            components: payload.components,
                            flags: MessageFlags.IsComponentsV2
                        });
                        tracked.lastUpdatedAt = new Date(activeVersion.updated_at);
                        tracked.lastUpdateId = lastUpdateId;
                        wasModified = true;
                    }
                    catch (err) {
                        console.error(`❌ Failed to update message for incident ${activeVersion.id} in channel ${channel.id}:`, err);
                        if (err.code === 10008) { // Unknown Message
                            // Message was deleted, remove from tracking.
                            subscription.incidents = subscription.incidents.filter(i => i.incidentId !== tracked.incidentId);
                            wasModified = true;
                        }
                    }
                }
            }
        }
        // 3. Process resolved incidents (in tracked but not in active)
        for (const tracked of trackedIncidents) {
            if (!activeIncidentIds.has(tracked.incidentId)) {
                // This incident is no longer active, so it must be resolved/completed.
                console.log(`✅ Incident ${tracked.incidentId} resolved for channel ${channel.id}`);
                if (tracked.messageId) {
                    try {
                        // Fetch the final state of the incident to show the "resolved" update.
                        const finalIncidentRes = await fetch(`${SINGLE_INCIDENT_API_URL}${tracked.incidentId}.json`);
                        if (finalIncidentRes.ok) {
                            const responseData = await finalIncidentRes.json();
                            const finalIncident = responseData.incident;
                            const mentionString = await getStatusMentionPings(finalIncident, subscription);
                            const payload = buildStatusPayload(finalIncident, mentionString);
                            const message = await channel.messages.fetch(tracked.messageId);
                            await message.edit({
                                components: payload.components,
                                flags: MessageFlags.IsComponentsV2
                            });
                        }
                    }
                    catch (err) {
                        console.error(`❌ Failed to send final update for resolved incident ${tracked.incidentId} in channel ${channel.id}:`, err);
                    }
                }
                // Stop tracking the incident.
                subscription.incidents = subscription.incidents.filter(i => i.incidentId !== tracked.incidentId);
                wasModified = true;
            }
        }
        if (wasModified) {
            await subscription.save();
        }
    }
    catch (err) {
        console.error(`❌ Error handling incidents for subscription ${subscription._id}:`, err);
    }
}
// Add RSS/Atom feed support
export async function fetchIncidentFeed() {
    try {
        // Try RSS first
        const rssRes = await fetch('https://discordstatus.com/history.rss');
        if (rssRes.ok) {
            const rssText = await rssRes.text();
            const incidents = parseRSSFeed(rssText);
            if (incidents.length > 0)
                return incidents;
        }
        // Fallback to Atom
        const atomRes = await fetch('https://discordstatus.com/history.atom');
        if (atomRes.ok) {
            const atomText = await atomRes.text();
            const incidents = parseAtomFeed(atomText);
            if (incidents.length > 0)
                return incidents;
        }
        // Fallback to API if both feeds fail
        return fetchIncidents();
    }
    catch (error) {
        console.error('Failed to fetch incident feed:', error);
        return fetchIncidents();
    }
}
function parseRSSFeed(feed) {
    // Simple RSS parser
    const incidents = [];
    const entries = feed.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const entry of entries) {
        try {
            const id = entry.match(/<guid>([^<]+)<\/guid>/)?.[1] || '';
            const title = entry.match(/<title>([^<]+)<\/title>/)?.[1] || '';
            const description = entry.match(/<description>([^<]+)<\/description>/)?.[1] || '';
            const pubDate = entry.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1] || '';
            const link = entry.match(/<link>([^<]+)<\/link>/)?.[1] || '';
            incidents.push({
                id,
                name: title,
                shortlink: link,
                status: description.includes('Resolved') ? 'resolved' : 'investigating',
                impact: getImpactFromDescription(description),
                created_at: new Date(pubDate).toISOString(),
                updated_at: new Date(pubDate).toISOString(),
                incident_updates: [{
                        id: Math.random().toString(36).substring(2, 15),
                        status: description.includes('Resolved') ? 'resolved' : 'investigating',
                        body: description,
                        created_at: new Date(pubDate).toISOString(),
                        display_at: new Date(pubDate).toISOString()
                    }]
            });
        }
        catch (e) {
            console.error('Failed to parse RSS entry:', e);
        }
    }
    return incidents;
}
function parseAtomFeed(feed) {
    // Simple Atom parser
    const incidents = [];
    const entries = feed.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    for (const entry of entries) {
        try {
            const id = entry.match(/<id>([^<]+)<\/id>/)?.[1] || '';
            const title = entry.match(/<title>([^<]+)<\/title>/)?.[1] || '';
            const content = entry.match(/<content[^>]*>([^<]+)<\/content>/)?.[1] || '';
            const updated = entry.match(/<updated>([^<]+)<\/updated>/)?.[1] || '';
            const link = entry.match(/rel="alternate"[^>]*href="([^"]+)"/)?.[1] || '';
            incidents.push({
                id,
                name: title,
                shortlink: link,
                status: content.includes('Resolved') ? 'resolved' : 'investigating',
                impact: getImpactFromDescription(content),
                created_at: new Date(updated).toISOString(),
                updated_at: new Date(updated).toISOString(),
                incident_updates: [{
                        id: Math.random().toString(36).substring(2, 15),
                        status: content.includes('Resolved') ? 'resolved' : 'investigating',
                        body: content,
                        created_at: new Date(updated).toISOString(),
                        display_at: new Date(updated).toISOString()
                    }]
            });
        }
        catch (e) {
            console.error('Failed to parse Atom entry:', e);
        }
    }
    return incidents;
}
function getImpactFromDescription(desc) {
    if (desc.toLowerCase().includes('critical'))
        return 'critical';
    if (desc.toLowerCase().includes('major'))
        return 'major';
    if (desc.toLowerCase().includes('minor'))
        return 'minor';
    return 'none';
}
export async function fetchIncidentById(incidentId) {
    try {
        const url = `${SINGLE_INCIDENT_API_URL}${incidentId}.json`;
        const res = await fetch(url);
        if (!res.ok) {
            console.error(`Failed to fetch incident ${incidentId} from ${url}: ${res.status}`);
            return null;
        }
        const data = await res.json();
        return data.incident;
    }
    catch (error) {
        console.error(`❌ Failed to fetch incident ${incidentId}:`, error);
        return null;
    }
}
