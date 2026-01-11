/**
 * Drizzle Configuration Example
 *
 * Copy to your project root as drizzle.config.ts
 */

import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

export default defineConfig({
  // Path to your schema file(s)
  schema: "./shared/schema.ts",
  
  // Output directory for migrations
  out: "./server/migrations",
  
  // Database dialect
  dialect: "postgresql",
  
  // Database connection
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  
  // Enable verbose logging during migrations
  verbose: true,
  
  // Strict mode - fails on warnings
  strict: true,
});
