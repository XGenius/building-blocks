/**
 * Shared TypeScript Types
 *
 * Types used by both client and server.
 * Keep API contracts in sync.
 */

// =============================================================================
// API RESPONSE TYPES
// =============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// =============================================================================
// USER TYPES
// =============================================================================

export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export interface UpdateProfileRequest {
  name?: string;
  avatarUrl?: string;
}

// =============================================================================
// AUTH TYPES
// =============================================================================

export interface AuthUser {
  id: string;
  email: string;
  role?: string;
}

// =============================================================================
// ADD YOUR TYPES HERE
// =============================================================================

// Example:
// export interface CreatePostRequest {
//   title: string;
//   content?: string;
// }
