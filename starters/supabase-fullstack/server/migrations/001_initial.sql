-- Initial Schema Migration
-- All statements use IF NOT EXISTS for idempotency
-- Safe to run multiple times

-- ============================================================================
-- USERS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255),
  avatar_url TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Index for email lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ============================================================================
-- EXAMPLE: POSTS TABLE (uncomment if needed)
-- ============================================================================

-- CREATE TABLE IF NOT EXISTS posts (
--   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--   title VARCHAR(255) NOT NULL,
--   content TEXT,
--   published BOOLEAN NOT NULL DEFAULT false,
--   created_at TIMESTAMP NOT NULL DEFAULT NOW(),
--   updated_at TIMESTAMP NOT NULL DEFAULT NOW()
-- );

-- CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
-- CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published, created_at DESC);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE users IS 'Application users synced from Supabase Auth';
