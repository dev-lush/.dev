import { Document, Model, Schema, model } from 'mongoose';

/**
 * Represents the Mongoose document structure for a role mention configuration.
 * This configuration links a specific role to be mentioned in a channel
 * based on a trigger type (like 'status' or 'previews') and a corresponding value.
 *
 * @property {string} guildId - The ID of the guild where this configuration is active.
 * @property {string} channelId - The ID of the channel where the role mention will be sent.
 * @property {'status' | 'previews'} type - The type of trigger for the mention.
 *   - 'status': The mention is triggered by a user's presence/status update.
 *   - 'previews': The mention is triggered by a game or event preview.
 * @property {string} value - The specific value that triggers the mention, corresponding to the `type`.
 *   For example, a game name for 'previews' or a specific status message for 'status'.
 * @property {string} roleId - The ID of the Discord role to be mentioned.
 */
export interface IRoleMentionDoc extends Document {
  guildId: string;
  channelId: string;
  type: 'status' | 'previews';
  value: string;
  roleId: string;
}

/**
 * Represents the Mongoose model for Role Mentions.
 * It extends the base Mongoose Model with custom static methods for handling role mention data.
 *
 * @method getRoleMentionsByGuildAndType
 * Fetches all role mention documents matching a specific guild and type.
 * @param {string} guildId The unique identifier of the guild.
 * @param {'status' | 'previews'} type The category of the role mention.
 * @returns {Promise<IRoleMentionDoc[]>} A promise that resolves to an array of `IRoleMentionDoc` documents.
 *
 * @method getRoleMentionMap
 * Creates a key-value map of channel IDs to role IDs for a given guild and type.
 * This is useful for quick lookups without iterating through an array.
 * @param {string} guildId The unique identifier of the guild.
 * @param {'status' | 'previews'} type The category of the role mention.
 * @returns {Promise<Record<string, string>>} A promise that resolves to a Record where keys are channel IDs and values are role IDs.
 */
interface IRoleMentionsModel extends Model<IRoleMentionDoc> {
  getRoleMentionsByGuildAndType(guildId: string, type: 'status' | 'previews'): Promise<IRoleMentionDoc[]>;
  getRoleMentionMap(guildId: string, type: 'status' | 'previews'): Promise<Record<string, string>>;
}

const roleMentionSchema = new Schema<IRoleMentionDoc>({
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
roleMentionSchema.statics.getRoleMentionsByGuildAndType = async function(
  guildId: string,
  type: 'status' | 'previews'
) {
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
roleMentionSchema.statics.getRoleMentionMap = async function(
  guildId: string,
  type: 'status' | 'previews'
) {
  const records = await this.find({ guildId, type });
  const map: Record<string, string> = {};
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
export const RoleMentionsHandler = model<IRoleMentionDoc, IRoleMentionsModel>(
  'RoleMentionsHandler',
  roleMentionSchema
);