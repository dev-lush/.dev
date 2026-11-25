import mongoose from "mongoose";
import { startBot } from "./Modules/bot.js";
import { readConfig } from "./Config/config.js";
import { startServer } from "./Modules/server.js";

/**
 * Starts the Discord client and OAuth/preview/status HTTP server, then registers
 * process signal handlers for a graceful shutdown.
 *
 * @returns A promise that resolves after startup succeeds.
 */
async function main(): Promise<void> {
  const config = readConfig();
  const client = await startBot(config);
  const server = startServer(config, client);

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}; shutting down.`);
    client.destroy();
    server.close();
    await mongoose.disconnect();
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Startup failed", error);
  process.exitCode = 1;
});
