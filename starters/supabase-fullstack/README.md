# Supabase Full-Stack Starter

A complete starter template for building full-stack applications with Supabase, React, and Express.

## Prerequisites

- [ ] Node.js 18+ installed
- [ ] Supabase account (free tier works)
- [ ] Railway account (for deployment)

## Human Setup Steps

### Step 1: Create Supabase Project

1. **Go to** [supabase.com](https://supabase.com) and sign in
2. **Click** "New Project"
3. **Fill in**:
   - Project name: `my-app` (or your choice)
   - Database password: Generate a strong one and **save it**
   - Region: Choose closest to your users
4. **Wait** for project to provision (~2 minutes)

### Step 2: Get Your Credentials

1. **Go to** Settings → API
2. **Copy these values** (you'll need them for `.env`):
   - Project URL → `SUPABASE_URL`
   - `anon` `public` key → `SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`

3. **Go to** Settings → Database
4. **Copy** Connection string (URI) → `DATABASE_URL`
   - Replace `[YOUR-PASSWORD]` with the password you saved

### Step 3: Copy and Configure

```bash
# Copy the template
cp -r building-blocks/starters/supabase-fullstack my-new-project
cd my-new-project

# Create environment file
cp env.example .env

# Edit .env with your values from Step 2
```

### Step 4: Run Migrations

1. **Open** Supabase Dashboard → SQL Editor
2. **Copy** contents of `server/migrations/001_initial.sql`
3. **Paste** and click "Run"

Or use the CLI:
```bash
npm run db:migrate
```

### Step 5: Install and Run

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) - you should see the app!

## Environment Variables

| Variable | Required | Where to Find |
|----------|----------|---------------|
| `SUPABASE_URL` | **Yes** | Supabase → Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | **Yes** | Supabase → Settings → API → anon public |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Supabase → Settings → API → service_role |
| `DATABASE_URL` | **Yes** | Supabase → Settings → Database → Connection string |
| `PORT` | No | Server port (default: 5001) |
| `NODE_ENV` | No | `development` or `production` |

```bash
# Example .env
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.xxxxx.supabase.co:5432/postgres
PORT=5001
NODE_ENV=development
```

## Overview

This starter provides a production-ready foundation with:

- **Frontend**: React + TypeScript + Vite
- **Backend**: Express + TypeScript + Drizzle ORM
- **Database**: Supabase PostgreSQL
- **Auth**: Supabase Auth with JWT verification
- **Deployment**: Railway-ready configuration

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
