# Atomic Job Processor Pattern

A race-condition-safe pattern for processing queued jobs when multiple server instances run simultaneously.

## The Problem

When you have multiple server instances (dev + prod, multiple Railway replicas, etc.) running the same job processor:

1. Instance A queries for jobs with status = 'queued'
2. Instance B queries for jobs with status = 'queued' (same jobs!)
3. Both instances process the same jobs
4. Result: **Duplicate processing, corrupted data**

We discovered this the hard way: **205,000+ duplicate records** were created before we fixed it.

## The Solution

Use PostgreSQL's `FOR UPDATE SKIP LOCKED` to atomically claim jobs in a single query:

```sql
UPDATE jobs
SET status = 'started', started_at = NOW()
WHERE id IN (
  SELECT id FROM jobs
  WHERE status = 'queued'
  ORDER BY created_at
  LIMIT 5
  FOR UPDATE SKIP LOCKED  -- Critical: Skip rows already being processed
)
RETURNING *
```

This ensures:
- Only one instance can claim each job
- Jobs being processed by other instances are skipped
- No race conditions, no duplicates

## Usage

1. Copy `processor.ts` into your project
2. Replace table/column names with your schema
3. Implement your `processItem()` logic
4. Call `startProcessor()` on server startup

## Files

- `processor.ts` - Generic processor template
- `examples/` - Example implementations

## Key Features

### Atomic Claiming

```typescript
const claimed = await db.execute(sql`
  UPDATE your_table
  SET status = 'started', started_at = NOW()
  WHERE id IN (
    SELECT id FROM your_table
    WHERE status = 'queued'
    ORDER BY created_at
    LIMIT ${BATCH_SIZE}
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *
`);
```

### Stuck Job Recovery

Jobs can get stuck in 'started' state if a processor crashes. The pattern includes recovery logic:

```typescript
// Check if work was actually completed (just status wasn't updated)
await db.execute(sql`
  UPDATE your_table
  SET status = 'completed'
  WHERE status = 'started'
    AND started_at < ${stuckThreshold}
    AND EXISTS (SELECT 1 FROM output_table WHERE source_id = your_table.id)
`);

// Reset truly stuck jobs for retry
await db.execute(sql`
  UPDATE your_table
  SET status = 'queued', started_at = NULL
  WHERE status = 'started'
    AND started_at < ${stuckThreshold}
    AND NOT EXISTS (SELECT 1 FROM output_table WHERE source_id = your_table.id)
`);
```

### Idempotency Checks

Before creating output, always check if it already exists:

```typescript
const existing = await db
  .select({ id: outputTable.id })
  .from(outputTable)
  .where(eq(outputTable.sourceId, item.id))
  .limit(1);

if (existing.length > 0) {
  console.warn(`Duplicate prevented: ${item.id}`);
  return; // Skip - work already done
}
```

## Database Requirements

1. Your table needs a `status` column with values like `'queued'`, `'started'`, `'completed'`, `'failed'`
2. Add a `started_at` timestamp to detect stuck jobs
3. Consider adding a unique constraint on output to prevent duplicates at the database level

### Recommended Migration

```sql
-- Add status tracking columns if not present
ALTER TABLE your_table 
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;

-- Index for efficient querying
CREATE INDEX IF NOT EXISTS idx_your_table_status 
  ON your_table(status, created_at) 
  WHERE status = 'queued';

-- Unique constraint on output (if applicable)
CREATE UNIQUE INDEX IF NOT EXISTS idx_output_unique_source
  ON output_table(source_id)
  WHERE source_id IS NOT NULL;
```

## Configuration

| Constant | Description | Recommended |
|----------|-------------|-------------|
| `BATCH_SIZE` | Jobs to claim per cycle | 5-10 |
| `POLL_INTERVAL_MS` | Time between cycles | 5000-10000 |
| `STUCK_TIMEOUT_MINUTES` | When to reset stuck jobs | 5-10 |

## License

MIT
