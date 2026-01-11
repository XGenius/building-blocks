# Building Blocks

A collection of production-ready services, patterns, and starter templates for building modern web applications.

Battle-tested code extracted from production applications. Copy what you need, customize for your project.

## Quick Start

```bash
# Clone the repo
git clone https://github.com/XGenius/building-blocks.git

# Copy a component into your project
cp -r building-blocks/services/playwright-scraper my-project/scraper-service

# Or copy a pattern
cp building-blocks/patterns/atomic-job-processor/processor.ts my-project/server/lib/
```

## Component Catalog

### Services

Standalone services you can deploy independently.

| Service | Description | Stack | Deploy |
|---------|-------------|-------|--------|
| [Playwright Scraper](./services/playwright-scraper/) | Self-hosted web scraping | Node.js, Playwright, Docker | Railway |
| [LLM Batch API](./services/llm-batch-api/) | Self-hosted LLM inference | Python, FastAPI, RunPod | RunPod |

### Patterns

Copy-and-adapt code patterns for common problems.

| Pattern | Problem Solved | Language |
|---------|---------------|----------|
| [Atomic Job Processor](./patterns/atomic-job-processor/) | Race conditions in background jobs | TypeScript |
| [Rate-Limited API Client](./patterns/rate-limited-api-client/) | API rate limits & retries | TypeScript |
| [Webhook Handler](./patterns/webhook-handler/) | Multi-provider webhook processing | TypeScript |
| [Anthropic Client](./patterns/anthropic-client/) | Configured LLM client | TypeScript |

### Starter Templates

Complete project templates to build from.

| Starter | Description | Stack |
|---------|-------------|-------|
| [Supabase Full-Stack](./starters/supabase-fullstack/) | Complete auth, DB, storage setup | React, Express, Supabase |

### Config Templates

Configuration files for common tools.

| Config | Description |
|--------|-------------|
| [Railway](./configs/railway/) | Railway deployment configs |
| [Drizzle](./configs/drizzle/) | Drizzle ORM setup |
| [TypeScript](./configs/typescript/) | TypeScript configuration |

## How to Use

### Services

Services are standalone and deploy separately from your main app.

1. **Copy the folder** into your project
2. **Configure environment variables** (see service README)
3. **Deploy to Railway** as a separate service
4. **Connect via internal URL** (e.g., `https://scraper.railway.internal`)

```bash
# Example: Add Playwright scraper to your project
cp -r building-blocks/services/playwright-scraper my-app/scraper-service
cd my-app/scraper-service
npm install
# Deploy to Railway...
```

### Patterns

Patterns are code templates to copy and customize.

1. **Copy the file(s)** into your project
2. **Replace placeholders** (table names, types, etc.)
3. **Implement your logic** where indicated

```bash
# Example: Add atomic job processor
cp building-blocks/patterns/atomic-job-processor/processor.ts my-app/server/lib/
# Edit processor.ts to use your tables...
```

### Starters

Starters are complete project templates.

1. **Copy the entire folder** as your new project
2. **Set up environment variables**
3. **Customize and build**

```bash
# Example: Start new project with Supabase
cp -r building-blocks/starters/supabase-fullstack my-new-project
cd my-new-project
npm install
cp env.example .env
# Edit .env with your Supabase credentials...
npm run dev
```

## Component Details

### Playwright Scraper

Self-hosted web scraping service using Playwright. Replaces paid services like Apify.

**Key Features:**
- Browser singleton with mutex (prevents race conditions)
- Resource blocking (faster, less memory)
- Concurrent request limiting
- Graceful shutdown for Railway
- HTML to Markdown conversion

**Cost:** ~$20-50/month on Railway vs. $100+/month on Apify

[Read more →](./services/playwright-scraper/)

---

### LLM Batch API

Self-hosted LLM inference on RunPod. Drop-in replacement for Anthropic's Batch API.

**Key Features:**
- Hybrid routing (Mistral for speed, Llama for quality)
- Redis-based job queue
- 50-60% cost savings vs. managed APIs
- Minutes instead of hours latency

**Cost:** ~$1,100/month vs. $2,500/month on Anthropic

[Read more →](./services/llm-batch-api/)

---

### Atomic Job Processor

Prevents race conditions when multiple server instances process the same queue.

**Problem:** Dev and prod servers both see "queued" jobs and process them → duplicates

**Solution:** PostgreSQL `FOR UPDATE SKIP LOCKED` for atomic claiming

```sql
UPDATE jobs SET status = 'started'
WHERE id IN (
  SELECT id FROM jobs WHERE status = 'queued'
  FOR UPDATE SKIP LOCKED
)
RETURNING *
```

[Read more →](./patterns/atomic-job-processor/)

---

### Rate-Limited API Client

Consistent pattern for calling external APIs with rate limiting, batching, and retries.

**Features:**
- Configurable rate limiting
- Automatic batching for bulk operations
- Exponential backoff retries
- Progress callbacks

[Read more →](./patterns/rate-limited-api-client/)

---

### Webhook Handler

Handle webhooks from multiple providers with atomic claiming and type-based routing.

**Features:**
- Log immediately, process async
- Atomic claiming prevents duplicates
- Type-based routing to handlers
- Status tracking (received → processing → processed/error)

[Read more →](./patterns/webhook-handler/)

---

### Supabase Full-Stack Starter

Complete starter template with auth, database, and storage.

**Includes:**
- React frontend with auth context
- Express backend with JWT verification
- Drizzle ORM with migrations
- Edge function template
- Railway deployment config

[Read more →](./starters/supabase-fullstack/)

## Tech Stack

These components are built for:

| Layer | Technology |
|-------|------------|
| **Frontend** | React, TypeScript, Vite |
| **Backend** | Express, TypeScript, Node.js |
| **Database** | PostgreSQL (Supabase) |
| **ORM** | Drizzle |
| **Hosting** | Railway, RunPod |
| **Auth** | Supabase Auth |

## Contributing

1. Fork the repo
2. Add your component in the appropriate folder
3. Include a README with usage instructions
4. Submit a PR

### Component Guidelines

- **Self-contained**: Each component should work independently
- **Well-documented**: Include README, comments, and examples
- **Production-tested**: Only include patterns proven in production
- **Minimal dependencies**: Keep external dependencies minimal

## License

MIT License - Use freely in your projects.

## Origin

These components were extracted from production applications built at [Social Bloom](https://socialbloom.io) and other projects. They've been generalized and documented for reuse.
