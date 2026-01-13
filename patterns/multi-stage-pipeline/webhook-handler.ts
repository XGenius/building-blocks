/**
 * Webhook Handler
 * 
 * Receives webhook callbacks from external services when jobs complete.
 * This is more efficient than polling for high-volume pipelines.
 * 
 * The handler:
 *   1. Validates the webhook signature (if configured)
 *   2. Logs the webhook immediately (for debugging/replay)
 *   3. Updates the entity status to 'completed' (or 'failed')
 *   4. Triggers the next stage by setting its status to 'queued'
 *   5. Returns 200 quickly (idempotent - handles duplicates)
 * 
 * Usage:
 *   1. Copy this file into your project
 *   2. Mount the router in your Express app
 *   3. Configure external services to send webhooks to your endpoint
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import pg from "pg";
import { 
  StageName, 
  STAGES, 
  getStageColumns,
  classifyError,
} from "./stage-config.js";

const { Pool } = pg;

// =============================================================================
// TYPES
// =============================================================================

interface WebhookPayload {
  /** The job ID that completed */
  jobId: string;
  
  /** Which stage this is for */
  stage: StageName;
  
  /** The lead ID (from metadata when job was submitted) */
  leadId: string;
  
  /** Job status */
  status: 'completed' | 'failed';
  
  /** Result data (if completed) */
  result?: unknown;
  
  /** Error message (if failed) */
  error?: string;
  
  /** Timestamp */
  timestamp: string;
}

interface WebhookLog {
  id: string;
  payload: WebhookPayload;
  processed: boolean;
  created_at: Date;
}

// =============================================================================
// DATABASE CONNECTION
// =============================================================================

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    
    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
    });
  }
  return pool;
}

// =============================================================================
// SIGNATURE VALIDATION
// =============================================================================

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

/**
 * Validate webhook signature using HMAC-SHA256.
 * 
 * The signature should be in the X-Webhook-Signature header as:
 *   sha256=<hex-encoded-signature>
 */
function validateSignature(
  payload: string,
  signature: string | undefined
): boolean {
  if (!WEBHOOK_SECRET) {
    // No secret configured - skip validation (development mode)
    console.warn('[Webhook] No WEBHOOK_SECRET configured, skipping signature validation');
    return true;
  }
  
  if (!signature) {
    return false;
  }
  
  const [algorithm, providedSignature] = signature.split('=');
  
  if (algorithm !== 'sha256' || !providedSignature) {
    return false;
  }
  
  const expectedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  
  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(providedSignature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  } catch {
    return false;
  }
}

// =============================================================================
// WEBHOOK LOGGING
// =============================================================================

/**
 * Log webhook for debugging and replay capability.
 * Returns the log ID for idempotency checking.
 */
async function logWebhook(payload: WebhookPayload): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO webhook_logs (payload, processed)
     VALUES ($1, false)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [JSON.stringify(payload)]
  );
  
  return result.rows[0]?.id || '';
}

/**
 * Mark webhook as processed.
 */
async function markWebhookProcessed(logId: string): Promise<void> {
  await getPool().query(
    `UPDATE webhook_logs SET processed = true WHERE id = $1`,
    [logId]
  );
}

/**
 * Check if this webhook was already processed (idempotency).
 */
async function isAlreadyProcessed(
  stage: StageName,
  leadId: string,
  jobId: string
): Promise<boolean> {
  const cols = getStageColumns(stage);
  
  const result = await getPool().query(
    `SELECT ${cols.status} as status 
     FROM leads 
     WHERE id = $1 AND ${cols.jobId} = $2`,
    [leadId, jobId]
  );
  
  if (result.rows.length === 0) {
    return false;  // Lead not found
  }
  
  const status = result.rows[0].status;
  // Already processed if status is completed or failed
  return status === 'completed' || status === 'failed';
}

// =============================================================================
// COMPLETION HANDLING
// =============================================================================

/**
 * Mark a lead as completed and trigger the next stage.
 */
async function markCompleted(
  stage: StageName,
  leadId: string,
  jobId: string,
  result: unknown
): Promise<void> {
  const cols = getStageColumns(stage);
  const stageConfig = STAGES[stage];
  const nextCols = stageConfig.next ? getStageColumns(stageConfig.next) : null;
  
  if (nextCols) {
    await getPool().query(
      `UPDATE leads
       SET 
         ${cols.status} = 'completed',
         ${cols.result} = $2,
         ${cols.completedAt} = NOW(),
         ${nextCols.status} = 'queued'
       WHERE id = $1 AND ${cols.jobId} = $3`,
      [leadId, JSON.stringify(result), jobId]
    );
    console.log(`[Webhook:${stage}] Lead ${leadId} completed, triggered ${stageConfig.next}`);
  } else {
    await getPool().query(
      `UPDATE leads
       SET 
         ${cols.status} = 'completed',
         ${cols.result} = $2,
         ${cols.completedAt} = NOW()
       WHERE id = $1 AND ${cols.jobId} = $3`,
      [leadId, JSON.stringify(result), jobId]
    );
    console.log(`[Webhook:${stage}] Lead ${leadId} completed (final stage)`);
  }
}

/**
 * Handle job failure.
 */
async function handleJobFailure(
  stage: StageName,
  leadId: string,
  jobId: string,
  error: string
): Promise<void> {
  const cols = getStageColumns(stage);
  const stageConfig = STAGES[stage];
  const errorType = classifyError(error);
  
  // Get current retry count
  const lead = await getPool().query<{ retry_count: number }>(
    `SELECT ${cols.retryCount} as retry_count FROM leads WHERE id = $1`,
    [leadId]
  );
  
  const retryCount = lead.rows[0]?.retry_count || 0;
  
  if (errorType === 'hard' || retryCount >= stageConfig.maxRetries) {
    // Hard failure or max retries reached
    await getPool().query(
      `UPDATE leads
       SET 
         ${cols.status} = 'failed',
         ${cols.error} = $2,
         ${cols.completedAt} = NOW()
       WHERE id = $1 AND ${cols.jobId} = $3`,
      [leadId, error, jobId]
    );
    console.log(`[Webhook:${stage}] Lead ${leadId} failed: ${error}`);
  } else {
    // Retriable - requeue
    await getPool().query(
      `UPDATE leads
       SET 
         ${cols.status} = 'queued',
         ${cols.jobId} = NULL,
         ${cols.retryCount} = ${cols.retryCount} + 1,
         ${cols.error} = $2,
         ${cols.startedAt} = NULL
       WHERE id = $1 AND ${cols.jobId} = $3`,
      [leadId, error, jobId]
    );
    console.log(`[Webhook:${stage}] Lead ${leadId} failed (retriable), requeued: ${error}`);
  }
}

// =============================================================================
// EXPRESS ROUTER
// =============================================================================

export const webhookRouter = Router();

// Capture raw body for signature validation
webhookRouter.use((req: Request, _res: Response, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    (req as Request & { rawBody: string }).rawBody = data;
    try {
      req.body = JSON.parse(data);
    } catch {
      req.body = {};
    }
    next();
  });
});

/**
 * Webhook endpoint for job completion notifications.
 * 
 * POST /webhooks/job-complete
 * 
 * Expected payload:
 * {
 *   "jobId": "job_abc123",
 *   "stage": "scrape",
 *   "leadId": "lead_xyz789",
 *   "status": "completed" | "failed",
 *   "result": { ... },  // if completed
 *   "error": "...",     // if failed
 *   "timestamp": "2024-01-15T10:30:00Z"
 * }
 */
webhookRouter.post('/job-complete', async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  try {
    // Validate signature
    const signature = req.headers['x-webhook-signature'] as string | undefined;
    const rawBody = (req as Request & { rawBody: string }).rawBody;
    
    if (!validateSignature(rawBody, signature)) {
      console.warn('[Webhook] Invalid signature');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
    
    const payload = req.body as WebhookPayload;
    
    // Validate required fields
    if (!payload.jobId || !payload.stage || !payload.leadId || !payload.status) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }
    
    // Validate stage
    if (!STAGES[payload.stage]) {
      res.status(400).json({ error: `Invalid stage: ${payload.stage}` });
      return;
    }
    
    // Log webhook first (for debugging/replay)
    const logId = await logWebhook(payload);
    
    // Check idempotency - was this already processed?
    const alreadyProcessed = await isAlreadyProcessed(
      payload.stage,
      payload.leadId,
      payload.jobId
    );
    
    if (alreadyProcessed) {
      console.log(`[Webhook:${payload.stage}] Already processed: ${payload.jobId}`);
      res.status(200).json({ status: 'already_processed' });
      return;
    }
    
    // Process the completion
    if (payload.status === 'completed') {
      await markCompleted(payload.stage, payload.leadId, payload.jobId, payload.result);
    } else {
      await handleJobFailure(
        payload.stage,
        payload.leadId,
        payload.jobId,
        payload.error || 'Unknown error'
      );
    }
    
    // Mark webhook as processed
    if (logId) {
      await markWebhookProcessed(logId);
    }
    
    const duration = Date.now() - startTime;
    console.log(`[Webhook:${payload.stage}] Processed ${payload.jobId} in ${duration}ms`);
    
    res.status(200).json({ status: 'processed' });
  } catch (error) {
    console.error('[Webhook] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Health check for webhook endpoint.
 */
webhookRouter.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'healthy' });
});

// =============================================================================
// WEBHOOK LOGS TABLE (Add to schema.sql)
// =============================================================================

/*
-- Add this to your schema.sql for webhook logging:

create table if not exists webhook_logs (
  id uuid primary key default gen_random_uuid(),
  payload jsonb not null,
  processed boolean not null default false,
  created_at timestamptz not null default now(),
  
  -- Prevent duplicate logs using payload hash
  payload_hash text generated always as (md5(payload::text)) stored,
  constraint unique_payload unique (payload_hash)
);

create index if not exists idx_webhook_logs_unprocessed 
  on webhook_logs(created_at) 
  where processed = false;
*/

// =============================================================================
// EXAMPLE USAGE
// =============================================================================

// Mount in your Express app:
//
// import express from 'express';
// import { webhookRouter } from './webhook-handler.js';
//
// const app = express();
// app.use('/webhooks', webhookRouter);
//
// // Now external services can POST to:
// // POST /webhooks/job-complete

// =============================================================================
// CONFIGURING EXTERNAL SERVICES
// =============================================================================

// When submitting jobs to external services, include a webhook URL:
//
// For playwright-scraper:
// {
//   "url": "https://example.com",
//   "webhookUrl": "https://your-app.com/webhooks/job-complete",
//   "metadata": { "leadId": "...", "stage": "scrape" }
// }
//
// For LLM batch API:
// {
//   "stage": "intel",
//   "webhookUrl": "https://your-app.com/webhooks/job-complete",
//   "requests": [...]
// }
