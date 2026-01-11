/**
 * Rate-Limited API Client Pattern
 *
 * Provides consistent rate limiting, batching, and retry logic for external APIs.
 *
 * Usage:
 * 1. Copy this file into your project
 * 2. Configure constants for your API's rate limits
 * 3. Implement your specific endpoints using makeRequest()
 * 4. Use processBatch() for bulk operations
 */

// =============================================================================
// CONFIGURATION - Adjust based on your API limits
// =============================================================================

const RATE_LIMIT_DELAY_MS = 200; // 5 requests/second = 200ms between requests
const BATCH_SIZE = 100; // Items per batch
const MAX_RETRIES = 3; // Maximum retry attempts
const RETRY_DELAY_MS = 1000; // Base delay for retries (doubles each attempt)
const REQUEST_TIMEOUT_MS = 30000; // 30 second timeout

// =============================================================================
// TYPES
// =============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
}

export interface BatchResult<T> {
  results: ApiResponse<T>[];
  successCount: number;
  errorCount: number;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Rate limit delay between requests
 */
async function rateLimitDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
}

/**
 * Exponential backoff delay for retries
 */
async function retryDelay(attempt: number): Promise<void> {
  const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

// =============================================================================
// CORE REQUEST FUNCTION
// =============================================================================

/**
 * Generic request handler with retry logic
 *
 * Features:
 * - Automatic retries with exponential backoff
 * - Rate limit detection (429 status)
 * - Timeout handling
 * - Consistent error format
 *
 * @param apiKey - API key or token
 * @param method - HTTP method (GET, POST, PUT, DELETE)
 * @param endpoint - API endpoint path (e.g., '/api/v1/contacts')
 * @param body - Request body (for POST/PUT)
 * @param apiBaseUrl - Base URL of the API
 * @param customHeaders - Additional headers to include
 */
export async function makeRequest<T>(
  apiKey: string,
  method: string,
  endpoint: string,
  body?: unknown,
  apiBaseUrl: string = "https://api.example.com",
  customHeaders?: Record<string, string>
): Promise<ApiResponse<T>> {
  const url = `${apiBaseUrl}${endpoint}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          // Alternative: 'x-api-key': apiKey,
          ...customHeaders,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle rate limiting
      if (response.status === 429) {
        console.warn(
          `[ApiClient] Rate limited, waiting before retry ${attempt + 1}/${MAX_RETRIES}`
        );
        
        // Check for Retry-After header
        const retryAfter = response.headers.get("Retry-After");
        if (retryAfter) {
          const waitMs = parseInt(retryAfter, 10) * 1000;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        } else {
          await retryDelay(attempt);
        }
        continue;
      }

      // Handle server errors (retry)
      if (response.status >= 500) {
        console.warn(
          `[ApiClient] Server error ${response.status}, retry ${attempt + 1}/${MAX_RETRIES}`
        );
        await retryDelay(attempt);
        continue;
      }

      // Handle client errors (don't retry)
      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorText}`,
          statusCode: response.status,
        };
      }

      // Success
      const data = await response.json();
      return { success: true, data, statusCode: response.status };
    } catch (error) {
      // Handle timeout
      if (error instanceof Error && error.name === "AbortError") {
        console.warn(
          `[ApiClient] Request timeout, retry ${attempt + 1}/${MAX_RETRIES}`
        );
        if (attempt < MAX_RETRIES - 1) {
          await retryDelay(attempt);
          continue;
        }
        return {
          success: false,
          error: "Request timeout",
        };
      }

      // Handle network errors
      if (attempt < MAX_RETRIES - 1) {
        console.warn(
          `[ApiClient] Network error, retry ${attempt + 1}/${MAX_RETRIES}: ${
            error instanceof Error ? error.message : "Unknown"
          }`
        );
        await retryDelay(attempt);
        continue;
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  return { success: false, error: "Max retries exceeded" };
}

// =============================================================================
// BATCH PROCESSING
// =============================================================================

/**
 * Process items in batches with rate limiting
 *
 * Features:
 * - Processes items in configurable batch sizes
 * - Rate limiting between requests
 * - Progress callback for UI updates
 * - Aggregates results and error counts
 *
 * @param apiKey - API key for authentication
 * @param items - Array of items to process
 * @param processItem - Function to process each item
 * @param onProgress - Optional callback for progress updates
 */
export async function processBatch<TInput, TOutput>(
  apiKey: string,
  items: TInput[],
  processItem: (item: TInput) => Promise<ApiResponse<TOutput>>,
  onProgress?: (processed: number, total: number) => void
): Promise<BatchResult<TOutput>> {
  const results: ApiResponse<TOutput>[] = [];
  let successCount = 0;
  let errorCount = 0;

  const totalBatches = Math.ceil(items.length / BATCH_SIZE);
  console.log(
    `[ApiClient] Processing ${items.length} items in ${totalBatches} batches of ${BATCH_SIZE}`
  );

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    console.log(`[ApiClient] Processing batch ${batchNum}/${totalBatches}`);

    for (const item of batch) {
      // Rate limit between requests
      if (results.length > 0) {
        await rateLimitDelay();
      }

      const result = await processItem(item);
      results.push(result);

      if (result.success) {
        successCount++;
      } else {
        errorCount++;
        // Log first few errors, then summarize
        if (errorCount <= 5) {
          console.error(`[ApiClient] Failed:`, result.error);
        }
      }
    }

    // Report progress after each batch
    if (onProgress) {
      onProgress(Math.min(i + BATCH_SIZE, items.length), items.length);
    }
  }

  if (errorCount > 5) {
    console.error(`[ApiClient] ... and ${errorCount - 5} more errors`);
  }

  console.log(
    `[ApiClient] Complete: ${successCount} succeeded, ${errorCount} failed`
  );

  return { results, successCount, errorCount };
}

// =============================================================================
// EXAMPLE USAGE - Implement for your specific API
// =============================================================================

/*
// Example: Implementing for a CRM API

interface Contact {
  id: string;
  email: string;
  name: string;
}

interface CreateContactData {
  email: string;
  name: string;
  company?: string;
}

const CRM_BASE_URL = 'https://api.crm.example.com/v1';

export async function createContact(
  apiKey: string,
  data: CreateContactData
): Promise<ApiResponse<Contact>> {
  return makeRequest<Contact>(apiKey, 'POST', '/contacts', data, CRM_BASE_URL);
}

export async function getContact(
  apiKey: string,
  id: string
): Promise<ApiResponse<Contact>> {
  return makeRequest<Contact>(apiKey, 'GET', `/contacts/${id}`, undefined, CRM_BASE_URL);
}

export async function updateContact(
  apiKey: string,
  id: string,
  data: Partial<CreateContactData>
): Promise<ApiResponse<Contact>> {
  return makeRequest<Contact>(apiKey, 'PUT', `/contacts/${id}`, data, CRM_BASE_URL);
}

export async function deleteContact(
  apiKey: string,
  id: string
): Promise<ApiResponse<void>> {
  return makeRequest<void>(apiKey, 'DELETE', `/contacts/${id}`, undefined, CRM_BASE_URL);
}

// Bulk operations
export async function createContactsBulk(
  apiKey: string,
  contacts: CreateContactData[],
  onProgress?: (done: number, total: number) => void
): Promise<{ created: Contact[]; failed: number }> {
  const result = await processBatch(
    apiKey,
    contacts,
    (contact) => createContact(apiKey, contact),
    onProgress
  );

  const created = result.results
    .filter((r) => r.success && r.data)
    .map((r) => r.data!);

  return { created, failed: result.errorCount };
}
*/
