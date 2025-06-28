import { Schema, model } from 'mongoose';
const roleMentionSchema = new Schema({
    guildId: { type: String, required: true },
    type: { type: String, enum: ['status', 'previews'], required: true },
    value: { type: String, required: true },
    roleId: { type: String, required: true },
});
// Unique index to prevent duplicate mappings
roleMentionSchema.index({ guildId: 1, type: 1, value: 1 }, { unique: true });
// Static method implementation
roleMentionSchema.statics.getRoleMentionsByGuildAndType = async function (guildId, type) {
    return this.find({ guildId, type });
};
// Export the model with the extended interface
export const RoleMentionsHandler = model('RoleMentionsHandler', roleMentionSchema);
