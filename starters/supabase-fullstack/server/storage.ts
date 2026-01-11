/**
 * Storage / Data Access Layer
 *
 * Provides a clean interface for database operations.
 * All database queries go through this module.
 */

import { db } from "./db";
import { eq } from "drizzle-orm";
import { users } from "../shared/schema";
import type { User, NewUser } from "../shared/schema";

// =============================================================================
// USER OPERATIONS
// =============================================================================

/**
 * Get user by ID
 */
export async function getUser(id: string): Promise<User | null> {
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result[0] || null;
}

/**
 * Get user by email
 */
export async function getUserByEmail(email: string): Promise<User | null> {
  const result = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return result[0] || null;
}

/**
 * Create a new user
 */
export async function createUser(data: NewUser): Promise<User> {
  const result = await db.insert(users).values(data).returning();
  return result[0];
}

/**
 * Update user
 */
export async function updateUser(
  id: string,
  data: Partial<NewUser>
): Promise<User | null> {
  const result = await db
    .update(users)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  return result[0] || null;
}

/**
 * Delete user
 */
export async function deleteUser(id: string): Promise<boolean> {
  const result = await db.delete(users).where(eq(users.id, id)).returning();
  return result.length > 0;
}

// =============================================================================
// EXPORT ALL FUNCTIONS
// =============================================================================

export const storage = {
  // Users
  getUser,
  getUserByEmail,
  createUser,
  updateUser,
  deleteUser,
  
  // Add more entity operations here...
};

export default storage;
