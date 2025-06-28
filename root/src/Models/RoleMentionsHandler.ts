import { Document, Model, Schema, model } from 'mongoose';

export interface IRoleMentionDoc extends Document {
  guildId: string;
  type: 'status' | 'previews';
  value: string;
  roleId: string;
}

// Extend the Model interface to include our static method
interface IRoleMentionsModel extends Model<IRoleMentionDoc> {
  getRoleMentionsByGuildAndType(guildId: string, type: 'status' | 'previews'): Promise<IRoleMentionDoc[]>;
}

const roleMentionSchema = new Schema<IRoleMentionDoc>({
  guildId: { type: String, required: true },
  type: { type: String, enum: ['status', 'previews'], required: true },
  value: { type: String, required: true },
  roleId: { type: String, required: true },
});

// Unique index to prevent duplicate mappings
roleMentionSchema.index({ guildId: 1, type: 1, value: 1 }, { unique: true });

// Static method implementation
roleMentionSchema.statics.getRoleMentionsByGuildAndType = async function(
  guildId: string,
  type: 'status' | 'previews'
) {
  return this.find({ guildId, type });
};

// Export the model with the extended interface
export const RoleMentionsHandler = model<IRoleMentionDoc, IRoleMentionsModel>(
  'RoleMentionsHandler',
  roleMentionSchema
);