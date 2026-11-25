import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * Maps one Discord role to a universal, event, or impact notification category.
 * A document is unique per subscription and category, allowing a role selector
 * with 0-1 values to remove an existing mapping safely.
 */
const RoleMentionSchema = new Schema(
  {
    guildId: {
      type: String,
      required: true,
      index: true
    },
    subscriptionId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true
    },
    type: {
      type: String,
      enum: ["universal", "event", "impact"],
      required: true
    },
    category: {
      type: String,
      required: true
    },
    roleId: {
      type: String,
      required: true
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

RoleMentionSchema.index(
  { guildId: 1, subscriptionId: 1, type: 1, category: 1 },
  { unique: true }
);

export const RoleMention =
  mongoose.models.RoleMention ??
  mongoose.model("RoleMention", RoleMentionSchema);
