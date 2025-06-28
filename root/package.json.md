{
    "name": "discord.dev",
    "version": "1.0.0",
    "description": "A Discord bot with GitHub and status monitoring features.",
    "main": "dist/bot.js",
    "scripts": {
      "start": "node dist/bot.js",         // Starts the bot using the compiled JavaScript files.
      "build": "tsc",                      // Compiles TypeScript files into JavaScript.
      "dev": "ts-node src/bot.ts",         // Runs the bot directly using TypeScript during development.
      "lint": "eslint . --ext .ts"         // Lint the project (if using ESLint for code quality).
    },
    "keywords": [
      "discord",
      "bot",
      "github",
      "typescript",
      "status-monitor"
    ],
    "author": "LushDashBlaze",
    "license": "MIT",
    "dependencies": {
      "discord.js": "^14.11.0",            // Discord.js library for bot functionality.
      "mongoose": "^7.5.0",                // Mongoose for MongoDB integration.
      "node-fetch": "^3.3.2",              // Fetch library for HTTP requests.
      "dotenv": "^16.3.1"                  // Loads environment variables from a .env file.
    },
    "devDependencies": {
      "@types/node": "^20.8.0",            // TypeScript definitions for Node.js.
      "@types/node-fetch": "^3.2.1",       // TypeScript definitions for node-fetch.
      "typescript": "^5.2.2",              // TypeScript compiler.
      "ts-node": "^10.9.1",                // Runs TypeScript files directly in Node.js.
      "eslint": "^8.49.0",                 // Linter for code quality (optional).
      "eslint-config-prettier": "^9.0.0",  // Prettier config for ESLint (optional).
      "eslint-plugin-import": "^2.28.0"    // Linting rules for import/export syntax (optional).
    }
}