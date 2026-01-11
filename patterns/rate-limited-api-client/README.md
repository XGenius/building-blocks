# Rate-Limited API Client Pattern

A consistent pattern for calling external APIs with rate limiting, batching, retries, and error handling.

## The Problem

External APIs have rate limits. Without proper handling:
- Requests get rejected with 429 errors
- No automatic retries on transient failures
- Large datasets overwhelm the API
- Inconsistent error handling across services

## The Solution

A standardized API client pattern with:
- Configurable rate limiting (delay between requests)
- Automatic batching for large datasets
- Exponential backoff retries
- Consistent error handling
- Progress callbacks for long operations

## Usage

1. Copy `client.ts` into your project
2. Configure rate limits for your specific API
3. Implement your endpoint functions
4. Use `processBatch()` for bulk operations

## Files

- `client.ts` - Generic client template with batching and retries
- `README.md` - This documentation

## Key Features

### Rate Limiting

```typescript
const RATE_LIMIT_DELAY_MS = 200; // 5 requests/second

async function rateLimitDelay(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
}
```

### Exponential Backoff Retries

```typescript
async function retryDelay(attempt: number): Promise<void> {
  const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
  await new Promise(resolve => setTimeout(resolve, delay));
}
```

### Batch Processing

```typescript
const results = await processBatch(
  apiKey,
  items,
  async (item) => createRecord(apiKey, item),
  (processed, total) => console.log(`Progress: ${processed}/${total}`)
);
```

## Configuration

Adjust these constants based on your API's limits:

| Constant | Description | Example |
|----------|-------------|---------|
| `RATE_LIMIT_DELAY_MS` | Delay between requests | 200ms = 5 req/s |
| `BATCH_SIZE` | Items per batch | 100 |
| `MAX_RETRIES` | Retry attempts | 3 |
| `RETRY_DELAY_MS` | Base delay for retries | 1000ms |

### Common API Limits

| API | Rate Limit | Recommended Delay |
|-----|-----------|-------------------|
| Stripe | 100/s | 10ms |
| SendGrid | 600/min | 100ms |
| HubSpot | 100/10s | 100ms |
| PlusVibe | 5/s | 200ms |
| Instantly | 600/min | 100ms |

## Example: Implementing for a Specific API

```typescript
import { makeRequest, processBatch, ApiResponse } from './client';

const API_BASE_URL = 'https://api.example.com/v1';

// Single record creation
export async function createContact(
  apiKey: string,
  data: ContactData
): Promise<ApiResponse<Contact>> {
  return makeRequest(apiKey, 'POST', '/contacts', data, API_BASE_URL);
}

// Bulk creation with batching
export async function createContactsBulk(
  apiKey: string,
  contacts: ContactData[]
): Promise<{ success: number; failed: number }> {
  const result = await processBatch(
    apiKey,
    contacts,
    (contact) => createContact(apiKey, contact),
    (done, total) => console.log(`Created ${done}/${total} contacts`)
  );
  
  return {
    success: result.successCount,
    failed: result.errorCount,
  };
}
```

## License

MIT
