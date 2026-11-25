import mongoose from "mongoose";

const { Schema } = mongoose;

export enum SubscriptionType {
  DiscordStatus = "discord-status",
  CloudflareStatus = "cloudflare-status",
  GitHubStatus = "github-status",
  DiscordPreviews = "discord-previews"
}

/**
 * Persists one guild/channel subscription for status, preview, and delivery state.
 *
 * The unique compound index prevents duplicate service subscriptions for the same
 * channel. Incident and comment checkpoints remain on the same document so a
 * webhook replay can be deduplicated without a separate polling checkpoint.
 */
const SubscriptionSchema = new Schema(
  {
    creatorId: {
      type: String,
      required: true
    },
    guildId: {
      type: String,
      required: true
    },
    channelId: {
      type: String,
      required: true
    },
    type: {
      type: String,
      enum: Object.values(SubscriptionType),
      required: true
    },
    autoPublish: {
      type: Boolean,
      default: false
    },
    lastPermissionWarningAt: {
      type: Date,
      default: null
    },
    trackedIncidents: {
      type: [
        {
          incidentId: { type: String, required: true },
          messageId: { type: String, required: true },
          lastUpdateId: { type: String, default: null },
          lastUpdatedAt: { type: Date, default: null }
        }
      ],
      default: []
    },
    lastPreviewCommentId: {
      type: Number,
      default: 0
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

SubscriptionSchema.index(
  { guildId: 1, channelId: 1, type: 1 },
  {
    unique: true,
    name: "unique_guild_channel_subscription_type"
  }
);
SubscriptionSchema.index({ guildId: 1 });

export type SubscriptionDocument = {
  _id: unknown;
  creatorId: string;
  guildId: string;
  channelId: string;
  type: SubscriptionType;
  autoPublish: boolean;
  createdAt: Date;
  lastPermissionWarningAt: Date | null;
  trackedIncidents: Array<{
    incidentId: string;
    messageId: string;
    lastUpdateId: string | null;
    lastUpdatedAt: Date | null;
  }>;
  lastPreviewCommentId: number;
  save(): Promise<unknown>;
};

export const Subscription =
  mongoose.models.Subscription ??
  mongoose.model("Subscription", SubscriptionSchema);
