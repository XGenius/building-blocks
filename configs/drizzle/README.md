# Drizzle ORM Configuration

Configuration and best practices for Drizzle ORM with PostgreSQL/Supabase.

## Setup

1. Install dependencies:

```bash
npm install drizzle-orm postgres
npm install -D drizzle-kit dotenv
```

2. Copy the config:

```bash
cp drizzle.config.example.ts ../../drizzle.config.ts
```

3. Add scripts to package.json:

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:push": "drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  }
}
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run db:generate` | Generate migrations from schema changes |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:push` | Push schema directly (development only) |
| `npm run db:studio` | Open Drizzle Studio (GUI) |

## Best Practices

### Migrations

Always use `IF NOT EXISTS` for idempotent migrations:

```sql
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
```

### Schema Definition

```typescript
import { pgTable, uuid, varchar, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

### Database Connection

```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const client = postgres(process.env.DATABASE_URL!, {
  max: 10,
  idle_timeout: 20,
});

export const db = drizzle(client);
```
