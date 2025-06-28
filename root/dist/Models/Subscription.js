import { Schema, model } from 'mongoose';
export var SubscriptionType;
(function (SubscriptionType) {
    SubscriptionType["COMMIT"] = "commit";
    SubscriptionType["STATUS"] = "status";
})(SubscriptionType || (SubscriptionType = {}));
const IncidentSchema = new Schema({
    incidentId: { type: String, required: true },
    messageId: { type: String, required: true },
    lastUpdatedAt: { type: Date, required: true },
});
const SubscriptionSchema = new Schema({
    userId: { type: String, required: true, index: true },
    type: { type: String, required: true, enum: Object.values(SubscriptionType) },
    channelId: { type: String, required: true, index: true },
    autoPublish: { type: Boolean, default: false },
    lastCommentId: { type: String, default: null },
    lastCommentCreatedAt: { type: Date, default: null },
    incidents: { type: [IncidentSchema], default: [] },
}, { timestamps: true });
SubscriptionSchema.index({ channelId: 1, type: 1 });
export const Subscription = model('Subscription', SubscriptionSchema);
