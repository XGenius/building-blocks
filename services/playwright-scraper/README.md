# Playwright Scraper Service

Self-hosted web scraper service using Playwright for high-throughput website crawling.

## Overview

This service provides an HTTP API for scraping websites using Playwright. It's designed to replace paid scraping services like Apify, offering:

- **No concurrent limits** - Scale based on server resources
- **Zero per-page costs** - Just server costs
- **Low latency** - Direct scraping, no job queue
- **Full control** - Customize crawl behavior

## Quick Start

### Local Development

```bash
npm install
npx playwright install chromium
npm run dev
```

Test with:
```bash
curl -X POST http://localhost:3000/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "maxPages": 3}'
```

### Deploy to Railway

1. Copy this folder into your project
2. Create a new Railway service pointing to this directory
3. Railway will auto-detect the Dockerfile
4. Set environment variables (see below)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template)

## API Endpoints

### Health Check

```
GET /health
```

Returns service status and metrics:
```json
{
  "status": "healthy",
  "activeRequests": 2,
  "maxConcurrent": 32,
  "uptime": 3600
}
```

### Scrape Single URL

```
POST /scrape
Content-Type: application/json
X-Auth-Token: your-token (optional)

{
  "url": "https://example.com",
  "maxPages": 8
}
```

Response:
```json
{
  "success": true,
  "pages": [
    {
      "url": "https://example.com",
      "title": "Example Company",
      "content": "# Example Company\n\nWe help businesses...",
      "wordCount": 500
    }
  ],
  "totalPages": 5,
  "duration": 3500
}
```

### Batch Scrape

```
POST /scrape/batch
Content-Type: application/json
X-Auth-Token: your-token (optional)

{
  "urls": ["https://example1.com", "https://example2.com"],
  "maxPages": 8
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `AUTH_TOKEN` | Optional auth token for requests | - |
| `MAX_CONCURRENT` | Max concurrent scrape requests | 32 |

## Resource Requirements

- **Memory**: ~500MB base + ~500MB per concurrent browser
- **Recommended**: 8GB RAM for 10-15 concurrent scrapers

| RAM | Recommended MAX_CONCURRENT |
|-----|---------------------------|
| 1GB | 2-3 |
| 2GB | 4-5 |
| 4GB | 8-10 |
| 8GB | 15-20 |
| 16GB | 30-40 |

## Architecture

### Browser Singleton with Mutex

The service uses a browser singleton pattern with a mutex to prevent race conditions when multiple requests arrive simultaneously:

```typescript
let browser: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  if (browserLaunchPromise) return browserLaunchPromise;
  
  browserLaunchPromise = chromium.launch({ ... });
  browser = await browserLaunchPromise;
  browserLaunchPromise = null;
  return browser;
}
```

### Resource Blocking

Images, fonts, and stylesheets are blocked for faster crawling and lower memory usage:

```typescript
await page.route("**/*", (route) => {
  const resourceType = route.request().resourceType();
  if (["image", "media", "font", "stylesheet"].includes(resourceType)) {
    route.abort();
  } else {
    route.continue();
  }
});
```

### Content Extraction

HTML is converted to clean Markdown using Turndown, with navigation, footer, and other boilerplate elements removed.

## Key Learnings & Gotchas

1. **Use `--disable-dev-shm-usage`** - In Docker, `/dev/shm` is small (64MB) and Chromium needs it
2. **Use `domcontentloaded`** not `networkidle` - Much faster, add small delay for JS rendering
3. **Concurrent limit is critical** - Too many browsers = OOM crash
4. **HTTPS/HTTP fallback** - Some sites only work on one protocol
5. **Graceful shutdown** - Handle SIGTERM for Railway deploys

## Client Integration

Example client code for calling from your main app:

```typescript
const SCRAPER_URL = process.env.PLAYWRIGHT_SCRAPER_URL;
const AUTH_TOKEN = process.env.SCRAPER_AUTH_TOKEN;

export async function scrapeWebsite(url: string, maxPages = 8) {
  const response = await fetch(`${SCRAPER_URL}/scrape`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AUTH_TOKEN && { 'X-Auth-Token': AUTH_TOKEN }),
    },
    body: JSON.stringify({ url, maxPages }),
    signal: AbortSignal.timeout(60000),
  });
  
  if (!response.ok) {
    throw new Error(`Scrape failed: ${response.status}`);
  }
  
  return response.json();
}
```

## License

MIT
