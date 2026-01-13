/**
 * Completion Poller
 * 
 * Polls external services to detect when jobs complete, then:
 *   1. Updates the entity status to 'completed' (or 'failed')
 *   2. Stores the result
 *   3. Triggers the next stage by setting its status to 'queued'
 * 
 * This is the polling-based approach to job completion detection.
 * For webhook-based detection, see webhook-handler.ts.
 * 
 * Usage:
 *   1. Copy this file into your project
 *   2. Implement checkJobStatus() for your services
 *   3. Call startCompletionPoller('scrape') for each stage
 */

import pg from "pg";
import { 
  StageName, 
  STAGES, 
  QUEUE_CONFIG,
  getStageColumns,
  getServiceConfig,
  classifyError,
} from "./stage-config.js";

const { Pool } = pg;

// =============================================================================
// TYPES
// =============================================================================

interface LeadWithJob {
  id: string;
  job_id: string;
  started_at: Date;
  retry_count: number;
}

interface JobStatus {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
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

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// =============================================================================
// SERVICE STATUS CHECKING
// =============================================================================

/**
 * Check the status of a job with the external service.
 * 
 * IMPLEMENT THIS for your specific services.
 */
async function checkJobStatus(
  stage: StageName,
  jobId: string
): Promise<JobStatus> {
  const stageConfig = STAGES[stage];
  const serviceConfig = getServiceConfig(stageConfig.service);
  
  if (stageConfig.service === 'scraper') {
    // Check playwright-scraper job status
    const response = await fetch(`${serviceConfig.baseUrl}/jobs/${jobId}`, {
      headers: {
        ...(serviceConfig.authToken && { 'X-Auth-Token': serviceConfig.authToken }),
      },
      signal: AbortSignal.timeout(10000),
    });
    
    if (!response.ok) {
      if (response.status === 404) {
        return { status: 'failed', error: 'Job not found' };
      }
      throw new Error(`Failed to check job status: ${response.status}`);
    }
    
    const job = await response.json() as {
      status: string;
      result?: unknown;
      error?: string;
    };
    
    // Map scraper status to our status
    switch (job.status) {
      case 'completed':
        return { status: 'completed', result: job.result };
      case 'failed':
        return { status: 'failed', error: job.error };
      case 'queued':
        return { status: 'pending' };
      case 'started':
      default:
        return { status: 'processing' };
    }
  }
  
  if (stageConfig.service === 'llm') {
    // Check LLM batch API status
    const response = await fetch(`${serviceConfig.baseUrl}/v1/messages/batches/${jobId}`, {
      headers: {
        ...(serviceConfig.authToken && { 'Authorization': `Bearer ${serviceConfig.authToken}` }),
      },
      signal: AbortSignal.timeout(10000),
    });
    
    if (!response.ok) {
      if (response.status === 404) {
        return { status: 'failed', error: 'Batch not found' };
      }
      throw new Error(`Failed to check batch status: ${response.status}`);
    }
    
    const batch = await response.json() as {
      processing_status: string;
      counts: { succeeded: number; errored: number };
    };
    
    if (batch.processing_status === 'ended') {
      // Get results
      const resultsResponse = await fetch(
        `${serviceConfig.baseUrl}/v1/messages/batches/${jobId}/results`,
        {
          headers: {
            ...(serviceConfig.authToken && { 'Authorization': `Bearer ${serviceConfig.authToken}` }),
          },
        }
      );
      
      if (resultsResponse.ok) {
        const { results } = await resultsResponse.json() as { results: unknown[] };
        // For single-lead batches, return the first result
        const firstResult = results[0] as { status: string; message?: unknown; error?: { message: string } };
        
        if (firstResult?.status === 'succeeded') {
          return { status: 'completed', result: firstResult.message };
        } else {
          return { status: 'failed', error: firstResult?.error?.message || 'Unknown error' };
        }
      }
    }
    
    return { status: 'processing' };
  }
  
  throw new Error(`Unknown service: ${stageConfig.service}`);
}

// =============================================================================
// COMPLETION HANDLING
// =============================================================================

/**
 * Find leads that are waiting for job completion.
 */
async function findStartedLeads(
  stage: StageName,
  limit: number
): Promise<LeadWithJob[]> {
  const cols = getStageColumns(stage);
  
  const result = await getPool().query<LeadWithJob>(
    `SELECT 
       id,
       ${cols.jobId} as job_id,
       ${cols.startedAt} as started_at,
       ${cols.retryCount} as retry_count
     FROM leads
     WHERE ${cols.status} = 'started'
       AND ${cols.jobId} IS NOT NULL
     ORDER BY ${cols.startedAt}
     LIMIT $1`,
    [limit]
  );
  
  return result.rows;
}

/**
 * Mark a lead as completed and trigger the next stage.
 */
async function markCompleted(
  stage: StageName,
  leadId: string,
  result: unknown
): Promise<void> {
  const cols = getStageColumns(stage);
  const stageConfig = STAGES[stage];
  const nextCols = stageConfig.next ? getStageColumns(stageConfig.next) : null;
  
  // Update current stage to completed and trigger next stage
  if (nextCols) {
    await getPool().query(
      `UPDATE leads
       SET 
         ${cols.status} = 'completed',
         ${cols.result} = $2,
         ${cols.completedAt} = NOW(),
         ${nextCols.status} = 'queued'
       WHERE id = $1`,
      [leadId, JSON.stringify(result)]
    );
    console.log(`[Poller:${stage}] Lead ${leadId} completed, triggered ${stageConfig.next}`);
  } else {
    // Final stage - just mark as completed
    await getPool().query(
      `UPDATE leads
       SET 
         ${cols.status} = 'completed',
         ${cols.result} = $2,
         ${cols.completedAt} = NOW()
       WHERE id = $1`,
      [leadId, JSON.stringify(result)]
    );
    console.log(`[Poller:${stage}] Lead ${leadId} completed (final stage)`);
  }
}

/**
 * Handle job failure - retry or fail permanently.
 */
async function handleJobFailure(
  stage: StageName,
  leadId: string,
  error: string,
  currentRetryCount: number
): Promise<void> {
  const cols = getStageColumns(stage);
  const stageConfig = STAGES[stage];
  const errorType = classifyError(error);
  
  if (errorType === 'hard' || currentRetryCount >= stageConfig.maxRetries) {
    // Hard failure or max retries reached
    await getPool().query(
      `UPDATE leads
       SET 
         ${cols.status} = 'failed',
         ${cols.error} = $2,
         ${cols.completedAt} = NOW()
       WHERE id = $1`,
      [leadId, error]
    );
    console.log(`[Poller:${stage}] Lead ${leadId} failed: ${error}`);
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
       WHERE id = $1`,
      [leadId, error]
    );
    console.log(`[Poller:${stage}] Lead ${leadId} failed (retriable), requeued: ${error}`);
  }
}

/**
 * Handle stuck jobs (started but no progress for too long).
 */
async function handleStuckJobs(stage: StageName): Promise<number> {
  const cols = getStageColumns(stage);
  const stageConfig = STAGES[stage];
  const stuckThreshold = new Date(Date.now() - stageConfig.stuckTimeoutMs);
  
  const result = await getPool().query(
    `UPDATE leads
     SET 
       ${cols.status} = CASE 
         WHEN ${cols.retryCount} >= $2 THEN 'failed'
         ELSE 'queued'
       END,
       ${cols.retryCount} = ${cols.retryCount} + 1,
       ${cols.error} = 'Job stuck or timed out',
       ${cols.jobId} = NULL,
       ${cols.startedAt} = NULL,
       ${cols.completedAt} = CASE 
         WHEN ${cols.retryCount} >= $2 THEN NOW()
         ELSE NULL
       END
     WHERE ${cols.status} = 'started'
       AND ${cols.startedAt} < $1
     RETURNING id`,
    [stuckThreshold, stageConfig.maxRetries]
  );
  
  if (result.rows.length > 0) {
    console.log(`[Poller:${stage}] Reset ${result.rows.length} stuck jobs`);
  }
  
  return result.rows.length;
}

/**
 * Process one polling cycle for a stage.
 */
async function pollCycle(stage: StageName): Promise<{ completed: number; failed: number }> {
  let completed = 0;
  let failed = 0;
  
  try {
    // First, handle any stuck jobs
    await handleStuckJobs(stage);
    
    // Find leads waiting for completion
    const leads = await findStartedLeads(stage, QUEUE_CONFIG.batchSize * 2);
    
    if (leads.length === 0) {
      return { completed: 0, failed: 0 };
    }
    
    // Check status of each job
    const results = await Promise.allSettled(
      leads.map(async (lead) => {
        try {
          const jobStatus = await checkJobStatus(stage, lead.job_id);
          
          switch (jobStatus.status) {
            case 'completed':
              await markCompleted(stage, lead.id, jobStatus.result);
              return 'completed';
              
            case 'failed':
              await handleJobFailure(stage, lead.id, jobStatus.error || 'Unknown error', lead.retry_count);
              return 'failed';
              
            case 'pending':
            case 'processing':
            default:
              // Still processing, do nothing
              return 'pending';
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          console.error(`[Poller:${stage}] Error checking job ${lead.job_id}:`, errorMsg);
          // Don't update status on check error - will retry next cycle
          return 'error';
        }
      })
    );
    
    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value === 'completed') completed++;
        if (result.value === 'failed') failed++;
      }
    }
    
    return { completed, failed };
  } catch (error) {
    console.error(`[Poller:${stage}] Cycle error:`, error);
    return { completed, failed };
  }
}

// =============================================================================
// POLLER LOOP
// =============================================================================

const activePollers: Map<StageName, boolean> = new Map();
const pollerTimeouts: Map<StageName, NodeJS.Timeout> = new Map();

/**
 * Start a completion poller for a specific stage.
 */
export async function startCompletionPoller(stage: StageName): Promise<void> {
  if (activePollers.get(stage)) {
    console.log(`[Poller:${stage}] Already running`);
    return;
  }
  
  const stageConfig = STAGES[stage];
  activePollers.set(stage, true);
  console.log(`[Poller:${stage}] Starting with poll interval ${stageConfig.pollIntervalMs}ms`);
  
  const runCycle = async () => {
    if (!activePollers.get(stage)) return;
    
    try {
      const { completed, failed } = await pollCycle(stage);
      if (completed > 0 || failed > 0) {
        console.log(`[Poller:${stage}] Cycle: ${completed} completed, ${failed} failed`);
      }
    } catch (error) {
      console.error(`[Poller:${stage}] Error:`, error);
    }
    
    // Schedule next cycle
    if (activePollers.get(stage)) {
      const timeout = setTimeout(runCycle, stageConfig.pollIntervalMs);
      pollerTimeouts.set(stage, timeout);
    }
  };
  
  // Run first cycle immediately
  await runCycle();
}

/**
 * Stop a completion poller for a specific stage.
 */
export function stopCompletionPoller(stage: StageName): void {
  activePollers.set(stage, false);
  const timeout = pollerTimeouts.get(stage);
  if (timeout) {
    clearTimeout(timeout);
    pollerTimeouts.delete(stage);
  }
  console.log(`[Poller:${stage}] Stopped`);
}

/**
 * Stop all pollers and close the database pool.
 */
export async function shutdown(): Promise<void> {
  console.log('[Poller] Shutting down all pollers...');
  
  for (const stage of activePollers.keys()) {
    stopCompletionPoller(stage);
  }
  
  await closePool();
  console.log('[Poller] Shutdown complete');
}

// =============================================================================
// EXAMPLE USAGE
// =============================================================================

// Start completion pollers for all stages:
//
// import { startCompletionPoller, shutdown } from './completion-poller.js';
//
// await startCompletionPoller('scrape');
// await startCompletionPoller('intel');
// await startCompletionPoller('strategy');
// await startCompletionPoller('subject');
// await startCompletionPoller('messaging');
//
// process.on('SIGTERM', shutdown);
// process.on('SIGINT', shutdown);
