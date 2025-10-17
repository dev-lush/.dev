import mongoose, { Schema, model } from 'mongoose';
/**
 * Defines the types of subscriptions available within the application.
 * This is used to differentiate between various notification or data streams
 * that a client can subscribe to.
 *
 * - `PREVIEWS`: Represents a subscription for [Discord Previews](https://github.com/Discord-Datamining/Discord-Datamining) updates.
 * - `STATUS`: Represents a subscription for [Discord Status](https://discordstatus.com) updates.
 */
export var SubscriptionType;
(function (SubscriptionType) {
    SubscriptionType["PREVIEWS"] = "previews";
    SubscriptionType["STATUS"] = "status";
})(SubscriptionType || (SubscriptionType = {}));
const IncidentSchema = new Schema({
    incidentId: { type: String, required: true },
    messageId: { type: String },
    lastUpdatedAt: { type: Date, required: true },
    lastUpdateId: { type: String }
});
const commitCheckpointSchema = new Schema({
    _id: { type: String, default: 'global' },
    lastProcessedCommentId: { type: Number, default: 0 },
}, { collection: 'CommitCommentCheckpoint' });
const SubscriptionSchema = new Schema({
    userId: { type: String, index: true },
    guildId: { type: String, required: true, index: true },
    type: { type: String, required: true, enum: Object.values(SubscriptionType) },
    channelId: { type: String, required: true, index: true },
    autoPublish: { type: Boolean, default: false },
    lastCommentCreatedAt: { type: Date, default: null },
    lastCommentId: { type: Number, default: null },
    incidents: { type: [IncidentSchema], default: [] },
    lastPermissionWarningAt: { type: Date, default: null },
}, { timestamps: true });
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
export const CommitCommentCheckpoint = mongoose.models.CommitCommentCheckpoint ||
    mongoose.model('CommitCommentCheckpoint', commitCheckpointSchema);
export const Subscription = mongoose.models.Subscription ||
    model('Subscription', SubscriptionSchema);
/**
 * Sets the global checkpoint to a specific commit comment ID.
 * If no checkpoint document exists, it creates one.
 * @param commentId The GitHub commit comment ID to set as the last processed one.
 */
export async function setCheckpoint(commentId) {
    let doc = await CommitCommentCheckpoint.findById('global');
    if (!doc) {
        doc = new CommitCommentCheckpoint({ _id: 'global', lastProcessedCommentId: commentId });
    }
    else {
        doc.lastProcessedCommentId = commentId;
    }
    await doc.save();
    console.log('Checkpoint set to comment ID:', doc.lastProcessedCommentId);
}
