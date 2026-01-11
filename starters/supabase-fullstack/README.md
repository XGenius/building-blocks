# Supabase Full-Stack Starter

A complete starter template for building full-stack applications with Supabase, React, and Express.

## Overview

This starter provides a production-ready foundation with:

- **Frontend**: React + TypeScript + Vite
- **Backend**: Express + TypeScript + Drizzle ORM
- **Database**: Supabase PostgreSQL
- **Auth**: Supabase Auth with JWT verification
- **Deployment**: Railway-ready configuration

## Quick Start

### 1. Copy the Template

```bash
cp -r building-blocks/starters/supabase-fullstack my-new-project
cd my-new-project
```

### 2. Set Up Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Copy your credentials to `.env`:

```bash
cp .env.example .env
```

```env
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DATABASE_URL=postgresql://postgres:password@db.your-project.supabase.co:5432/postgres

# App
PORT=5001
NODE_ENV=development
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Run Migrations

```bash
npm run db:migrate
```

### 5. Start Development

```bash
npm run dev
```

## Project Structure

```
├── client/                    # React frontend
│   ├── src/
│   │   ├── components/        # Reusable components
│   │   │   └── ProtectedRoute.tsx
│   │   ├── contexts/          # React contexts
│   │   │   └── AuthContext.tsx
│   │   ├── lib/               # Utilities
│   │   │   └── supabase.ts
│   │   ├── pages/             # Page components
│   │   └── App.tsx
│   └── package.json
│
├── server/                    # Express backend
│   ├── middleware/
│   │   └── auth.ts            # JWT verification
│   ├── migrations/
│   │   └── 001_initial.sql
│   ├── db.ts                  # Drizzle connection
│   ├── storage.ts             # Data access layer
│   ├── routes.ts              # API routes
│   └── index.ts               # Server entry
│
├── shared/                    # Shared code
│   ├── schema.ts              # Drizzle schema
│   └── types.ts               # TypeScript types
│
├── supabase/
│   └── functions/             # Edge functions
│
├── drizzle.config.ts
├── railway.json
└── package.json
```

## Features

### Authentication

The starter includes complete auth flow:

- **AuthContext**: React context for auth state
- **ProtectedRoute**: Route guard component
- **JWT Middleware**: Express middleware for API protection

```tsx
// Use auth in components
import { useAuth } from './contexts/AuthContext';

function Profile() {
  const { user, signOut, isLoading } = useAuth();
  
  if (isLoading) return <div>Loading...</div>;
  if (!user) return <Navigate to="/login" />;
  
  return <div>Welcome, {user.email}</div>;
}
```

### Database Access

Uses Drizzle ORM for type-safe database access:

```typescript
// Define schema
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// Query with type safety
const user = await db.select().from(users).where(eq(users.id, userId));
```

### Migrations

SQL migrations with idempotent patterns:

```sql
-- All migrations use IF NOT EXISTS for safety
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
```

Run migrations:
```bash
npm run db:migrate
```

### Protected API Routes

```typescript
import { isAuthenticated } from './middleware/auth';

app.get('/api/profile', isAuthenticated, async (req, res) => {
  // req.user contains the authenticated user
  const profile = await storage.getUser(req.user.id);
  res.json(profile);
});
```

## Deployment

### Railway

1. Push to GitHub
2. Connect repo to Railway
3. Add environment variables
4. Deploy!

The included `railway.json` configures:
- Build command with migrations
- Restart policy
- Health checks

### Environment Variables for Production

```env
# Required
DATABASE_URL=postgresql://...
SUPABASE_URL=https://...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...

# Optional
PORT=5001
NODE_ENV=production
```

## Customization

### Adding New Tables

1. Add to `shared/schema.ts`:
```typescript
export const posts = pgTable('posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: varchar('title', { length: 255 }).notNull(),
  userId: uuid('user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
});
```

2. Create migration in `server/migrations/`:
```sql
CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  user_id UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);
```

3. Add to storage layer in `server/storage.ts`

### Adding API Routes

```typescript
// server/routes.ts
app.post('/api/posts', isAuthenticated, async (req, res) => {
  const post = await storage.createPost({
    title: req.body.title,
    userId: req.user.id,
  });
  res.json(post);
});
```

## Edge Functions

Example edge function in `supabase/functions/`:

```typescript
// supabase/functions/hello/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req: Request) => {
  const { name } = await req.json();
  
  return new Response(
    JSON.stringify({ message: `Hello ${name}!` }),
    { headers: { 'Content-Type': 'application/json' } }
  );
});
```

Deploy:
```bash
supabase functions deploy hello
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server (client + server) |
| `npm run build` | Build for production |
| `npm run start` | Start production server |
| `npm run db:migrate` | Run database migrations |
| `npm run typecheck` | Run TypeScript checks |

## License

MIT
