# Multi-Stage Pipeline Pattern

Async, fire-and-forget entity processing with multiple stages. Eliminates synchronous waiting and timeouts by using database-driven status fields and job tracking.

## Prerequisites

- [ ] PostgreSQL database (Supabase recommended)
- [ ] External services deployed (playwright-scraper, llm-batch-api)
- [ ] Node.js/TypeScript application

## Human Setup Steps

1. **Set up Supabase project**
   - Create project at [supabase.com](https://supabase.com)
   - Go to Settings → Database → Connection string
   - Copy the connection string for `DATABASE_URL`

2. **Run the schema migration**
   - Open Supabase SQL Editor
   - Paste contents of `schema.sql`
   - Run the query

3. **Deploy external services**
   - Deploy [playwright-scraper](../../services/playwright-scraper/) to Railway
   - Deploy [llm-batch-api](../../services/llm-batch-api/) to RunPod
   - Note the URLs for each service

4. **Configure environment variables**

5. **Start workers** in your application

## The Problem

Synchronous processing causes timeouts and blocks scripts:

```typescript
// ❌ BAD - Script blocks for 30+ seconds, risks timeout
const scrapeResult = await scrapeWebsite(lead.url);
const intelResult = await generateIntelligence(scrapeResult);
const strategyResult = await generateStrategy(intelResult);
// ... more blocking calls
```

## The Solution

Fire-and-forget with status tracking:

```typescript
// ✅ GOOD - Returns immediately, processing happens async
await db.update(leads).set({ scrape_status: 'queued' }).where(eq(leads.id, leadId));
// Workers pick up queued items and process in background
// Each stage completion triggers the next stage automatically
```

## How It Works

### Status Flow

Each entity has multiple status fields that progress through stages:

```
pending → queued → started → completed → (triggers next stage)
                      ↓
                   failed
```

### Pipeline Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              LEAD ENTITY                                     │
│                                                                             │
│  scrape_status   intel_status   strategy_status   subject_status   msg_status│
│       ↓               ↓              ↓                ↓              ↓      │
│    queued         pending         pending          pending        pending    │
└───────┬─────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────┐
│  STAGE WORKER     │  Polls for scrape_status = 'queued'
│  (scrape)         │  Claims with FOR UPDATE SKIP LOCKED
│                   │  Submits to scraper service
│                   │  Updates to 'started', stores job_id
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│  COMPLETION       │  Polls for scrape_status = 'started'
│  POLLER           │  Checks job status via job_id
│  (or webhook)     │  On complete: status → 'completed'
│                   │  Triggers: intel_status → 'queued'
└───────────────────┘
        │
        ▼
┌───────────────────┐
│  STAGE WORKER     │  Polls for intel_status = 'queued'
│  (intel)          │  ... and so on through all stages
└───────────────────┘
```

## Files

| File | Purpose |
|------|---------|
| `schema.sql` | Database schema with status columns and indexes |
| `stage-config.ts` | Pipeline configuration and stage chaining |
| `worker.ts` | Claims queued entities and submits to services |
| `completion-poller.ts` | Polls services for job completion |
| `webhook-handler.ts` | Receives completion callbacks from services |

## Quick Start

### 1. Set Up Database

Run `schema.sql` in your Supabase SQL editor:

```sql
-- Creates leads table with:
--   scrape_status, scrape_job_id, scrape_result, scrape_error, ...
--   intel_status, intel_job_id, intel_result, intel_error, ...
--   (and so on for each stage)
```

### 2. Configure Stages

Edit `stage-config.ts` to match your pipeline:

```typescript
export const STAGES: Record<StageName, StageConfig> = {
  scrape: {
    next: 'intel',           // Next stage to trigger
    service: 'scraper',      // Which service handles this
    maxRetries: 3,
    stuckTimeoutMs: 10 * 60 * 1000,
    pollIntervalMs: 2000,
  },
  intel: {
    next: 'strategy',
    service: 'llm',
    // ...
  },
  // ... more stages
};
```

### 3. Start Workers

```typescript
import { startWorker } from './worker.js';
import { startCompletionPoller } from './completion-poller.js';

// Start a worker for each stage
await startWorker('scrape');
await startWorker('intel');
await startWorker('strategy');
await startWorker('subject');
await startWorker('messaging');

// Start completion pollers (or use webhooks)
await startCompletionPoller('scrape');
await startCompletionPoller('intel');
// ...
```

### 4. Trigger Processing

```typescript
// User uploads leads - all statuses start as 'pending'
await db.insert(leads).values({
  email: 'contact@example.com',
  company_url: 'https://example.com',
  account_id: accountId,
  // All *_status fields default to 'pending'
});

// User clicks "Customize" - trigger the pipeline
await db.update(leads)
  .set({ scrape_status: 'queued' })
  .where(eq(leads.id, leadId));

// That's it! Workers take over from here.
```

## Schema Design

### Status Columns on Entity

Each stage has 7 columns on the entity:

```sql
-- For each stage (scrape, intel, strategy, subject, messaging):
scrape_status text default 'pending',    -- pending/queued/started/completed/failed
scrape_job_id text,                       -- Job ID from external service
scrape_result jsonb,                      -- Result data
scrape_error text,                        -- Error message if failed
scrape_retry_count int default 0,         -- Retry attempts
scrape_started_at timestamptz,            -- When job was submitted
scrape_completed_at timestamptz,          -- When job finished
```

### Indexes for Efficient Polling

Partial indexes keep polling queries fast:

```sql
-- Only indexes rows where status = 'queued' (tiny index)
create index idx_leads_scrape_queued on leads(created_at) 
  where scrape_status = 'queued';

-- For completion polling
create index idx_leads_scrape_started on leads(scrape_started_at) 
  where scrape_status = 'started';

-- For webhook lookups
create index idx_leads_scrape_job_id on leads(scrape_job_id) 
  where scrape_job_id is not null;
```

## Atomic Claiming

Workers use `FOR UPDATE SKIP LOCKED` to prevent race conditions:

```sql
UPDATE leads
SET 
  scrape_status = 'started',
  scrape_started_at = NOW()
WHERE id IN (
  SELECT id FROM leads
  WHERE scrape_status = 'queued'
  ORDER BY created_at
  LIMIT 5
  FOR UPDATE SKIP LOCKED  -- Skip rows being processed by other workers
)
RETURNING *
```

This ensures:
- Only one worker claims each entity
- Workers don't block each other
- No duplicate processing

## Completion Detection

### Option 1: Polling (Simple)

Completion poller checks job status periodically:

```typescript
// completion-poller.ts
const jobStatus = await checkJobStatus(stage, lead.job_id);

if (jobStatus.status === 'completed') {
  await markCompleted(stage, lead.id, jobStatus.result);
  // This also triggers: next_stage_status = 'queued'
}
```

**Pros:** Simple, works with any service
**Cons:** Adds latency (poll interval), more API calls

### Option 2: Webhooks (Efficient)

Services call back when jobs complete:

```typescript
// webhook-handler.ts
webhookRouter.post('/job-complete', async (req, res) => {
  const { stage, leadId, jobId, status, result } = req.body;
  
  await markCompleted(stage, leadId, result);
  // Triggers next stage automatically
  
  res.json({ status: 'processed' });
});
```

**Pros:** Immediate, no polling overhead
**Cons:** Requires service to support webhooks

### Recommended: Both

Use webhooks when available, polling as fallback:

```typescript
// If webhook hasn't arrived after stuckTimeoutMs, poller takes over
await startCompletionPoller('scrape');  // Catches missed webhooks
```

## Error Handling

### Hard Failures (Don't Retry)

These errors indicate the work cannot succeed:

- DNS lookup failed (ENOTFOUND)
- Connection refused
- 404 Not Found
- 403 Forbidden
- No content extracted

```typescript
// Immediately mark as failed
lead.scrape_status = 'failed';
lead.scrape_error = 'ENOTFOUND: DNS lookup failed';
```

### Retriable Failures (Retry Up to N Times)

These errors may succeed on retry:

- Timeout
- Rate limited (429)
- Server errors (5xx)
- Worker crash

```typescript
// Increment retry count and requeue
if (retry_count < max_retries) {
  lead.scrape_status = 'queued';
  lead.scrape_retry_count += 1;
} else {
  lead.scrape_status = 'failed';
}
```

### Stuck Job Detection

Jobs stuck in 'started' state get reset:

```sql
-- Reset jobs started more than 10 minutes ago
UPDATE leads
SET 
  scrape_status = CASE 
    WHEN scrape_retry_count >= 3 THEN 'failed'
    ELSE 'queued'
  END,
  scrape_retry_count = scrape_retry_count + 1,
  scrape_job_id = NULL,
  scrape_started_at = NULL
WHERE scrape_status = 'started'
  AND scrape_started_at < NOW() - INTERVAL '10 minutes'
```

## Environment Variables

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string | - |
| `SCRAPER_URL` | **Yes** | Playwright scraper service URL | http://localhost:3000 |
| `SCRAPER_AUTH_TOKEN` | No | Auth token for scraper | - |
| `LLM_URL` | **Yes** | LLM batch API URL | http://localhost:8000 |
| `LLM_AUTH_TOKEN` | No | Auth token for LLM | - |
| `QUEUE_BATCH_SIZE` | No | Entities to claim per cycle | 5 |
| `QUEUE_POLL_INTERVAL` | No | Ms between worker polls | 500 |
| `COMPLETION_POLL_INTERVAL` | No | Ms between completion checks | 2000 |
| `WEBHOOK_SECRET` | No | HMAC secret for webhook validation | - |

```bash
# Example .env
DATABASE_URL=postgresql://postgres:password@db.xxx.supabase.co:5432/postgres
SCRAPER_URL=https://playwright-scraper-production.up.railway.app
SCRAPER_AUTH_TOKEN=your-scraper-token
LLM_URL=https://api.runpod.ai/v2/your-endpoint
LLM_AUTH_TOKEN=your-runpod-token
```

## Example: Lead Customization Pipeline

### User Flow

1. **Upload Leads** → All statuses = `pending`
2. **Select Leads** → Update `scrape_status` = `queued`
3. **Workers Process** → Automatic progression through stages
4. **View Results** → Check `messaging_status` = `completed`

### Pipeline Stages

| Stage | Service | Input | Output |
|-------|---------|-------|--------|
| scrape | playwright-scraper | company_url | Website content (pages, markdown) |
| intel | LLM | Scraped content | Sales intelligence report |
| strategy | LLM | Intel report | Personalized outreach strategy |
| subject | LLM | Strategy | Email subject line options |
| messaging | LLM | Strategy + Subject | Complete email content |

### Monitoring Progress

```sql
-- View pipeline status for all leads
SELECT * FROM lead_pipeline_status;

-- Count by current stage
SELECT current_stage, COUNT(*) 
FROM lead_pipeline_status 
GROUP BY current_stage;
```

## Integration with Building Blocks

This pattern integrates with other building blocks:

- **[Playwright Scraper](../../services/playwright-scraper/)** - Use `/jobs` endpoint for async scraping
- **[LLM Batch API](../../services/llm-batch-api/)** - Use batch endpoints for async LLM calls
- **[Atomic Job Processor](../atomic-job-processor/)** - Foundation for the claiming pattern
- **[Webhook Handler](../webhook-handler/)** - Patterns for webhook validation

## Best Practices

### 1. Never Block on External Calls

```typescript
// ❌ BAD
const result = await fetch('/scrape', { body: { url } });
await updateLead(leadId, result);  // Script blocked for 30s+

// ✅ GOOD
await submitToService(stage, lead);  // Returns job_id immediately
// Completion detected separately via polling/webhook
```

### 2. Keep Workers Stateless

Workers should be able to crash and restart without losing work:
- Job state lives in database
- Stuck job detection recovers from crashes
- Idempotent completion handling

### 3. Use Partial Indexes

Only index the rows you're querying:

```sql
-- Small, fast index (only ~1% of rows)
WHERE scrape_status = 'queued'

-- NOT a full table index (100% of rows)
ON leads(scrape_status)
```

### 4. Monitor Queue Depth

Track how many items are queued vs. processing:

```sql
SELECT 
  'scrape' as stage,
  COUNT(*) FILTER (WHERE scrape_status = 'queued') as queued,
  COUNT(*) FILTER (WHERE scrape_status = 'started') as started,
  COUNT(*) FILTER (WHERE scrape_status = 'failed') as failed
FROM leads;
```

## License

MIT
