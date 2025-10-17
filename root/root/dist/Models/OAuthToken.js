import mongoose, { Schema, model } from 'mongoose';
const OAuthTokenSchema = new Schema({
    userId: { type: String, required: true, unique: true, index: true },
    accessToken: { type: String, required: true },
    refreshToken: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    scope: [{ type: String }],
    tokenType: { type: String, required: true },
}, {
    timestamps: true,
    // Add TTL index to automatically remove expired tokens
    // Set to 1 day after expiration
    expires: 60 * 60 * 24
});
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
    model('OAuthToken', OAuthTokenSchema);
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
export async function saveUserToken(userId, accessToken, refreshToken, expiresIn, scope, tokenType) {
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const token = await OAuthToken.findOneAndUpdate({ userId }, {
        accessToken,
        refreshToken,
        expiresAt,
        scope,
        tokenType
    }, { upsert: true, new: true });
    return token;
}
/**
 * Retrieves a user's OAuth token from the database.
 * @param userId The Discord user ID.
 * @returns A promise that resolves to the token document or null if not found.
 */
export async function getUserToken(userId) {
    return OAuthToken.findOne({ userId });
}
/**
 * Removes a user's OAuth token from the database.
 * @param userId The Discord user ID.
 */
export async function removeUserToken(userId) {
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
export async function refreshUserToken(userId, accessToken, refreshToken, expiresIn) {
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    return OAuthToken.findOneAndUpdate({ userId }, {
        accessToken,
        refreshToken,
        expiresAt
    }, { new: true });
}
