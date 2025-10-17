import mongoose from "mongoose";

/**
 * Establishes a connection to the MongoDB database using the provided URI.
 * Exits the process if the URI is missing or if the connection fails.
 * @param uri The MongoDB connection string.
 * @returns A promise that resolves with the Mongoose connection object on success.
 */
export const connectDatabase = async (uri: string | undefined): Promise<mongoose.Connection | undefined> => {
    if (!uri) {
        console.error("MongoDB URI is missing.");
        process.exit(1);
    }
    try {
        await mongoose.connect(uri);
        console.log("Successfully connected to the MongoDB database.");
        return mongoose.connection;
    } catch (error: any) {
        console.error("Error connecting to the database:", error.message || error);
        process.exit(1);
    }
};

/**
 * Disconnects from the MongoDB database.
 * @returns A promise that resolves when disconnection is complete.
 */
export const disconnectDatabase = async (): Promise<void> => {
    try {
        await mongoose.disconnect();
        console.log("Disconnected from the MongoDB database.");
    } catch (error: any) {
        console.error("Error disconnecting from the database:", error.message || error);
    }
};