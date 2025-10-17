import { Schema, model } from 'mongoose';
const roleMentionSchema = new Schema({
    guildId: { type: String, required: true },
    channelId: { type: String, required: true },
    type: { type: String, enum: ['status', 'previews'], required: true },
    value: { type: String, required: true },
    roleId: { type: String, required: true },
});
roleMentionSchema.index({ guildId: 1, type: 1, channelId: 1, value: 1 }, { unique: true });
/**
 * Retrieves all role mention documents for a specific guild and subscription type.
 * @param guildId The ID of the guild.
 * @param type The type of subscription ('status' or 'previews').
 * @returns A promise that resolves to an array of role mention documents.
 */
roleMentionSchema.statics.getRoleMentionsByGuildAndType = async function (guildId, type) {
    return this.find({ guildId, type });
};
/**
 * Retrieves a map of role mentions for a specific guild and subscription type.
 * The map's keys are the mention categories (e.g., 'universal', 'Strings') and
 * the values are the formatted role mention strings (e.g., '<@&12345>').
 * @param guildId The ID of the guild.
 * @param type The type of subscription ('status' or 'previews').
 * @returns A promise that resolves to a record mapping mention categories to role mention strings.
 */
roleMentionSchema.statics.getRoleMentionMap = async function (guildId, type) {
    const records = await this.find({ guildId, type });
    const map = {};
    for (const rec of records) {
        const key = rec.value.includes(':') ? rec.value.split(':')[1] : rec.value;
        map[key] = `<@&${rec.roleId}>`;
    }
    return map;
};
/**
 * Mongoose model for the RoleMentionsHandler collection.
 *
 * Responsible for creating and managing documents related to role mentions,
 * using the `roleMentionSchema`. It is typed with `IRoleMentionDoc` for document instances
 * and `IRoleMentionsModel` for the model's static properties and methods.
 *
 * @model RoleMentionsHandler
 * @see {@link IRoleMentionDoc}
 * @see {@link IRoleMentionsModel}
 * @see {@link roleMentionSchema}
 */
export const RoleMentionsHandler = model('RoleMentionsHandler', roleMentionSchema);
