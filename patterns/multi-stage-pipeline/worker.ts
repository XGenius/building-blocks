/**
 * Stage Worker
 * 
 * Polls the database for entities with `stage_status = 'queued'`,
 * claims them atomically using FOR UPDATE SKIP LOCKED,
 * submits to the appropriate service, and updates status to 'started'.
 * 
 * This worker does NOT wait for job completion - that's handled by
 * completion-poller.ts or webhook-handler.ts.
 * 
 * Usage:
 *   1. Copy this file into your project
 *   2. Configure stage-config.ts with your pipeline
 *   3. Implement submitToService() for your services
 *   4. Call startWorker('scrape') for each stage you want to process
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

interface Lead {
  id: string;
  email: string;
  company_url: string;
  [key: string]: unknown;  // Other fields vary by stage
}

interface SubmitResult {
  jobId: string;
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
// SERVICE SUBMISSION
// =============================================================================

/**
 * Submit work to the appropriate service and get back a job ID.
 * 
 * IMPLEMENT THIS for your specific services.
 * The implementation should:
 *   1. Call the external service with the lead data
 *   2. Return the job ID for completion tracking
 *   3. Throw on error (will be caught and handled as failure)
 */
async function submitToService(
  stage: StageName,
  lead: Lead
): Promise<SubmitResult> {
  const stageConfig = STAGES[stage];
  const serviceConfig = getServiceConfig(stageConfig.service);
  
  // Build request based on service type
  if (stageConfig.service === 'scraper') {
    // Example: Submit to playwright-scraper
    const response = await fetch(`${serviceConfig.baseUrl}/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(serviceConfig.authToken && { 'X-Auth-Token': serviceConfig.authToken }),
      },
      body: JSON.stringify({
        url: lead.company_url,
        maxPages: 20,
        // Include lead ID in metadata for webhook callbacks
        metadata: { leadId: lead.id, stage },
      }),
      signal: AbortSignal.timeout(serviceConfig.timeout),
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Scraper submission failed: ${response.status} ${error}`);
    }
    
    const result = await response.json() as { id: string };
    return { jobId: result.id };
  }
  
  if (stageConfig.service === 'llm') {
    // Example: Submit to LLM batch API
    // Build prompt based on stage
    const prompt = buildPromptForStage(stage, lead);
    
    const response = await fetch(`${serviceConfig.baseUrl}/v1/messages/batches`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(serviceConfig.authToken && { 'Authorization': `Bearer ${serviceConfig.authToken}` }),
      },
      body: JSON.stringify({
        stage,
        requests: [{
          custom_id: `lead_${lead.id}_${stage}`,
          params: prompt,
          metadata: { leadId: lead.id },
        }],
      }),
      signal: AbortSignal.timeout(serviceConfig.timeout),
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LLM submission failed: ${response.status} ${error}`);
    }
    
    const result = await response.json() as { id: string };
    return { jobId: result.id };
  }
  
  throw new Error(`Unknown service: ${stageConfig.service}`);
}

/**
 * Build the prompt for an LLM stage.
 * CUSTOMIZE THIS for your specific stages.
 */
function buildPromptForStage(stage: StageName, lead: Lead): {
  system: string;
  messages: Array<{ role: 'user'; content: string }>;
  max_tokens: number;
  temperature: number;
} {
  // Get previous stage results for context
  const scrapeResult = lead.scrape_result as { pages?: Array<{ content: string }> } | null;
  const intelResult = lead.intel_result as { report?: string } | null;
  const strategyResult = lead.strategy_result as { strategy?: string } | null;
  const subjectResult = lead.subject_result as { subjects?: string[] } | null;
  
  switch (stage) {
    case 'intel':
      return {
        system: 'You are a sales intelligence analyst. Analyze the company information and generate a detailed report.',
        messages: [{
          role: 'user',
          content: `Analyze this company:\n\nCompany: ${lead.company_name}\nWebsite content:\n${scrapeResult?.pages?.map(p => p.content).join('\n\n') || 'No content'}`,
        }],
        max_tokens: 2048,
        temperature: 0.3,
      };
      
    case 'strategy':
      return {
        system: 'You are a sales strategist. Create a personalized outreach strategy.',
        messages: [{
          role: 'user',
          content: `Create outreach strategy for:\n\nContact: ${lead.contact_name} at ${lead.company_name}\n\nIntelligence Report:\n${intelResult?.report || 'No intel'}`,
        }],
        max_tokens: 1024,
        temperature: 0.4,
      };
      
    case 'subject':
      return {
        system: 'You are a copywriter. Generate compelling email subject lines.',
        messages: [{
          role: 'user',
          content: `Generate 5 subject lines for:\n\nContact: ${lead.contact_name}\nStrategy:\n${strategyResult?.strategy || 'No strategy'}`,
        }],
        max_tokens: 256,
        temperature: 0.7,
      };
      
    case 'messaging':
      return {
        system: 'You are a sales copywriter. Write a personalized cold email.',
        messages: [{
          role: 'user',
          content: `Write email for:\n\nContact: ${lead.contact_name} at ${lead.company_name}\nSubject: ${subjectResult?.subjects?.[0] || 'No subject'}\nStrategy:\n${strategyResult?.strategy || 'No strategy'}`,
        }],
        max_tokens: 1024,
        temperature: 0.5,
      };
      
    default:
      throw new Error(`No prompt template for stage: ${stage}`);
  }
}

// =============================================================================
// QUEUE PROCESSING
// =============================================================================

/**
 * Atomically claim leads for processing using FOR UPDATE SKIP LOCKED.
 * This prevents race conditions when multiple workers run simultaneously.
 */
async function claimLeads(
  stage: StageName,
  limit: number
): Promise<Lead[]> {
  const cols = getStageColumns(stage);
  
  const result = await getPool().query<Lead>(
    `UPDATE leads
     SET 
       ${cols.status} = 'started',
       ${cols.startedAt} = NOW()
     WHERE id IN (
       SELECT id FROM leads
       WHERE ${cols.status} = 'queued'
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
 * Update lead with job ID after successful submission.
 */
async function markSubmitted(
  stage: StageName,
  leadId: string,
  jobId: string
): Promise<void> {
  const cols = getStageColumns(stage);
  
  await getPool().query(
    `UPDATE leads
     SET ${cols.jobId} = $2
     WHERE id = $1`,
    [leadId, jobId]
  );
}

/**
 * Handle submission failure - retry or fail permanently.
 */
async function handleSubmissionFailure(
  stage: StageName,
  leadId: string,
  error: string
): Promise<void> {
  const cols = getStageColumns(stage);
  const stageConfig = STAGES[stage];
  const errorType = classifyError(error);
  
  if (errorType === 'hard') {
    // Hard failure - mark as failed immediately
    await getPool().query(
      `UPDATE leads
       SET 
         ${cols.status} = 'failed',
         ${cols.error} = $2,
         ${cols.completedAt} = NOW()
       WHERE id = $1`,
      [leadId, error]
    );
    console.log(`[Worker:${stage}] Lead ${leadId} failed (hard): ${error}`);
  } else {
    // Retriable - increment retry count and requeue or fail
    await getPool().query(
      `UPDATE leads
       SET 
         ${cols.status} = CASE 
           WHEN ${cols.retryCount} >= $2 THEN 'failed'
           ELSE 'queued'
         END,
         ${cols.retryCount} = ${cols.retryCount} + 1,
         ${cols.error} = $3,
         ${cols.startedAt} = NULL,
         ${cols.completedAt} = CASE 
           WHEN ${cols.retryCount} >= $2 THEN NOW()
           ELSE NULL
         END
       WHERE id = $1`,
      [leadId, stageConfig.maxRetries, error]
    );
    console.log(`[Worker:${stage}] Lead ${leadId} submission failed (retriable): ${error}`);
  }
}

/**
 * Process one cycle of the queue for a stage.
 */
async function processCycle(stage: StageName): Promise<{ submitted: number; failed: number }> {
  let submitted = 0;
  let failed = 0;
  
  try {
    // Claim leads atomically
    const leads = await claimLeads(stage, QUEUE_CONFIG.batchSize);
    
    if (leads.length === 0) {
      return { submitted: 0, failed: 0 };
    }
    
    console.log(`[Worker:${stage}] Claimed ${leads.length} leads`);
    
    // Submit each lead to the service
    // Process in parallel since we're just submitting (not waiting)
    const results = await Promise.allSettled(
      leads.map(async (lead) => {
        try {
          const { jobId } = await submitToService(stage, lead);
          await markSubmitted(stage, lead.id, jobId);
          console.log(`[Worker:${stage}] Lead ${lead.id} submitted, jobId: ${jobId}`);
          return 'success';
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          await handleSubmissionFailure(stage, lead.id, errorMsg);
          return 'failed';
        }
      })
    );
    
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value === 'success') {
        submitted++;
      } else {
        failed++;
      }
    }
    
    return { submitted, failed };
  } catch (error) {
    console.error(`[Worker:${stage}] Cycle error:`, error);
    return { submitted, failed };
  }
}

// =============================================================================
// WORKER LOOP
// =============================================================================

const activeWorkers: Map<StageName, boolean> = new Map();
const workerTimeouts: Map<StageName, NodeJS.Timeout> = new Map();

/**
 * Start a worker for a specific stage.
 * The worker will poll for queued items and submit them to the service.
 */
export async function startWorker(stage: StageName): Promise<void> {
  if (activeWorkers.get(stage)) {
    console.log(`[Worker:${stage}] Already running`);
    return;
  }
  
  activeWorkers.set(stage, true);
  console.log(`[Worker:${stage}] Starting with poll interval ${QUEUE_CONFIG.pollIntervalMs}ms`);
  
  const runCycle = async () => {
    if (!activeWorkers.get(stage)) return;
    
    try {
      const { submitted, failed } = await processCycle(stage);
      if (submitted > 0 || failed > 0) {
        console.log(`[Worker:${stage}] Cycle: ${submitted} submitted, ${failed} failed`);
      }
    } catch (error) {
      console.error(`[Worker:${stage}] Error:`, error);
    }
    
    // Schedule next cycle
    if (activeWorkers.get(stage)) {
      const timeout = setTimeout(runCycle, QUEUE_CONFIG.pollIntervalMs);
      workerTimeouts.set(stage, timeout);
    }
  };
  
  // Run first cycle immediately
  await runCycle();
}

/**
 * Stop a worker for a specific stage.
 */
export function stopWorker(stage: StageName): void {
  activeWorkers.set(stage, false);
  const timeout = workerTimeouts.get(stage);
  if (timeout) {
    clearTimeout(timeout);
    workerTimeouts.delete(stage);
  }
  console.log(`[Worker:${stage}] Stopped`);
}

/**
 * Stop all workers and close the database pool.
 */
export async function shutdown(): Promise<void> {
  console.log('[Worker] Shutting down all workers...');
  
  for (const stage of activeWorkers.keys()) {
    stopWorker(stage);
  }
  
  await closePool();
  console.log('[Worker] Shutdown complete');
}

// =============================================================================
// EXAMPLE USAGE
// =============================================================================

// Start workers for all stages:
//
// import { startWorker, shutdown } from './worker.js';
//
// // Start workers for each stage
// await startWorker('scrape');
// await startWorker('intel');
// await startWorker('strategy');
// await startWorker('subject');
// await startWorker('messaging');
//
// // Graceful shutdown
// process.on('SIGTERM', shutdown);
// process.on('SIGINT', shutdown);
