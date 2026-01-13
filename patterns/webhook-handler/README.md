# Webhook Handler Pattern

A multi-provider webhook handling pattern with atomic claiming, idempotency, and type-based routing.

## Prerequisites

- [ ] PostgreSQL database (Supabase recommended)
- [ ] Express.js application
- [ ] Public URL for receiving webhooks (use ngrok for local development)

## Human Setup Steps

1. **Set up your database**
   - Create a Supabase project at [supabase.com](https://supabase.com)
   - Get your `DATABASE_URL` from Settings → Database → Connection string

2. **Run the schema migration**
   - Copy `schema.sql` to your migrations folder
   - Run via Supabase SQL Editor or `npm run db:migrate`

3. **Configure webhook endpoints in external services**
   - Stripe: Dashboard → Developers → Webhooks → Add endpoint
   - SendGrid: Settings → Mail Settings → Event Notification
   - Each provider has different setup steps

4. **Set up public URL for development**
   ```bash
   # Use ngrok to expose local server
   ngrok http 5001
   # Copy the https URL and use it as your webhook endpoint
   ```

5. **Configure webhook secrets** (optional but recommended)
   - Get signing secret from each provider
   - Add to your environment variables

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `STRIPE_WEBHOOK_SECRET` | No | Stripe webhook signing secret |
| `SENDGRID_WEBHOOK_KEY` | No | SendGrid webhook verification key |

```bash
# Example .env
DATABASE_URL=postgresql://postgres:password@db.xxx.supabase.co:5432/postgres
STRIPE_WEBHOOK_SECRET=whsec_xxx
```

## The Problem

When receiving webhooks from multiple providers:
- Multiple server instances can process the same webhook
- Webhooks may be delivered multiple times (at-least-once delivery)
- Different providers have different payload formats
- Need reliable error tracking and logging

## The Solution

A webhook handling pattern that:
1. **Logs immediately** - Store webhook before processing
2. **Claims atomically** - Prevent duplicate processing
3. **Routes by type** - Different handlers for different providers
4. **Tracks status** - Processed, ignored, error states
5. **Handles idempotency** - Checks for duplicate payloads

## Usage

1. Copy `handler.ts` into your project
2. Create the `webhook_logs` table (see schema below)
3. Register handlers for each webhook type
4. Create Express routes using `createWebhookRoute()`
5. Start the processor on server startup

## Files

- `handler.ts` - Core webhook handling logic
- `schema.sql` - Database schema for webhook logs
- `README.md` - This documentation

## Key Features

### Immediate Logging

Webhooks are logged immediately, then processed asynchronously:

```typescript
app.post('/webhooks/stripe', createWebhookRoute('stripe'));

// The route:
// 1. Logs the webhook with status='received'
// 2. Returns 200 immediately
// 3. Background processor handles it later
```

### Atomic Claiming

Prevents duplicate processing when multiple instances run:

```typescript
const claimed = await db
  .update(webhookLogs)
  .set({ status: 'processing' })
  .where(
    and(
      eq(webhookLogs.id, webhook.id),
      eq(webhookLogs.status, 'received')  // Only claim if still 'received'
    )
  )
  .returning();

if (claimed.length === 0) {
  // Another instance already claimed it
  continue;
}
```

### Type-Based Routing

Register different handlers for different webhook types:

```typescript
registerHandler('stripe', async (webhook) => {
  // Handle Stripe webhook
});

registerHandler('sendgrid', async (webhook) => {
  // Handle SendGrid webhook
});
```

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_type VARCHAR(50) NOT NULL,
  account_id UUID REFERENCES accounts(id),
  request_body JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'received',
  error_message TEXT,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Index for processor queries
CREATE INDEX IF NOT EXISTS idx_webhook_logs_status 
  ON webhook_logs(status, created_at) 
  WHERE status = 'received';

-- Index for debugging by type
CREATE INDEX IF NOT EXISTS idx_webhook_logs_type 
  ON webhook_logs(webhook_type, created_at);
```

### Status Values

| Status | Meaning |
|--------|---------|
| `received` | Logged, awaiting processing |
| `processing` | Claimed by a processor |
| `processed` | Successfully handled |
| `ignored` | Intentionally skipped (e.g., unknown type) |
| `error` | Failed to process |

## Example: Multi-Provider Setup

```typescript
// routes.ts
import { createWebhookRoute, startWebhookProcessor } from './webhookHandler';

// Register routes for each provider
app.post('/webhooks/stripe', createWebhookRoute('stripe'));
app.post('/webhooks/sendgrid', createWebhookRoute('sendgrid'));
app.post('/webhooks/custom', createWebhookRoute('custom'));

// Start background processor
startWebhookProcessor();
```

```typescript
// handlers.ts
import { registerHandler } from './webhookHandler';

registerHandler('stripe', async (webhook) => {
  const event = webhook.requestBody;
  
  switch (event.type) {
    case 'payment_intent.succeeded':
      await handlePaymentSuccess(event.data.object);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionCanceled(event.data.object);
      break;
    default:
      console.log(`Unhandled Stripe event: ${event.type}`);
  }
});

registerHandler('sendgrid', async (webhook) => {
  const events = webhook.requestBody;
  for (const event of events) {
    if (event.event === 'bounce') {
      await handleEmailBounce(event.email);
    }
  }
});
```

## Idempotency

For webhooks that may be delivered multiple times, add idempotency checks:

```typescript
registerHandler('stripe', async (webhook) => {
  const event = webhook.requestBody;
  
  // Check if we've already processed this event
  const existing = await db
    .select({ id: processedEvents.id })
    .from(processedEvents)
    .where(eq(processedEvents.stripeEventId, event.id))
    .limit(1);
  
  if (existing.length > 0) {
    console.log(`Already processed Stripe event ${event.id}`);
    return; // Skip duplicate
  }
  
  // Process the event...
  
  // Record that we processed it
  await db.insert(processedEvents).values({
    stripeEventId: event.id,
    processedAt: new Date(),
  });
});
```

## Error Handling

Errors are caught and logged to the webhook_logs table:

```typescript
try {
  await handler(webhook);
  await updateStatus(webhook.id, 'processed');
} catch (error) {
  await updateStatus(webhook.id, 'error', {
    errorMessage: error.message,
  });
}
```

Query for failed webhooks:
```sql
SELECT * FROM webhook_logs 
WHERE status = 'error' 
ORDER BY created_at DESC 
LIMIT 100;
```

## License

MIT
