import mongoose, { Schema, Document, model } from 'mongoose';

/**
 * Represents an OAuth 2.0 token document as stored in the database.
 * It includes the necessary tokens, expiration details, and user association.
 *
 * @interface IOAuthToken
 * @extends Document
 * @property {string} userId - The unique identifier of the user associated with this token.
 * @property {string} accessToken - The token used to authenticate API requests on behalf of the user.
 * @property {string} refreshToken - The token used to obtain a new access token once the current one expires.
 * @property {Date} expiresAt - The exact date and time when the access token will expire.
 * @property {string[]} scope - An array of strings defining the permissions (scopes) granted by this token.
 * @property {string} tokenType - The type of the token, typically "Bearer".
 * @property {Date} createdAt - The timestamp indicating when this token record was created.
 * @property {Date} updatedAt - The timestamp indicating when this token record was last updated.
 */
export interface IOAuthToken extends Document {
    userId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    scope: string[];
    tokenType: string;
    createdAt: Date;
    updatedAt: Date;
}

const OAuthTokenSchema = new Schema<IOAuthToken>(
    {
        userId: { type: String, required: true, unique: true, index: true },
        accessToken: { type: String, required: true },
        refreshToken: { type: String, required: true },
        expiresAt: { type: Date, required: true },
        scope: [{ type: String }],
        tokenType: { type: String, required: true },
    },
    { 
        timestamps: true,
        // Add TTL index to automatically remove expired tokens
        // Set to 1 day after expiration
        expires: 60 * 60 * 24 
    }
);

/**
 * Mongoose model for OAuth tokens.
 *
 * This pattern ensures that the model is not recompiled by Mongoose in serverless
 * or hot-reloading environments. If the `OAuthToken` model already exists in the
 * `mongoose.models` cache, it is reused; otherwise, a new model is created
 * from the `OAuthTokenSchema`.
 *
 * @see {@link IOAuthToken} for the document interface.
 * @see {@link OAuthTokenSchema} for the schema definition.
 */
export const OAuthToken = mongoose.models.OAuthToken || 
    model<IOAuthToken>('OAuthToken', OAuthTokenSchema);

// Utility functions
/**
 * Saves or updates a user's OAuth token in the database.
 * @param userId The Discord user ID.
 * @param accessToken The access token.
 * @param refreshToken The refresh token.
 * @param expiresIn The duration in seconds until the token expires.
 * @param scope An array of scopes granted.
 * @param tokenType The type of token (e.g., "Bearer").
 * @returns A promise that resolves to the saved token document.
 */
export async function saveUserToken(
    userId: string,
    accessToken: string,
    refreshToken: string,
    expiresIn: number,
    scope: string[],
    tokenType: string
): Promise<IOAuthToken> {
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    
    const token = await OAuthToken.findOneAndUpdate(
        { userId },
        {
            accessToken,
            refreshToken,
            expiresAt,
            scope,
            tokenType
        },
        { upsert: true, new: true }
    );

    return token;
}

/**
 * Retrieves a user's OAuth token from the database.
 * @param userId The Discord user ID.
 * @returns A promise that resolves to the token document or null if not found.
 */
export async function getUserToken(userId: string): Promise<IOAuthToken | null> {
    return OAuthToken.findOne({ userId });
}

/**
 * Removes a user's OAuth token from the database.
 * @param userId The Discord user ID.
 */
export async function removeUserToken(userId: string): Promise<void> {
    await OAuthToken.deleteOne({ userId });
}

/**
 * Updates a user's token information after a refresh.
 * @param userId The Discord user ID.
 * @param accessToken The new access token.
 * @param refreshToken The new refresh token.
 * @param expiresIn The new expiration duration in seconds.
 * @returns A promise that resolves to the updated token document or null if not found.
 */
export async function refreshUserToken(
    userId: string,
    accessToken: string,
    refreshToken: string,
    expiresIn: number
): Promise<IOAuthToken | null> {
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    
    return OAuthToken.findOneAndUpdate(
        { userId },
        {
            accessToken,
            refreshToken,
            expiresAt
        },
        { new: true }
    );
}