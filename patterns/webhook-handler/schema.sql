-- Webhook Logs Table
-- Stores all incoming webhooks for reliable asynchronous processing

CREATE TABLE IF NOT EXISTS webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Webhook identification
  webhook_type VARCHAR(50) NOT NULL,  -- e.g., 'stripe', 'sendgrid', 'custom'
  account_id UUID,                     -- Optional: link to your accounts table
  
  -- Payload
  request_body JSONB NOT NULL,
  
  -- Processing status
  status VARCHAR(20) NOT NULL DEFAULT 'received',
  -- Values: 'received', 'processing', 'processed', 'error', 'ignored'
  
  -- Error tracking
  error_message TEXT,
  
  -- Additional metadata
  metadata JSONB,
  
  -- Timestamps
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Index for the processor to find webhooks to process
CREATE INDEX IF NOT EXISTS idx_webhook_logs_status_created 
  ON webhook_logs(status, created_at) 
  WHERE status = 'received';

-- Index for querying by type (debugging, admin panels)
CREATE INDEX IF NOT EXISTS idx_webhook_logs_type_created 
  ON webhook_logs(webhook_type, created_at DESC);

-- Index for querying by account (if applicable)
CREATE INDEX IF NOT EXISTS idx_webhook_logs_account 
  ON webhook_logs(account_id, created_at DESC)
  WHERE account_id IS NOT NULL;

-- Index for finding errors (for retry/debugging)
CREATE INDEX IF NOT EXISTS idx_webhook_logs_errors 
  ON webhook_logs(created_at DESC)
  WHERE status = 'error';

-- Comment on table
COMMENT ON TABLE webhook_logs IS 'Stores incoming webhooks for reliable async processing';
COMMENT ON COLUMN webhook_logs.status IS 'received=awaiting, processing=claimed, processed=done, error=failed, ignored=skipped';
