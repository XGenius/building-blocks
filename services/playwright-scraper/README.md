# Playwright Scraper Service

Self-hosted web scraper service using Playwright for high-throughput website crawling.

## Overview

This service provides an HTTP API for scraping websites using Playwright. It's designed to replace paid scraping services like Apify, offering:

- **Parallel page processing** - Scrape multiple pages concurrently within a single crawl
- **Automatic sitemap discovery** - Finds sitemap.xml and robots.txt to discover all pages
- **No concurrent limits** - Scale based on server resources
- **Zero per-page costs** - Just server costs
- **Low latency** - Direct scraping, no job queue
- **Full control** - Customize crawl behavior

## Features

### Parallel Crawling

Pages within a single domain are scraped in parallel using multiple browser contexts:

```
[Crawler] Processing batch of 5 URLs in parallel
[Crawler] Scraped: About Us (450 words)
[Crawler] Scraped: Products (800 words)
[Crawler] Scraped: Contact (200 words)
...
```

Default concurrency is 5 pages at a time, configurable up to 10.

### Automatic Sitemap Discovery

Before crawling, the service automatically:

1. Checks `/robots.txt` for sitemap references
2. Checks common sitemap locations (`/sitemap.xml`, `/sitemap_index.xml`)
3. Parses sitemap index files recursively
4. Seeds the crawl queue with discovered URLs

This ensures comprehensive site coverage even for sites with poor internal linking.

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
  -d '{"url": "https://example.com", "maxPages": 10}'
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
  "maxPages": 20,
  "maxConcurrency": 5,
  "includeSitemap": true
}
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | required | URL to start crawling from |
| `maxPages` | number | 8 | Maximum pages to scrape (up to 100) |
| `maxConcurrency` | number | 5 | Parallel pages per crawl (up to 10) |
| `includeSitemap` | boolean | true | Whether to discover URLs from sitemap |

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
  "totalPages": 15,
  "sitemapUrls": 45,
  "duration": 3500
}
```

### Batch Scrape

Scrape multiple domains in parallel:

```
POST /scrape/batch
Content-Type: application/json
X-Auth-Token: your-token (optional)

{
  "urls": ["https://example1.com", "https://example2.com"],
  "maxPages": 10,
  "maxConcurrency": 5,
  "includeSitemap": true
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `AUTH_TOKEN` | Optional auth token for requests | - |
| `MAX_CONCURRENT` | Max concurrent HTTP requests | 32 |

## Resource Requirements

- **Memory**: ~500MB base + ~500MB per concurrent browser context
- **Recommended**: 8GB RAM for 10-15 concurrent scrapers

| RAM | Recommended MAX_CONCURRENT |
|-----|---------------------------|
| 1GB | 2-3 |
| 2GB | 4-5 |
| 4GB | 8-10 |
| 8GB | 15-20 |
| 16GB | 30-40 |

## Architecture

### Parallel Page Processing

Each crawl uses a pool of browser contexts to scrape pages in parallel:

```typescript
// Process queue with parallel workers
while (queue.length > 0 && pages.length < maxPages) {
  const batch = queue.splice(0, maxConcurrency);
  
  const results = await Promise.all(
    batch.map(url => scrapePage(url, context))
  );
  
  // Add discovered links to queue
  for (const result of results) {
    queue.push(...result.links);
  }
}
```

### Sitemap Discovery

The crawler automatically discovers URLs from sitemaps before starting the crawl:

```typescript
async function discoverSitemapUrls(baseUrl: string): Promise<string[]> {
  // 1. Check robots.txt for Sitemap: directives
  const robotsSitemaps = await fetchSitemapFromRobots(baseUrl);
  
  // 2. Parse sitemap.xml and sitemap indexes
  const urls = await parseSitemap(sitemapUrl, baseHost);
  
  return urls;
}
```

### Browser Singleton with Mutex

The service uses a browser singleton pattern with a mutex to prevent race conditions:

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
6. **Sitemap parsing** - Handle both regular sitemaps and sitemap indexes recursively

## Client Integration

Example client code for calling from your main app:

```typescript
const SCRAPER_URL = process.env.PLAYWRIGHT_SCRAPER_URL;
const AUTH_TOKEN = process.env.SCRAPER_AUTH_TOKEN;

export async function scrapeWebsite(
  url: string, 
  options: { 
    maxPages?: number; 
    maxConcurrency?: number;
    includeSitemap?: boolean;
  } = {}
) {
  const response = await fetch(`${SCRAPER_URL}/scrape`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AUTH_TOKEN && { 'X-Auth-Token': AUTH_TOKEN }),
    },
    body: JSON.stringify({ 
      url, 
      maxPages: options.maxPages ?? 20,
      maxConcurrency: options.maxConcurrency ?? 5,
      includeSitemap: options.includeSitemap ?? true,
    }),
    signal: AbortSignal.timeout(120000), // 2 min timeout for larger crawls
  });
  
  if (!response.ok) {
    throw new Error(`Scrape failed: ${response.status}`);
  }
  
  return response.json();
}
```

## License

MIT
