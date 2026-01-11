/**
 * Multi-Provider Webhook Handler Pattern
 *
 * Handles webhooks from multiple providers with:
 * - Atomic claiming to prevent duplicate processing
 * - Type-based routing to specific handlers
 * - Idempotency checks
 * - Error tracking and logging
 *
 * Usage:
 * 1. Create the webhook_logs table (see schema.sql)
 * 2. Register handlers for each webhook type
 * 3. Create Express routes using createWebhookRoute()
 * 4. Start the processor on server startup
 */

import { db } from "../db"; // Your database connection
import { sql, eq, and } from "drizzle-orm";
// import { webhookLogs } from "../schema"; // Your webhook_logs table

// =============================================================================
// CONFIGURATION
// =============================================================================

const POLL_INTERVAL_MS = 5000; // Check for new webhooks every 5 seconds
const BATCH_SIZE = 10; // Process up to 10 webhooks per cycle

// =============================================================================
// TYPES
// =============================================================================

interface WebhookLog {
  id: string;
  webhookType: string;
  accountId: string | null;
  requestBody: unknown;
  status: "received" | "processing" | "processed" | "error" | "ignored";
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

type WebhookHandler = (webhook: WebhookLog) => Promise<void>;

// =============================================================================
// HANDLER REGISTRY
// =============================================================================

const handlers: Record<string, WebhookHandler> = {};

/**
 * Register a handler for a webhook type
 *
 * @param type - The webhook type (e.g., 'stripe', 'sendgrid')
 * @param handler - Async function to process webhooks of this type
 *
 * Example:
 *   registerHandler('stripe', async (webhook) => {
 *     const event = webhook.requestBody as Stripe.Event;
 *     // Handle the event...
 *   });
 */
export function registerHandler(type: string, handler: WebhookHandler): void {
  handlers[type] = handler;
  console.log(`[WebhookHandler] Registered handler for type: ${type}`);
}

/**
 * Get all registered handler types
 */
export function getRegisteredTypes(): string[] {
  return Object.keys(handlers);
}

// =============================================================================
// DATABASE OPERATIONS
// =============================================================================

/**
 * Update webhook status
 */
async function updateWebhookStatus(
  id: string,
  status: WebhookLog["status"],
  extra?: { errorMessage?: string; metadata?: Record<string, unknown> }
): Promise<void> {
  // REPLACE: Use your actual table and ORM syntax
  await db.execute(sql`
    UPDATE webhook_logs
    SET 
      status = ${status},
      ${extra?.errorMessage ? sql`error_message = ${extra.errorMessage},` : sql``}
      ${extra?.metadata ? sql`metadata = ${JSON.stringify(extra.metadata)}::jsonb,` : sql``}
      updated_at = NOW()
    WHERE id = ${id}
  `);
}

/**
 * Get webhooks with status 'received'
 */
async function getReceivedWebhooks(limit: number): Promise<WebhookLog[]> {
  const result = await db.execute(sql`
    SELECT * FROM webhook_logs
    WHERE status = 'received'
    ORDER BY created_at
    LIMIT ${limit}
  `);
  return result.rows as WebhookLog[];
}

/**
 * Atomically claim a webhook for processing
 * Returns true if claimed, false if already claimed by another instance
 */
async function claimWebhook(id: string): Promise<boolean> {
  const claimed = await db.execute(sql`
    UPDATE webhook_logs
    SET status = 'processing', updated_at = NOW()
    WHERE id = ${id} AND status = 'received'
    RETURNING id
  `);
  return claimed.rows.length > 0;
}

// =============================================================================
// CORE PROCESSING
// =============================================================================

/**
 * Process received webhooks with atomic claiming
 */
export async function processReceivedWebhooks(): Promise<{
  processed: number;
  errors: number;
}> {
  let processed = 0;
  let errors = 0;

  const receivedWebhooks = await getReceivedWebhooks(BATCH_SIZE);

  for (const webhook of receivedWebhooks) {
    try {
      // ATOMIC CLAIM: Only succeeds if status is still 'received'
      const claimed = await claimWebhook(webhook.id);

      if (!claimed) {
        console.log(
          `[WebhookHandler] Webhook ${webhook.id} already claimed, skipping`
        );
        continue;
      }

      // Find handler for this type
      const handler = handlers[webhook.webhookType];

      if (!handler) {
        console.warn(
          `[WebhookHandler] No handler for type: ${webhook.webhookType}`
        );
        await updateWebhookStatus(webhook.id, "ignored", {
          metadata: { reason: "no_handler_registered" },
        });
        continue;
      }

      // Execute handler
      await handler(webhook);

      // Mark as processed
      await updateWebhookStatus(webhook.id, "processed");
      processed++;

      console.log(
        `[WebhookHandler] Processed ${webhook.webhookType} webhook ${webhook.id}`
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error(
        `[WebhookHandler] Error processing ${webhook.id}:`,
        errorMessage
      );

      await updateWebhookStatus(webhook.id, "error", { errorMessage });
      errors++;
    }
  }

  return { processed, errors };
}

/**
 * Start the webhook processor with interval polling
 */
export async function startWebhookProcessor(): Promise<void> {
  console.log(
    `[WebhookHandler] Starting processor with ${POLL_INTERVAL_MS}ms interval`
  );

  const runCycle = async () => {
    try {
      const result = await processReceivedWebhooks();
      if (result.processed > 0 || result.errors > 0) {
        console.log(
          `[WebhookHandler] Cycle: ${result.processed} processed, ${result.errors} errors`
        );
      }
    } catch (error) {
      console.error("[WebhookHandler] Cycle error:", error);
    }
  };

  // Run immediately
  await runCycle();

  // Then on interval
  setInterval(runCycle, POLL_INTERVAL_MS);
}

// =============================================================================
// EXPRESS ROUTE FACTORY
// =============================================================================

/**
 * Create an Express route handler for incoming webhooks
 *
 * The route:
 * 1. Logs the webhook immediately (status='received')
 * 2. Returns 200 immediately (don't block the sender)
 * 3. Background processor handles it asynchronously
 *
 * @param type - The webhook type for routing
 *
 * Example:
 *   app.post('/webhooks/stripe', createWebhookRoute('stripe'));
 */
export function createWebhookRoute(type: string) {
  return async (req: any, res: any) => {
    try {
      // Extract account ID if available (e.g., from auth middleware or query param)
      const accountId = req.accountId || req.query.accountId || null;

      // Log the webhook immediately
      const result = await db.execute(sql`
        INSERT INTO webhook_logs (webhook_type, account_id, request_body, status)
        VALUES (${type}, ${accountId}, ${JSON.stringify(req.body)}::jsonb, 'received')
        RETURNING id
      `);

      const webhookId = (result.rows[0] as { id: string }).id;

      console.log(`[WebhookHandler] Received ${type} webhook: ${webhookId}`);

      // Respond immediately - processing happens asynchronously
      res.status(200).json({ received: true, id: webhookId });
    } catch (error) {
      console.error(`[WebhookHandler] Error logging webhook:`, error);
      res.status(500).json({ error: "Failed to log webhook" });
    }
  };
}

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Retry failed webhooks (useful for manual retry via admin panel)
 */
export async function retryFailedWebhook(webhookId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE webhook_logs
    SET status = 'received', error_message = NULL, updated_at = NOW()
    WHERE id = ${webhookId} AND status = 'error'
    RETURNING id
  `);

  if (result.rows.length > 0) {
    console.log(`[WebhookHandler] Webhook ${webhookId} queued for retry`);
    return true;
  }
  return false;
}

/**
 * Get webhook stats for monitoring
 */
export async function getWebhookStats(): Promise<{
  received: number;
  processing: number;
  processed: number;
  error: number;
  ignored: number;
}> {
  const result = await db.execute(sql`
    SELECT status, COUNT(*)::int as count
    FROM webhook_logs
    WHERE created_at > NOW() - INTERVAL '24 hours'
    GROUP BY status
  `);

  const stats = {
    received: 0,
    processing: 0,
    processed: 0,
    error: 0,
    ignored: 0,
  };

  for (const row of result.rows as { status: string; count: number }[]) {
    if (row.status in stats) {
      stats[row.status as keyof typeof stats] = row.count;
    }
  }

  return stats;
}
