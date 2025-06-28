import mongoose, { Schema } from 'mongoose';
const PreviewRoleMentionSchema = new Schema({
    guildId: { type: String, required: true, unique: true },
    roles: {
        type: Map,
        of: String,
        default: {}
    }
});
export const PreviewRoleMention = mongoose.model('PreviewRoleMention', PreviewRoleMentionSchema);
