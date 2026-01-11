/**
 * Atomic Job Processor Pattern
 *
 * Prevents race conditions when multiple processor instances run simultaneously.
 * Uses PostgreSQL's FOR UPDATE SKIP LOCKED for atomic claiming.
 *
 * Usage:
 * 1. Copy this file into your project
 * 2. Replace table/column names with your schema
 * 3. Implement your processing logic in processItem()
 * 4. Call startProcessor() on server startup
 */

import { db } from "../db"; // Your database connection
import { sql, eq } from "drizzle-orm";
// import { yourTable, yourOutputTable } from "../schema"; // Your tables

// =============================================================================
// CONFIGURATION - Adjust for your use case
// =============================================================================

const BATCH_SIZE = 5; // Jobs to claim per cycle
const POLL_INTERVAL_MS = 5000; // 5 seconds between cycles
const STUCK_TIMEOUT_MINUTES = 5; // Reset jobs stuck longer than this

// =============================================================================
// TYPES - Replace with your actual types
// =============================================================================

interface QueuedItem {
  id: string;
  status: string;
  startedAt: Date | null;
  // ... your other fields
}

interface ProcessResult {
  processed: number;
  failed: number;
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Atomically claim items from the queue using FOR UPDATE SKIP LOCKED
 *
 * This is the key pattern that prevents race conditions:
 * - UPDATE and SELECT happen in one atomic operation
 * - SKIP LOCKED means we skip rows already being processed by other instances
 * - Only rows we successfully claim are returned
 */
async function claimItems(limit: number = BATCH_SIZE): Promise<QueuedItem[]> {
  // REPLACE: your_table, status column names, etc.
  const claimed = await db.execute(sql`
    UPDATE your_table
    SET 
      status = 'started',
      started_at = NOW(),
      updated_at = NOW()
    WHERE id IN (
      SELECT id FROM your_table
      WHERE status = 'queued'
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  return claimed.rows as QueuedItem[];
}

/**
 * Reset items stuck in 'started' state (from crashed processors)
 *
 * IMPORTANT: Before resetting, check if the work was actually completed
 * (the processor may have crashed after doing the work but before updating status)
 */
async function resetStuckItems(): Promise<number> {
  const stuckThreshold = new Date(
    Date.now() - STUCK_TIMEOUT_MINUTES * 60 * 1000
  );

  // Step 1: Mark as completed if output already exists
  // This handles the case where processor crashed after creating output
  const alreadyCompleted = await db.execute(sql`
    UPDATE your_table
    SET status = 'completed', updated_at = NOW()
    WHERE status = 'started'
      AND started_at < ${stuckThreshold}
      AND EXISTS (
        SELECT 1 FROM your_output_table o 
        WHERE o.source_id = your_table.id
      )
    RETURNING id
  `);

  if (alreadyCompleted.rows.length > 0) {
    console.log(
      `[Processor] Marked ${alreadyCompleted.rows.length} stuck items as completed (output exists)`
    );
  }

  // Step 2: Reset truly stuck items (no output exists) for retry
  const reset = await db.execute(sql`
    UPDATE your_table
    SET 
      status = 'queued',
      started_at = NULL,
      updated_at = NOW()
    WHERE status = 'started'
      AND started_at < ${stuckThreshold}
      AND NOT EXISTS (
        SELECT 1 FROM your_output_table o 
        WHERE o.source_id = your_table.id
      )
    RETURNING id
  `);

  if (reset.rows.length > 0) {
    console.log(`[Processor] Reset ${reset.rows.length} stuck items to queued`);
  }

  return reset.rows.length;
}

/**
 * Process a single item
 *
 * IMPLEMENT YOUR LOGIC HERE
 *
 * Key requirements:
 * 1. Check for existing output (idempotency)
 * 2. Do your processing
 * 3. Create output record
 */
async function processItem(item: QueuedItem): Promise<void> {
  // Step 1: IDEMPOTENCY CHECK - Prevent duplicates
  // REPLACE: yourOutputTable, sourceId column
  const existing = await db.execute(sql`
    SELECT id FROM your_output_table
    WHERE source_id = ${item.id}
    LIMIT 1
  `);

  if (existing.rows.length > 0) {
    console.warn(
      `[Processor] DUPLICATE PREVENTED: Output for ${item.id} already exists`
    );
    return; // Skip - work already done
  }

  // Step 2: DO YOUR ACTUAL PROCESSING
  // const result = await yourProcessingFunction(item);

  // Step 3: CREATE OUTPUT RECORD
  // await db.insert(yourOutputTable).values({
  //   sourceId: item.id,
  //   result: result,
  //   createdAt: new Date(),
  // });

  console.log(`[Processor] Processed item ${item.id}`);
}

/**
 * Mark item as completed
 */
async function markCompleted(itemId: string): Promise<void> {
  await db.execute(sql`
    UPDATE your_table
    SET 
      status = 'completed',
      completed_at = NOW(),
      updated_at = NOW()
    WHERE id = ${itemId}
  `);
}

/**
 * Mark item as failed (resets to queued for retry, or marks as failed after N retries)
 */
async function markFailed(itemId: string, error: string): Promise<void> {
  // Option 1: Simple reset to queued for retry
  await db.execute(sql`
    UPDATE your_table
    SET 
      status = 'queued',
      started_at = NULL,
      updated_at = NOW()
    WHERE id = ${itemId}
  `);

  // Option 2: Track retry count and fail permanently after N retries
  // await db.execute(sql`
  //   UPDATE your_table
  //   SET
  //     status = CASE WHEN retry_count >= 3 THEN 'failed' ELSE 'queued' END,
  //     retry_count = retry_count + 1,
  //     last_error = ${error},
  //     started_at = NULL,
  //     updated_at = NOW()
  //   WHERE id = ${itemId}
  // `);
}

// =============================================================================
// MAIN PROCESSING LOOP
// =============================================================================

/**
 * Process one cycle of the queue
 */
export async function processQueue(): Promise<ProcessResult> {
  let processed = 0;
  let failed = 0;

  try {
    // First, handle any stuck items
    await resetStuckItems();

    // Atomically claim items
    const items = await claimItems(BATCH_SIZE);

    if (items.length === 0) {
      return { processed: 0, failed: 0 };
    }

    console.log(`[Processor] Claimed ${items.length} items`);

    // Process each item
    for (const item of items) {
      try {
        await processItem(item);
        await markCompleted(item.id);
        processed++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        console.error(`[Processor] Error processing ${item.id}:`, errorMsg);
        await markFailed(item.id, errorMsg);
        failed++;
      }
    }

    return { processed, failed };
  } catch (error) {
    console.error("[Processor] Fatal error in processQueue:", error);
    return { processed, failed };
  }
}

/**
 * Start the processor with interval polling
 *
 * Call this once on server startup:
 *   startProcessor();
 */
export async function startProcessor(): Promise<void> {
  console.log(
    `[Processor] Starting with ${POLL_INTERVAL_MS}ms interval, batch size ${BATCH_SIZE}`
  );

  const runCycle = async () => {
    try {
      const result = await processQueue();
      if (result.processed > 0 || result.failed > 0) {
        console.log(
          `[Processor] Cycle complete: ${result.processed} processed, ${result.failed} failed`
        );
      }
    } catch (error) {
      console.error("[Processor] Cycle error:", error);
    }
  };

  // Run immediately on startup
  await runCycle();

  // Then run on interval
  setInterval(runCycle, POLL_INTERVAL_MS);
}

// =============================================================================
// OPTIONAL: Cron-triggered processing (for Railway cron jobs)
// =============================================================================

/**
 * Process queue once (for cron job triggers)
 *
 * Use this if you want to trigger processing via Railway cron instead of setInterval.
 * More reliable for long-running apps as it doesn't rely on the event loop.
 *
 * Example Railway cron endpoint:
 *   app.post('/api/cron/process-jobs', async (req, res) => {
 *     const secret = req.headers['x-cron-secret'];
 *     if (secret !== process.env.CRON_SECRET) {
 *       return res.status(401).json({ error: 'Unauthorized' });
 *     }
 *     const result = await processQueueOnce();
 *     res.json(result);
 *   });
 */
export async function processQueueOnce(): Promise<ProcessResult> {
  return processQueue();
}
