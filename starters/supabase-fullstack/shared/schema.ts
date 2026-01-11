/**
 * Drizzle Schema
 *
 * Defines database tables and types.
 * Keep in sync with SQL migrations.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";
import { InferSelectModel, InferInsertModel } from "drizzle-orm";

// =============================================================================
// USERS
// =============================================================================

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

// =============================================================================
// EXAMPLE: POSTS (uncomment if needed)
// =============================================================================

// export const posts = pgTable("posts", {
//   id: uuid("id").primaryKey().defaultRandom(),
//   userId: uuid("user_id")
//     .notNull()
//     .references(() => users.id, { onDelete: "cascade" }),
//   title: varchar("title", { length: 255 }).notNull(),
//   content: text("content"),
//   published: boolean("published").notNull().default(false),
//   createdAt: timestamp("created_at").notNull().defaultNow(),
//   updatedAt: timestamp("updated_at").notNull().defaultNow(),
// });

// export type Post = InferSelectModel<typeof posts>;
// export type NewPost = InferInsertModel<typeof posts>;
