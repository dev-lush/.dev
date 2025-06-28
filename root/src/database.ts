import mongoose from "mongoose";

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

export const disconnectDatabase = async (): Promise<void> => {
    try {
        await mongoose.disconnect();
        console.log("Disconnected from the MongoDB database.");
    } catch (error: any) {
        console.error("Error disconnecting from the database:", error.message || error);
    }
};