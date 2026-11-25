import { NewsChannel, TextChannel, type Client } from "discord.js";
import { RoleMention } from "../Models/RoleMention.js";
import {
  Subscription,
  type SubscriptionDocument
} from "../Models/Subscription.js";
import {
  STATUS_SERVICES,
  buildStatusPayload,
  normalizeStatusText,
  type StatusIncident
} from "../Internals/Messages/statusMessage.js";
import { crosspostOnce } from "../Utils/crosspost.js";

export type StatusProvider = keyof typeof STATUS_SERVICES;

/** Raw fields returned by an Atlassian Statuspage v2 incident endpoint. */
interface StatusApiIncident {
  id: string;
  name: string;
  status: string;
  impact: string;
  shortlink?: string;
  scheduled_for?: string;
  created_at: string;
  updated_at: string;
  affected_components?: Array<{ name: string }>;
  incident_updates?: Array<{
    id: string;
    status: string;
    body: string;
    created_at: string;
    display_at?: string;
    affected_components?: Array<{ name: string }>;
  }>;
}

/** Checks whether a webhook route provider has a configured Statuspage service. */
export function isStatusProvider(value: string): value is StatusProvider {
  return value in STATUS_SERVICES;
}

function normalizeIncident(raw: StatusApiIncident): StatusIncident {
  const components = new Set<string>();
  raw.affected_components?.forEach((component) => components.add(component.name));
  raw.incident_updates?.forEach((update) =>
    update.affected_components?.forEach((component: { name: string }) =>
      components.add(component.name)
    )
  );

  return {
    id: raw.id,
    name: raw.name,
    status: raw.status,
    impact: raw.impact ?? "none",
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    shortlink: raw.shortlink,
    scheduledFor: raw.scheduled_for,
    affectedComponents: [...components],
    updates: [...(raw.incident_updates ?? [])]
      .sort((a, b) => new Date(a.created_at).valueOf() - new Date(b.created_at).valueOf())
      .map((update) => ({
        id: update.id,
        status: update.status,
        body: normalizeStatusText(update.body),
        createdAt: update.created_at,
        displayAt: update.display_at ?? update.created_at
      }))
  };
}

/** Fetches a canonical incident from the Statuspage API after a webhook event. */
export async function fetchStatusIncident(
  provider: StatusProvider,
  incidentId: string
): Promise<StatusIncident | null> {
  const service = STATUS_SERVICES[provider];
  try {
    const response = await fetch(
      `${service.apiBaseUrl}/incidents/${incidentId}.json`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }
    );
    if (response.ok) {
      const data = await response.json() as { incident?: StatusApiIncident };
      if (data.incident) return normalizeIncident(data.incident);
    }
  } catch (error) {
    console.warn(`[statusService] Single-incident lookup failed for ${provider}:`, error);
  }

  // The GitHub and other Statuspage hosts may omit or change the single-item
  // endpoint. Resolve the same ID from the canonical 50-item incident feed.
  const incidents = await fetchStatusIncidents(provider, 50);
  return incidents.find((incident) => incident.id === incidentId) ?? null;
}

/** Fetches recent or active incidents for manual autocomplete and send/recall lookups. */
export async function fetchStatusIncidents(
  provider: StatusProvider,
  limit = 25
): Promise<StatusIncident[]> {
  const service = STATUS_SERVICES[provider];
  const response = await fetch(`${service.apiBaseUrl}/incidents.json`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) return [];
  const data = await response.json() as { incidents?: StatusApiIncident[] };
  return (data.incidents ?? [])
    .slice(0, limit)
    .map(normalizeIncident)
    .sort((a, b) => new Date(b.createdAt).valueOf() - new Date(a.createdAt).valueOf());
}

/** Accepts Statuspage-style incident webhook envelopes as a fallback/manual source. */
export function normalizeWebhookIncident(payload: unknown): StatusApiIncident | null {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as {
    incident?: StatusApiIncident;
    page?: unknown;
    id?: unknown;
    name?: unknown;
  };
  return envelope.incident ??
    (typeof envelope.id === "string" && typeof envelope.name === "string"
      ? envelope as unknown as StatusApiIncident
      : null);
}

/** Resolves universal, event, and impact role mentions for a status incident. */
export async function getStatusMentionPings(
  subscription: SubscriptionDocument,
  incident: StatusIncident
): Promise<string | undefined> {
  const maintenance =
    Boolean(incident.scheduledFor) ||
    incident.name.toLowerCase().includes("maintenance");
  const impact = incident.impact
    ? incident.impact[0].toUpperCase() + incident.impact.slice(1).toLowerCase()
    : "None";

  const mappings = await RoleMention.find({
    guildId: subscription.guildId,
    subscriptionId: subscription._id,
    $or: [
      { type: "universal", category: "universal" },
      { type: "event", category: maintenance ? "Maintenance" : "Incident" },
      { type: "impact", category: impact }
    ]
  });

  return mappings.length
    ? [...new Set(mappings.map((mapping) => `<@&${mapping.roleId}>`))].join(" ")
    : undefined;
}

/** Sends or edits one subscribed status update and tracks the Discord message. */
export async function applyStatusIncident(
  client: Client,
  provider: StatusProvider,
  subscription: SubscriptionDocument,
  incident: StatusIncident
): Promise<void> {
  const channel = await client.channels.fetch(subscription.channelId).catch(() => null);
  if (!(channel instanceof TextChannel || channel instanceof NewsChannel)) return;

  const service = STATUS_SERVICES[provider];
  const mentions = await getStatusMentionPings(subscription, incident);
  const payload = buildStatusPayload(service, incident, mentions);
  const tracked = subscription.trackedIncidents.find(
    (item) => item.incidentId === incident.id
  );
  const latestUpdateId = incident.updates.at(-1)?.id ?? null;
  const isResolved =
    incident.status.toLowerCase() === "resolved" ||
    incident.status.toLowerCase() === "completed";
  if (isResolved && !tracked) return;

  try {
    if (tracked?.messageId) {
      try {
        const message = await channel.messages.fetch(tracked.messageId);
        await message.edit(payload);
      } catch (error) {
        if ((error as { code?: number }).code === 10008) {
          subscription.trackedIncidents =
            subscription.trackedIncidents.filter((item) => item.incidentId !== incident.id);
          await subscription.save();
          return;
        }
        throw error;
      }
      tracked.lastUpdateId = latestUpdateId;
      tracked.lastUpdatedAt = new Date(incident.updatedAt);
      if (["resolved", "completed"].includes(incident.status.toLowerCase())) {
        subscription.trackedIncidents =
          subscription.trackedIncidents.filter((item) => item.incidentId !== incident.id);
      }
    } else {
      const sent = await channel.send(payload);
      if (subscription.autoPublish && channel instanceof NewsChannel) {
        await crosspostOnce(sent, channel);
      }
      subscription.trackedIncidents.push({
        incidentId: incident.id,
        messageId: sent.id,
        lastUpdateId: latestUpdateId,
        lastUpdatedAt: new Date(incident.updatedAt)
      });
    }
    await subscription.save();
  } catch (error) {
    console.error(
      `[statusService] Failed to apply ${service.title} incident ${incident.id} for subscription ${subscription._id}:`,
      error
    );
  }
}

/** Applies one webhook incident to every matching guild subscription. */
export async function dispatchStatusWebhook(
  client: Client,
  provider: StatusProvider,
  incident: StatusIncident
): Promise<void> {
  const subscriptionType = STATUS_SERVICES[provider].subscriptionType;
  const subscriptions = await Subscription.find({
    type: subscriptionType
  });

  await Promise.all(
    subscriptions.map((subscription) =>
      applyStatusIncident(
        client,
        provider,
        subscription as unknown as SubscriptionDocument,
        incident
      )
    )
  );
}
