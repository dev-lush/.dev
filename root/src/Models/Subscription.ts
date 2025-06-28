import mongoose, { Schema, Document, model } from 'mongoose';

export enum SubscriptionType {
    COMMIT = 'commit',
    STATUS = 'status',
}

export interface IncidentData {
    incidentId: string;
    messageId: string;
    lastUpdatedAt: Date;
}

export interface ISubscription extends Document {
    userId: string;
    type: SubscriptionType;
    channelId: string;
    autoPublish?: boolean;
    lastCommentId?: string | null;
    lastCommentCreatedAt?: Date | null;
    incidents: IncidentData[];
}

const IncidentSchema = new Schema<IncidentData>({
    incidentId: { type: String, required: true },
    messageId: { type: String, required: true },
    lastUpdatedAt: { type: Date, required: true },
});

const SubscriptionSchema = new Schema<ISubscription>(
    {
        userId: { type: String, required: true, index: true },
        type: { type: String, required: true, enum: Object.values(SubscriptionType) },
        channelId: { type: String, required: true, index: true },
        autoPublish: { type: Boolean, default: false },
        lastCommentId: { type: String, default: null },
        lastCommentCreatedAt: { type: Date, default: null },
        incidents: { type: [IncidentSchema], default: [] },
    },
    { timestamps: true }
);

SubscriptionSchema.index({ channelId: 1, type: 1 });

export const Subscription = model<ISubscription>('Subscription', SubscriptionSchema);