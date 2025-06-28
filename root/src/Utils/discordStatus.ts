import { Client, TextChannel, NewsChannel, Message } from "discord.js";
import fetch from "node-fetch";
import { Subscription, IncidentData } from "../Models/Subscription.js";
import { formatDiscordTimestamps } from "../Utils/timestamp.js";
import { RoleMentionsHandler } from "../Models/RoleMentionsHandler.js";

export interface Incident {
    id: string;
    name: string;
    short_link: string;
    status: string;
    impact: string;
    updates: IncidentUpdate[];
    affected_components: AffectedComponent[];
    created_at: string;
    updated_at: string;
}

export interface IncidentUpdate {
    status: string;
    body: string;
    created_at: string;
    display_at: string;
    affected_components: AffectedComponent[];
}

export interface AffectedComponent {
    name: string;
    status: string;
}

const API_URL = "https://discordstatus.com/api/v2/incidents.json";

/** Color mapping for different impact levels */
const colorMap: Record<string, number> = {
    minor: 0xFEE75C,
    major: 0xE67E22,
    critical: 0xED4245,
    none: 0x2C2F33,
    resolved: 0x57F287,
};

/**
 * Fetch all incidents from Discord Status API
 */
export async function fetchIncidents(): Promise<Incident[]> {
    try {
        const res = await fetch(API_URL);
        if (!res.ok) {
            console.error(`Discord Status API returned ${res.status} ${res.statusText}`);
            return [];
        }
        const json = await res.json() as { incidents: Incident[] };
        return json.incidents || [];
    } catch (err) {
        console.error("Failed fetching incidents:", err);
        return [];
    }
}

/**
 * Build raw components array (Container V2 JSON) for a given incident and its updates
 */
function buildComponents(incident: Incident): any[] {
    const header = {
        type: 10,
        content: `# <:Discord_Staff:1303532855888183306> Discord Status\n${incident.name}\n-# This incident affected: ${formatComponents(incident.affected_components)}`
    };

    const blocks = [
        header,
        { type: 14, spacing: 2 }
    ];

    for (const update of incident.updates) {
        const { relative, longDate, shortTime } = formatDiscordTimestamps(new Date(update.created_at));

        const statusHeader = `## ${capitalize(update.status)}`;
        const statusBody = update.body;
        const footer = `-# Posted ${relative}. ${longDate} - ${shortTime}`;

        blocks.push({ type: 10, content: `${statusHeader}\n${statusBody}\n${footer}` });
        blocks.push({ type: 14, spacing: 2 });
    }

    blocks.push({ type: 14, spacing: 2 });

    const actionRow = {
        type: 1,
        components: [
            {
                type: 2,
                style: 5,
                label: "discordstatus.com/incidents",
                emoji: { id: "1303532855888183306", name: "Discord_Staff", animated: false },
                url: incident.short_link,
                custom_id: `link_${incident.id}`
            }
        ]
    };

    return [{ type: 17, components: [...blocks, actionRow] }];
}

/** Format affected components list into human-readable string */
function formatComponents(comps: AffectedComponent[]): string {
    const names = comps.map(c => c.name);
    if (names.length === 0) return "None";
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    const last = names.pop();
    return `${names.join(', ')}, and ${last}`;
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Process and sync incidents for a given channel subscription
 */
export async function handleIncidents(client: Client, sendChannelId: string) {
    const incidents = await fetchIncidents();
    if (!incidents.length) return;

    const subs = await Subscription.find({ type: 'status', channelId: sendChannelId });

    for (const sub of subs) {
        const channel = await client.channels.fetch(sendChannelId) as TextChannel | NewsChannel;
        if (!channel || !channel.guildId) continue;

        // Retrieve all role-mention mappings for this guild & 'status'
        const roleRecords = await RoleMentionsHandler.getRoleMentionsByGuildAndType(channel.guildId, 'status');

        for (const incident of incidents) {
            const existing = sub.incidents.find(i => i.incidentId === incident.id);
            const latestUpdate = new Date(incident.updated_at);

            // Build the mention string by matching the incident's impact
            const pings = roleRecords
                .filter(rm => rm.value.toLowerCase() === incident.impact.toLowerCase())
                .map(rm => `<@&${rm.roleId}>`)
                .join(' ');

            if (existing) {
                const lastStored = existing.lastUpdatedAt;
                if (latestUpdate > lastStored) {
                    if (incident.status === 'resolved' && lastStored >= latestUpdate) continue;

                    try {
                        const msg = await channel.messages.fetch(existing.messageId) as Message;
                        const components = buildComponents(incident);
                        await msg.edit({ components });

                        if (pings.length > 0) {
                            await channel.send({ content: pings });
                        }

                        existing.lastUpdatedAt = latestUpdate;
                        await sub.save();
                    } catch (err) {
                        console.error(`Failed editing incident ${incident.id}:`, err);
                    }
                }
            } else {
                try {
                    const components = buildComponents(incident);
                    const message = await channel.send({ components, flags: 32768 });

                    if (pings.length > 0) {
                        await channel.send({ content: pings });
                    }

                    const data: IncidentData = {
                        incidentId: incident.id,
                        messageId: message.id,
                        lastUpdatedAt: latestUpdate
                    };
                    sub.incidents.push(data);
                    await sub.save();
                } catch (err) {
                    console.error(`Failed sending new incident ${incident.id}:`, err);
                }
            }
        }
    }
}