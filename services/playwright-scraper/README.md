# Playwright Scraper Service

Self-hosted web scraper service using Playwright for high-throughput website crawling.

## Overview

This service provides an HTTP API for scraping websites using Playwright. It supports two modes:

1. **Sync Mode** - Direct scraping, caller waits for completion (for testing/low-volume)
2. **Queue Mode** - Async job processing with database queue (for production)

Key features:
- **Parallel page processing** - Scrape multiple pages concurrently within a single crawl
- **Automatic sitemap discovery** - Finds sitemap.xml and robots.txt to discover all pages
- **Atomic job claiming** - FOR UPDATE SKIP LOCKED prevents race conditions with multiple workers
- **Automatic retries** - Retriable failures (rate limits, timeouts) are requeued
- **No per-page costs** - Just server costs

## ⚠️ Important: Never Wait for Scrapes

**Scripts should never block waiting for scrapes to finish.** Always use the queue mode:

```typescript
// ❌ BAD - Blocking call
const result = await fetch('/scrape', { body: { url } });
await processResult(result); // Script blocked for 30+ seconds

// ✅ GOOD - Submit and poll
const { id } = await fetch('/jobs', { body: { url } }).then(r => r.json());
// Job runs in background, poll for completion or use webhook
```

## Quick Start

### Local Development (Sync Mode)

```bash
npm install
npx playwright install chromium
npm run dev
```

Test with:
```bash
curl -X POST http://localhost:3000/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "maxPages": 10}'
```

### Production (Queue Mode)

1. Set up database (run `schema.sql` in Supabase SQL editor)
2. Set `DATABASE_URL` environment variable
3. Deploy to Railway

```bash
# With DATABASE_URL set, worker mode starts automatically
DATABASE_URL=postgres://... npm run dev
```

## Database Schema

Run this in your Supabase SQL editor before using queue mode:

```sql
-- See schema.sql for full schema
create table scrape_jobs (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  status text not null default 'queued', -- queued → started → completed/failed
  max_pages int default 20,
  result jsonb,
  error text,
  retry_count int default 0,
  max_retries int default 3,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz default now()
);
```

## API Endpoints

### Health Check

```
GET /health
```

Returns service status, mode, and queue stats:
```json
{
  "status": "healthy",
  "mode": "queue",
  "activeRequests": 0,
  "maxConcurrent": 32,
  "uptime": 3600,
  "queue": {
    "queued": 5,
    "started": 2,
    "completed": 150,
    "failed": 3
  }
}
```

### Queue Mode Endpoints

#### Submit Job (Async)

```
POST /jobs
Content-Type: application/json
X-Auth-Token: your-token

{
  "url": "https://example.com",
  "maxPages": 20,
  "maxConcurrency": 5,
  "includeSitemap": true
}
```

Response (202 Accepted):
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "url": "https://example.com",
  "status": "queued",
  "createdAt": "2024-01-15T10:30:00Z",
  "message": "Job queued for processing"
}
```

#### Get Job Status

```
GET /jobs/:id
X-Auth-Token: your-token
```

Response (completed):
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "url": "https://example.com",
  "status": "completed",
  "retryCount": 0,
  "createdAt": "2024-01-15T10:30:00Z",
  "completedAt": "2024-01-15T10:30:45Z",
  "result": {
    "success": true,
    "pages": [...],
    "totalPages": 15,
    "sitemapUrls": 45,
    "duration": 12500
  }
}
```

Response (failed):
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "url": "https://example.com",
  "status": "failed",
  "retryCount": 3,
  "error": "ENOTFOUND: DNS lookup failed",
  "createdAt": "2024-01-15T10:30:00Z",
  "completedAt": "2024-01-15T10:31:00Z"
}
```

#### Get Queue Stats

```
GET /jobs
X-Auth-Token: your-token
```

```json
{
  "queued": 5,
  "started": 2,
  "completed": 150,
  "failed": 3
}
```

### Sync Mode Endpoints

These endpoints wait for completion - use only for testing or low-volume use cases.

#### Scrape (Sync)

```
POST /scrape
Content-Type: application/json

{
  "url": "https://example.com",
  "maxPages": 20,
  "maxConcurrency": 5,
  "includeSitemap": true
}
```

#### Batch Scrape (Sync)

```
POST /scrape/batch
Content-Type: application/json

{
  "urls": ["https://example1.com", "https://example2.com"],
  "maxPages": 10
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `AUTH_TOKEN` | Optional auth token | - |
| `MAX_CONCURRENT` | Max concurrent HTTP requests | 32 |
| `DATABASE_URL` | Postgres connection string (enables queue mode) | - |
| `QUEUE_POLL_INTERVAL` | Ms between queue polls | 5000 |
| `QUEUE_BATCH_SIZE` | Jobs to claim per cycle | 3 |
| `QUEUE_STUCK_TIMEOUT` | Minutes before resetting stuck jobs | 10 |
| `QUEUE_MAX_RETRIES` | Max retries for retriable failures | 3 |

## Failure Handling

### Hard Failures (→ failed)

These errors indicate the site cannot be scraped:

- DNS lookup failed (ENOTFOUND)
- Connection refused (ECONNREFUSED)
- 404 Not Found
- 403 Forbidden
- No content extracted after retries

### Retriable Failures (→ queued)

These errors are temporary and jobs are requeued:

- Rate limited (429)
- Timeout
- Server errors (500, 502, 503)
- Browser crash
- Out of memory

Jobs are retried up to `max_retries` (default 3) before being marked as failed.

## Architecture

### Job Status Flow

```
┌─────────┐     ┌─────────┐     ┌───────────┐
│ queued  │────▶│ started │────▶│ completed │
└─────────┘     └─────────┘     └───────────┘
     ▲               │
     │               │ (retriable error)
     └───────────────┘
                     │
                     │ (hard error or max retries)
                     ▼
               ┌─────────┐
               │ failed  │
               └─────────┘
```

### Atomic Job Claiming

The service uses PostgreSQL's `FOR UPDATE SKIP LOCKED` to prevent race conditions:

```sql
UPDATE scrape_jobs
SET status = 'started', claimed_at = NOW()
WHERE id IN (
  SELECT id FROM scrape_jobs
  WHERE status = 'queued'
  ORDER BY created_at
  LIMIT 3
  FOR UPDATE SKIP LOCKED
)
RETURNING *
```

This ensures:
- Only one worker claims each job
- Workers don't block each other
- No duplicate processing

### Stuck Job Recovery

Jobs stuck in 'started' state (from crashed workers) are automatically reset:

- After `QUEUE_STUCK_TIMEOUT` minutes, stuck jobs are requeued
- If already at max retries, they're marked as failed
- Prevents jobs from being lost due to worker crashes

## Client Integration

### Async Pattern (Recommended)

```typescript
const SCRAPER_URL = process.env.PLAYWRIGHT_SCRAPER_URL;
const AUTH_TOKEN = process.env.SCRAPER_AUTH_TOKEN;

// Submit job
export async function submitScrapeJob(url: string, options = {}) {
  const response = await fetch(`${SCRAPER_URL}/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': AUTH_TOKEN,
    },
    body: JSON.stringify({ url, ...options }),
  });
  
  if (!response.ok) throw new Error(`Submit failed: ${response.status}`);
  return response.json(); // { id, status, ... }
}

// Poll for completion
export async function waitForJob(jobId: string, timeoutMs = 120000) {
  const start = Date.now();
  
  while (Date.now() - start < timeoutMs) {
    const response = await fetch(`${SCRAPER_URL}/jobs/${jobId}`, {
      headers: { 'X-Auth-Token': AUTH_TOKEN },
    });
    
    const job = await response.json();
    
    if (job.status === 'completed') return job.result;
    if (job.status === 'failed') throw new Error(job.error);
    
    await new Promise(r => setTimeout(r, 2000)); // Poll every 2s
  }
  
  throw new Error('Job timed out');
}

// Usage in your app
const { id } = await submitScrapeJob('https://example.com');
// Don't await here - let it process in background
// Later, or in a different process:
const result = await waitForJob(id);
```

### Database Integration

For tighter integration, query the `scrape_jobs` table directly:

```typescript
// In your app's database queries
const pendingJobs = await db.query(`
  SELECT * FROM scrape_jobs 
  WHERE status = 'completed' 
    AND processed_by_app = false
  ORDER BY completed_at
`);

for (const job of pendingJobs) {
  await processScrapedContent(job.result);
  await db.query(`UPDATE scrape_jobs SET processed_by_app = true WHERE id = $1`, [job.id]);
}
```

## Deploy to Railway

1. Copy this folder into your project
2. Create a new Railway service pointing to this directory
3. Set environment variables:
   - `DATABASE_URL` (from your Supabase project)
   - `AUTH_TOKEN` (generate a secure token)
4. Railway will auto-detect the Dockerfile

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template)

## Resource Requirements

- **Memory**: ~500MB base + ~500MB per concurrent browser context
- **Recommended**: 8GB RAM for 10-15 concurrent scrapers

| RAM | Recommended MAX_CONCURRENT |
|-----|---------------------------|
| 1GB | 2-3 |
| 2GB | 4-5 |
| 4GB | 8-10 |
| 8GB | 15-20 |
| 16GB | 30-40 |

## License

MIT
