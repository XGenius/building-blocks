/**
 * Scrape Job Queue
 * 
 * Implements atomic job claiming with FOR UPDATE SKIP LOCKED
 * to prevent race conditions when multiple workers run.
 * 
 * Status flow:
 *   queued → started → completed
 *                   → failed (hard failure)
 *                   → queued (retriable failure, under max_retries)
 */

import pg from "pg";
import { crawlWebsite, CrawlResult } from "./crawler.js";

const { Pool } = pg;

// =============================================================================
// CONFIGURATION
// =============================================================================

const POLL_INTERVAL_MS = parseInt(process.env.QUEUE_POLL_INTERVAL || "5000", 10);
const BATCH_SIZE = parseInt(process.env.QUEUE_BATCH_SIZE || "3", 10);
const STUCK_TIMEOUT_MINUTES = parseInt(process.env.QUEUE_STUCK_TIMEOUT || "10", 10);
const MAX_RETRIES = parseInt(process.env.QUEUE_MAX_RETRIES || "3", 10);

// =============================================================================
// TYPES
// =============================================================================

export interface ScrapeJob {
  id: string;
  url: string;
  max_pages: number;
  max_concurrency: number;
  include_sitemap: boolean;
  status: "queued" | "started" | "completed" | "failed";
  result: CrawlResult | null;
  error: string | null;
  retry_count: number;
  max_retries: number;
  claimed_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface QueueStats {
  queued: number;
  started: number;
  completed: number;
  failed: number;
}

// Hard failures - don't retry these
const HARD_FAILURE_PATTERNS = [
  /ENOTFOUND/i,           // DNS lookup failed
  /ECONNREFUSED/i,        // Connection refused
  /ERR_NAME_NOT_RESOLVED/i,
  /net::ERR_/i,           // Network errors
  /404/i,                 // Not found
  /403/i,                 // Forbidden
  /401/i,                 // Unauthorized
  /no content could be extracted/i,
];

// Retriable failures - reset to queued
const RETRIABLE_FAILURE_PATTERNS = [
  /timeout/i,
  /429/i,                 // Rate limited
  /503/i,                 // Service unavailable
  /502/i,                 // Bad gateway
  /500/i,                 // Internal server error
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /out of memory/i,
  /browser.*crash/i,
  /target closed/i,
  /context was destroyed/i,
];

function isHardFailure(error: string): boolean {
  return HARD_FAILURE_PATTERNS.some(pattern => pattern.test(error));
}

function isRetriableFailure(error: string): boolean {
  return RETRIABLE_FAILURE_PATTERNS.some(pattern => pattern.test(error));
}

// =============================================================================
// DATABASE CONNECTION
// =============================================================================

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is required for queue mode");
    }
    
    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    
    pool.on("error", (err) => {
      console.error("[Queue] Unexpected pool error:", err);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// =============================================================================
// JOB SUBMISSION
// =============================================================================

export interface SubmitJobOptions {
  url: string;
  maxPages?: number;
  maxConcurrency?: number;
  includeSitemap?: boolean;
}

export async function submitJob(options: SubmitJobOptions): Promise<ScrapeJob> {
  const { 
    url, 
    maxPages = 20, 
    maxConcurrency = 5, 
    includeSitemap = true 
  } = options;
  
  const result = await getPool().query<ScrapeJob>(
    `INSERT INTO scrape_jobs (url, max_pages, max_concurrency, include_sitemap)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [url, Math.min(maxPages, 100), Math.min(maxConcurrency, 10), includeSitemap]
  );
  
  console.log(`[Queue] Job submitted: ${result.rows[0].id} for ${url}`);
  return result.rows[0];
}

export async function getJob(jobId: string): Promise<ScrapeJob | null> {
  const result = await getPool().query<ScrapeJob>(
    `SELECT * FROM scrape_jobs WHERE id = $1`,
    [jobId]
  );
  return result.rows[0] || null;
}

export async function getQueueStats(): Promise<QueueStats> {
  const result = await getPool().query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::int as count 
     FROM scrape_jobs 
     GROUP BY status`
  );
  
  const stats: QueueStats = { queued: 0, started: 0, completed: 0, failed: 0 };
  for (const row of result.rows) {
    if (row.status in stats) {
      stats[row.status as keyof QueueStats] = parseInt(row.count, 10);
    }
  }
  return stats;
}

// =============================================================================
// ATOMIC JOB CLAIMING
// =============================================================================

/**
 * Atomically claim jobs from the queue using FOR UPDATE SKIP LOCKED
 * 
 * This prevents race conditions when multiple workers run:
 * - Only one worker can claim each job
 * - SKIP LOCKED means we don't block on jobs being claimed by others
 */
async function claimJobs(limit: number = BATCH_SIZE): Promise<ScrapeJob[]> {
  const result = await getPool().query<ScrapeJob>(
    `UPDATE scrape_jobs
     SET 
       status = 'started',
       claimed_at = NOW()
     WHERE id IN (
       SELECT id FROM scrape_jobs
       WHERE status = 'queued'
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [limit]
  );
  
  return result.rows;
}

/**
 * Reset jobs stuck in 'started' state (from crashed workers)
 */
async function resetStuckJobs(): Promise<number> {
  const result = await getPool().query(
    `UPDATE scrape_jobs
     SET 
       status = CASE 
         WHEN retry_count >= max_retries THEN 'failed'
         ELSE 'queued'
       END,
       retry_count = retry_count + 1,
       error = CASE 
         WHEN retry_count >= max_retries THEN 'Job stuck in started state (worker crash)'
         ELSE error
       END,
       claimed_at = NULL
     WHERE status = 'started'
       AND claimed_at < NOW() - INTERVAL '1 minute' * $1
     RETURNING id, status`,
    [STUCK_TIMEOUT_MINUTES]
  );
  
  if (result.rows.length > 0) {
    const requeued = result.rows.filter(r => r.status === 'queued').length;
    const failed = result.rows.filter(r => r.status === 'failed').length;
    console.log(`[Queue] Reset stuck jobs: ${requeued} requeued, ${failed} failed (max retries)`);
  }
  
  return result.rows.length;
}

// =============================================================================
// JOB PROCESSING
// =============================================================================

async function markCompleted(jobId: string, result: CrawlResult): Promise<void> {
  await getPool().query(
    `UPDATE scrape_jobs
     SET 
       status = 'completed',
       result = $2,
       completed_at = NOW()
     WHERE id = $1`,
    [jobId, JSON.stringify(result)]
  );
}

async function markFailed(jobId: string, error: string, hardFail: boolean): Promise<void> {
  if (hardFail) {
    // Hard failure - mark as failed immediately
    await getPool().query(
      `UPDATE scrape_jobs
       SET 
         status = 'failed',
         error = $2,
         completed_at = NOW()
       WHERE id = $1`,
      [jobId, error]
    );
  } else {
    // Retriable failure - increment retry count, requeue or fail
    await getPool().query(
      `UPDATE scrape_jobs
       SET 
         status = CASE 
           WHEN retry_count >= max_retries THEN 'failed'
           ELSE 'queued'
         END,
         retry_count = retry_count + 1,
         error = $2,
         claimed_at = NULL,
         completed_at = CASE 
           WHEN retry_count >= max_retries THEN NOW()
           ELSE NULL
         END
       WHERE id = $1`,
      [jobId, error]
    );
  }
}

async function processJob(job: ScrapeJob): Promise<void> {
  console.log(`[Queue] Processing job ${job.id}: ${job.url}`);
  
  try {
    const result = await crawlWebsite(job.url, job.max_pages, {
      maxConcurrency: job.max_concurrency,
      includeSitemap: job.include_sitemap,
    });
    
    if (result.success) {
      await markCompleted(job.id, result);
      console.log(`[Queue] Job ${job.id} completed: ${result.totalPages} pages in ${result.duration}ms`);
    } else {
      // Crawl returned but with no pages - treat as hard failure
      const error = result.error || "No content extracted";
      const hardFail = isHardFailure(error);
      await markFailed(job.id, error, hardFail);
      console.log(`[Queue] Job ${job.id} failed (${hardFail ? 'hard' : 'retriable'}): ${error}`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    const hardFail = isHardFailure(errorMsg);
    const retriable = !hardFail && isRetriableFailure(errorMsg);
    
    await markFailed(job.id, errorMsg, hardFail || !retriable);
    console.error(`[Queue] Job ${job.id} error (${hardFail ? 'hard' : retriable ? 'retriable' : 'unknown'}): ${errorMsg}`);
  }
}

// =============================================================================
// WORKER LOOP
// =============================================================================

let isRunning = false;
let pollTimeout: NodeJS.Timeout | null = null;

async function processCycle(): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  
  try {
    // Reset any stuck jobs first
    await resetStuckJobs();
    
    // Claim jobs atomically
    const jobs = await claimJobs(BATCH_SIZE);
    
    if (jobs.length === 0) {
      return { processed: 0, failed: 0 };
    }
    
    console.log(`[Queue] Claimed ${jobs.length} jobs`);
    
    // Process jobs in parallel (they're already independent URLs)
    const results = await Promise.allSettled(
      jobs.map(job => processJob(job))
    );
    
    for (const result of results) {
      if (result.status === "fulfilled") {
        processed++;
      } else {
        failed++;
      }
    }
    
    return { processed, failed };
  } catch (error) {
    console.error("[Queue] Cycle error:", error);
    return { processed, failed };
  }
}

export async function startWorker(): Promise<void> {
  if (isRunning) {
    console.log("[Queue] Worker already running");
    return;
  }
  
  isRunning = true;
  console.log(`[Queue] Starting worker - poll interval: ${POLL_INTERVAL_MS}ms, batch size: ${BATCH_SIZE}`);
  
  const runCycle = async () => {
    if (!isRunning) return;
    
    try {
      const { processed, failed } = await processCycle();
      if (processed > 0 || failed > 0) {
        console.log(`[Queue] Cycle: ${processed} processed, ${failed} failed`);
      }
    } catch (error) {
      console.error("[Queue] Worker error:", error);
    }
    
    // Schedule next cycle
    if (isRunning) {
      pollTimeout = setTimeout(runCycle, POLL_INTERVAL_MS);
    }
  };
  
  // Run first cycle immediately
  await runCycle();
}

export async function stopWorker(): Promise<void> {
  console.log("[Queue] Stopping worker...");
  isRunning = false;
  
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
  
  await closePool();
  console.log("[Queue] Worker stopped");
}
