# Anthropic Client Configuration

A properly configured Anthropic client with increased timeouts, retries, and best practices for production use.

## Prerequisites

- [ ] Anthropic account with API access
- [ ] Node.js/TypeScript application

## Human Setup Steps

1. **Create Anthropic account**
   - Sign up at [console.anthropic.com](https://console.anthropic.com)
   - Add payment method (required for API access)

2. **Generate API key**
   - Go to API Keys in the Anthropic console
   - Create a new key and copy it immediately (only shown once)

3. **Install the SDK**
   ```bash
   npm install @anthropic-ai/sdk
   ```

4. **Copy the client** into your project

5. **Set environment variable**

## The Problem

Default Anthropic SDK settings can cause issues in production:
- Default timeout may be too short for complex prompts
- No retry configuration for transient failures
- Multiple client instances waste resources

## The Solution

A centralized, properly configured Anthropic client that handles:
- Extended timeouts for long-running requests
- Automatic retries with exponential backoff
- Rate limit handling (429 responses)
- Single shared instance for efficiency

## Usage

1. Copy `client.ts` into your project (e.g., `server/config/anthropicClient.ts`)
2. Set `ANTHROPIC_API_KEY` in your environment
3. Import the client wherever you need it

```typescript
import { anthropic } from './config/anthropicClient';

const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

## Files

- `client.ts` - Configured Anthropic client
- `README.md` - This documentation

## Configuration

| Setting | Value | Reason |
|---------|-------|--------|
| `timeout` | 300000ms (5 min) | Allows for slow responses under load |
| `maxRetries` | 3 | Retries on transient failures |

The SDK automatically handles:
- Exponential backoff between retries
- Rate limit (429) response handling
- Transient network error recovery

## Best Practices

### Single Instance

Import the same client everywhere - don't create new instances:

```typescript
// Good ✓
import { anthropic } from './config/anthropicClient';

// Bad ✗
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
```

### Error Handling

```typescript
try {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content[0].text;
} catch (error) {
  if (error instanceof Anthropic.APIError) {
    console.error(`Anthropic API error: ${error.status} ${error.message}`);
    if (error.status === 429) {
      // Rate limited - already retried 3 times
      throw new Error('Rate limit exceeded after retries');
    }
  }
  throw error;
}
```

### Streaming

```typescript
const stream = await anthropic.messages.stream({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: prompt }],
});

for await (const event of stream) {
  if (event.type === 'content_block_delta') {
    process.stdout.write(event.delta.text);
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |

## License

MIT
