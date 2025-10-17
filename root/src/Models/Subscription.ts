import mongoose, { Schema, Document, model, Types } from 'mongoose';

/**
 * Defines the types of subscriptions available within the application.
 * This is used to differentiate between various notification or data streams
 * that a client can subscribe to.
 *
 * - `PREVIEWS`: Represents a subscription for [Discord Previews](https://github.com/Discord-Datamining/Discord-Datamining) updates.
 * - `STATUS`: Represents a subscription for [Discord Status](https://discordstatus.com) updates.
 */
export enum SubscriptionType {
  PREVIEWS = 'previews',
  STATUS = 'status',
}

/**
 * Interface representing the data structure for a tracked [Discord Status incident](https://discordstatus.com/incidents)
 * within a subscription.
 */
export interface IncidentData {
  incidentId: string;
  messageId?: string;
  lastUpdatedAt: Date;
  lastUpdateId?: string;
}

/**
 * Represents a subscription to incident notifications within a Discord guild.
 * Each subscription is tied to a specific channel and tracks incidents,
 * sending updates as they occur.
 *
 * @property {Types.ObjectId} _id - The unique identifier for the subscription document.
 * @property {string} userId - The Discord ID of the user who created the subscription.
 * @property {string} guildId - The Discord ID of the guild where the subscription is active.
 * @property {SubscriptionType} type - The type of subscription, determining which incidents to report on.
 * @property {string} channelId - The Discord ID of the channel where notifications will be sent.
 * @property {boolean} [autoPublish] - Optional flag to automatically publish incident updates in the channel.
 * @property {Date | null} [lastCommentCreatedAt] - The creation timestamp of the last incident comment processed.
 * @property {number} [lastCommentId] - The ID of the last incident comment processed.
 * @property {IncidentData[]} incidents - An array of data for the incidents being tracked by this subscription.
 * @property {Date} [lastPermissionWarningAt] - The timestamp of the last warning sent due to missing bot permissions in the channel.
 * @property {Date} createdAt - The timestamp when the subscription was created.
 * @property {Date} updatedAt - The timestamp when the subscription was last updated.
 */
export interface ISubscription extends Document {
  _id: Types.ObjectId;
  userId: string;
  guildId: string;
  type: SubscriptionType;
  channelId: string;
  autoPublish?: boolean;
  lastCommentCreatedAt?: Date | null;
  lastCommentId?: number;
  incidents: IncidentData[];
  lastPermissionWarningAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Represents a singleton Mongoose document that serves as a checkpoint for processing GitHub commit comments.
 * This model is used to keep track of the last processed comment, ensuring that the application can
 * resume processing from where it left off without reprocessing old comments.
 *
 * @property {string} _id - The unique identifier for the checkpoint document. It should always be a fixed
 * value like 'global' to ensure there is only one such document in the collection.
 * @property {number} lastProcessedCommentId - The ID of the most recent commit comment that has been
 * successfully processed. This acts as a cursor for the next processing job.
 */
export interface ICommitCommentCheckpoint extends Document {
  _id: string; // Should always be 'global'
  lastProcessedCommentId: number;
}

const IncidentSchema = new Schema<IncidentData>({
  incidentId: { type: String, required: true },
  messageId: { type: String },
  lastUpdatedAt: { type: Date, required: true },
  lastUpdateId: { type: String }
});

const commitCheckpointSchema = new Schema<ICommitCommentCheckpoint>(
  {
    _id: { type: String, default: 'global' },
    lastProcessedCommentId: { type: Number, default: 0 },
  },
  { collection: 'CommitCommentCheckpoint' }
);

const SubscriptionSchema = new Schema<ISubscription>(
  {
    userId: { type: String, index: true },
    guildId: { type: String, required: true, index: true },
    type: { type: String, required: true, enum: Object.values(SubscriptionType) },
    channelId: { type: String, required: true, index: true },
    autoPublish: { type: Boolean, default: false },
    lastCommentCreatedAt: { type: Date, default: null },
    lastCommentId: { type: Number, default: null },
    incidents: { type: [IncidentSchema], default: [] },
    lastPermissionWarningAt: { type: Date, default: null },
  },
  { timestamps: true }
);

SubscriptionSchema.index({ guildId: 1, channelId: 1, type: 1 });

/**
 * Mongoose model for the `CommitCommentCheckpoint` collection.
 *
 * This model is used to store a checkpoint, typically the timestamp or ID of the last
 * processed commit comment. This prevents the application from re-processing comments
 * that have already been handled.
 *
 * The pattern `mongoose.models.CommitCommentCheckpoint || mongoose.model(...)` ensures
 * that the model is not recompiled on every module import, which is a common issue
 * in development environments with hot-reloading (e.g., Next.js) and prevents an
 * `OverwriteModelError`.
 *
 * @constant CommitCommentCheckpoint
 * @type {mongoose.Model<ICommitCommentCheckpoint>}
 */
export const CommitCommentCheckpoint: mongoose.Model<ICommitCommentCheckpoint> =
  mongoose.models.CommitCommentCheckpoint ||
  mongoose.model<ICommitCommentCheckpoint>('CommitCommentCheckpoint', commitCheckpointSchema);

export const Subscription = mongoose.models.Subscription ||
  model<ISubscription>('Subscription', SubscriptionSchema);

/**
 * Sets the global checkpoint to a specific commit comment ID.
 * If no checkpoint document exists, it creates one.
 * @param commentId The GitHub commit comment ID to set as the last processed one.
 */
export async function setCheckpoint(commentId: number) {
  let doc = await CommitCommentCheckpoint.findById('global');
  if (!doc) {
    doc = new CommitCommentCheckpoint({ _id: 'global', lastProcessedCommentId: commentId });
  } else {
    doc.lastProcessedCommentId = commentId;
  }
  await doc.save();
  console.log('Checkpoint set to comment ID:', doc.lastProcessedCommentId);
}