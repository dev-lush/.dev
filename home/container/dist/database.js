import mongoose from "mongoose";
export const connectDatabase = async (uri) => {
    if (!uri) {
        console.error("MongoDB URI is missing.");
        process.exit(1);
    }
    try {
        await mongoose.connect(uri);
        console.log("Successfully connected to the MongoDB database.");
        return mongoose.connection;
    }
    catch (error) {
        console.error("Error connecting to the database:", error.message || error);
        process.exit(1);
        return undefined;
    }
};
export const disconnectDatabase = async () => {
    try {
        await mongoose.disconnect();
        console.log("Disconnected from the MongoDB database.");
    }
    catch (error) {
        console.error("Error disconnecting from the database:", error.message || error);
    }
};
