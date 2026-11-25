import mongoose, { type InferSchemaType } from "mongoose";

const { Schema } = mongoose;

/**
 * Stores the Discord identity and OAuth data associated with a user or guild installation.
 * OAuth credentials should be encrypted at rest in a public deployment. The
 * application currently stores the Discord token fields for future API access,
 * and installation records are unique per installation identity and guild.
 */
const OAuthInstallationSchema = new Schema(
  {
    installationType: {
      type: String,
      enum: ["user", "guild"],
      required: true
    },
    discordUserId: {
      type: String,
      required: true
    },
    guildId: {
      type: String,
      default: null
    },
    applicationId: {
      type: String,
      required: true
    },
    scopes: {
      type: [String],
      required: true
    },
    accessToken: {
      type: String,
      default: null
    },
    refreshToken: {
      type: String,
      default: null
    },
    tokenExpiresAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

OAuthInstallationSchema.index(
  { installationType: 1, discordUserId: 1, guildId: 1 },
  { unique: true }
);

export type OAuthInstallationDocument = InferSchemaType<typeof OAuthInstallationSchema>;

export const OAuthInstallation =
  mongoose.models.OAuthInstallation ??
  mongoose.model<OAuthInstallationDocument>("OAuthInstallation", OAuthInstallationSchema);
