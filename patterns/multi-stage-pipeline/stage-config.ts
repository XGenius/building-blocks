/**
 * Stage Configuration
 * 
 * Defines the pipeline stages, their order, and which service handles each.
 * Modify this configuration to match your specific pipeline.
 */

// =============================================================================
// TYPES
// =============================================================================

export type StageStatus = 'pending' | 'queued' | 'started' | 'completed' | 'failed';

export type StageName = 'scrape' | 'intel' | 'strategy' | 'subject' | 'messaging';

export interface StageConfig {
  /** Next stage to trigger on completion (null if final stage) */
  next: StageName | null;
  
  /** Service that handles this stage */
  service: 'scraper' | 'llm';
  
  /** Maximum retry attempts for retriable failures */
  maxRetries: number;
  
  /** Timeout in ms before a 'started' job is considered stuck */
  stuckTimeoutMs: number;
  
  /** Polling interval in ms for checking job completion */
  pollIntervalMs: number;
}

// =============================================================================
// PIPELINE CONFIGURATION
// =============================================================================

export const STAGES: Record<StageName, StageConfig> = {
  scrape: {
    next: 'intel',
    service: 'scraper',
    maxRetries: 3,
    stuckTimeoutMs: 10 * 60 * 1000,  // 10 minutes
    pollIntervalMs: 2000,             // 2 seconds
  },
  
  intel: {
    next: 'strategy',
    service: 'llm',
    maxRetries: 3,
    stuckTimeoutMs: 15 * 60 * 1000,  // 15 minutes
    pollIntervalMs: 3000,             // 3 seconds
  },
  
  strategy: {
    next: 'subject',
    service: 'llm',
    maxRetries: 3,
    stuckTimeoutMs: 15 * 60 * 1000,
    pollIntervalMs: 3000,
  },
  
  subject: {
    next: 'messaging',
    service: 'llm',
    maxRetries: 3,
    stuckTimeoutMs: 10 * 60 * 1000,
    pollIntervalMs: 2000,
  },
  
  messaging: {
    next: null,  // Final stage
    service: 'llm',
    maxRetries: 3,
    stuckTimeoutMs: 15 * 60 * 1000,
    pollIntervalMs: 3000,
  },
};

// =============================================================================
// COLUMN NAME HELPERS
// =============================================================================

/**
 * Get the column names for a stage's fields.
 * This maps stage names to database column prefixes.
 */
export function getStageColumns(stage: StageName) {
  return {
    status: `${stage}_status`,
    jobId: `${stage}_job_id`,
    result: `${stage}_result`,
    error: `${stage}_error`,
    retryCount: `${stage}_retry_count`,
    startedAt: `${stage}_started_at`,
    completedAt: `${stage}_completed_at`,
  };
}

// =============================================================================
// FAILURE CLASSIFICATION
// =============================================================================

/**
 * Patterns that indicate a hard failure (don't retry).
 */
export const HARD_FAILURE_PATTERNS = [
  /ENOTFOUND/i,              // DNS lookup failed
  /ECONNREFUSED/i,           // Connection refused
  /404/i,                    // Not found
  /403/i,                    // Forbidden
  /401/i,                    // Unauthorized
  /no content/i,             // Empty response
  /invalid.*url/i,           // Bad URL
];

/**
 * Patterns that indicate a retriable failure (retry up to maxRetries).
 */
export const RETRIABLE_FAILURE_PATTERNS = [
  /timeout/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /429/i,                    // Rate limited
  /503/i,                    // Service unavailable
  /502/i,                    // Bad gateway
  /500/i,                    // Internal server error
  /out of memory/i,
  /worker.*crash/i,
];

/**
 * Classify an error as hard failure (don't retry) or retriable.
 */
export function classifyError(error: string): 'hard' | 'retriable' | 'unknown' {
  if (HARD_FAILURE_PATTERNS.some(p => p.test(error))) {
    return 'hard';
  }
  if (RETRIABLE_FAILURE_PATTERNS.some(p => p.test(error))) {
    return 'retriable';
  }
  return 'unknown';  // Treat unknown errors as retriable by default
}

// =============================================================================
// SERVICE CONFIGURATION
// =============================================================================

export interface ServiceConfig {
  baseUrl: string;
  authToken?: string;
  timeout: number;
}

/**
 * Get service configuration from environment variables.
 * 
 * Expected env vars:
 *   SCRAPER_URL, SCRAPER_AUTH_TOKEN
 *   LLM_URL, LLM_AUTH_TOKEN
 */
export function getServiceConfig(service: 'scraper' | 'llm'): ServiceConfig {
  if (service === 'scraper') {
    return {
      baseUrl: process.env.SCRAPER_URL || 'http://localhost:3000',
      authToken: process.env.SCRAPER_AUTH_TOKEN,
      timeout: 120000,  // 2 minutes
    };
  }
  
  return {
    baseUrl: process.env.LLM_URL || 'http://localhost:8000',
    authToken: process.env.LLM_AUTH_TOKEN,
    timeout: 300000,  // 5 minutes
  };
}

// =============================================================================
// QUEUE CONFIGURATION
// =============================================================================

export const QUEUE_CONFIG = {
  /** How many entities to claim per poll cycle */
  batchSize: parseInt(process.env.QUEUE_BATCH_SIZE || '5', 10),
  
  /** Interval between poll cycles (ms) */
  pollIntervalMs: parseInt(process.env.QUEUE_POLL_INTERVAL || '500', 10),
  
  /** Interval between completion checks (ms) */
  completionPollIntervalMs: parseInt(process.env.COMPLETION_POLL_INTERVAL || '2000', 10),
};
