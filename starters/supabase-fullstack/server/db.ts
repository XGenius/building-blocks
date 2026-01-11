/**
 * Database Connection
 *
 * Configures Drizzle ORM to connect to Supabase PostgreSQL.
 * Uses connection pooling for production workloads.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../shared/schema";

// Database connection URL from environment
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL environment variable is required. " +
      "Get this from your Supabase project settings."
  );
}

// Create postgres connection with pooling
// For serverless/edge, use: postgres(connectionString, { prepare: false })
const client = postgres(connectionString, {
  max: 10, // Maximum connections in pool
  idle_timeout: 20, // Close idle connections after 20 seconds
  connect_timeout: 10, // Connection timeout
});

// Create Drizzle instance with schema
export const db = drizzle(client, { schema });

export default db;
