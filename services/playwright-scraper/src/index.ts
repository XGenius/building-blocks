import express, { Request, Response, NextFunction } from "express";
import { crawlWebsite, closeBrowser, CrawlResult } from "./crawler.js";
import { 
  submitJob, 
  getJob, 
  getQueueStats, 
  startWorker, 
  stopWorker,
  ScrapeJob 
} from "./queue.js";

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "32", 10);
const DATABASE_URL = process.env.DATABASE_URL;

// Queue mode is enabled when DATABASE_URL is set
const QUEUE_MODE = !!DATABASE_URL;

// Track concurrent requests (for sync mode)
let activeRequests = 0;

app.use(express.json());

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get("/health", async (_req: Request, res: Response) => {
  const health: Record<string, unknown> = {
    status: "healthy",
    mode: QUEUE_MODE ? "queue" : "sync",
    activeRequests,
    maxConcurrent: MAX_CONCURRENT,
    uptime: process.uptime(),
  };
  
  // Include queue stats if in queue mode
  if (QUEUE_MODE) {
    try {
      health.queue = await getQueueStats();
    } catch (error) {
      health.queue = { error: "Failed to fetch stats" };
    }
  }
  
  res.json(health);
});

// =============================================================================
// AUTH MIDDLEWARE
// =============================================================================

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (AUTH_TOKEN) {
    const providedToken = req.headers["x-auth-token"] || req.query.token;
    if (providedToken !== AUTH_TOKEN) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }
  next();
}

// =============================================================================
// QUEUE MODE ENDPOINTS (async job processing)
// =============================================================================

// Submit a new scrape job (returns immediately with job ID)
app.post("/jobs", authMiddleware, async (req: Request, res: Response) => {
  if (!QUEUE_MODE) {
    res.status(400).json({ 
      error: "Queue mode not enabled. Set DATABASE_URL to enable async job processing.",
      hint: "Use POST /scrape for synchronous scraping instead."
    });
    return;
  }
  
  const { 
    url, 
    maxPages = 20,
    maxConcurrency = 5,
    includeSitemap = true,
  } = req.body;

  if (!url) {
    res.status(400).json({ error: "URL is required" });
    return;
  }

  try {
    const job = await submitJob({
      url,
      maxPages: Math.min(maxPages, 100),
      maxConcurrency: Math.min(maxConcurrency, 10),
      includeSitemap,
    });
    
    res.status(202).json({
      id: job.id,
      url: job.url,
      status: job.status,
      createdAt: job.created_at,
      message: "Job queued for processing",
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error("[Server] Error submitting job:", error);
    res.status(500).json({ error: errorMsg });
  }
});

// Get job status and result
app.get("/jobs/:id", authMiddleware, async (req: Request, res: Response) => {
  if (!QUEUE_MODE) {
    res.status(400).json({ error: "Queue mode not enabled" });
    return;
  }
  
  const { id } = req.params;
  
  try {
    const job = await getJob(id);
    
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    
    // Return different response based on status
    const response: Record<string, unknown> = {
      id: job.id,
      url: job.url,
      status: job.status,
      retryCount: job.retry_count,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    };
    
    if (job.status === "completed" && job.result) {
      response.result = job.result;
      response.completedAt = job.completed_at;
    } else if (job.status === "failed") {
      response.error = job.error;
      response.completedAt = job.completed_at;
    } else if (job.status === "started") {
      response.claimedAt = job.claimed_at;
    }
    
    res.json(response);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error("[Server] Error getting job:", error);
    res.status(500).json({ error: errorMsg });
  }
});

// Get queue statistics
app.get("/jobs", authMiddleware, async (_req: Request, res: Response) => {
  if (!QUEUE_MODE) {
    res.status(400).json({ error: "Queue mode not enabled" });
    return;
  }
  
  try {
    const stats = await getQueueStats();
    res.json(stats);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error("[Server] Error getting queue stats:", error);
    res.status(500).json({ error: errorMsg });
  }
});

// =============================================================================
// SYNC MODE ENDPOINTS (direct scraping - for testing or low-volume use)
// =============================================================================

// Scrape endpoint (synchronous - waits for completion)
app.post("/scrape", authMiddleware, async (req: Request, res: Response) => {
  const { 
    url, 
    maxPages = 8,
    maxConcurrency = 5,
    includeSitemap = true,
  } = req.body;

  if (!url) {
    res.status(400).json({ error: "URL is required" });
    return;
  }

  // Check concurrent limit
  if (activeRequests >= MAX_CONCURRENT) {
    res.status(429).json({
      error: "Too many concurrent requests",
      activeRequests,
      maxConcurrent: MAX_CONCURRENT,
      hint: QUEUE_MODE ? "Use POST /jobs for async processing" : undefined,
    });
    return;
  }

  activeRequests++;
  console.log(`[Server] Starting scrape for ${url} (${activeRequests}/${MAX_CONCURRENT} active)`);

  try {
    const result: CrawlResult = await crawlWebsite(url, Math.min(maxPages, 100), {
      maxConcurrency: Math.min(maxConcurrency, 10),
      includeSitemap,
    });

    console.log(
      `[Server] Completed scrape for ${url}: ${result.totalPages} pages in ${result.duration}ms`
    );

    res.json(result);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Server] Error scraping ${url}:`, error);
    res.status(500).json({
      success: false,
      error: errorMsg,
      pages: [],
      totalPages: 0,
      duration: 0,
    });
  } finally {
    activeRequests--;
  }
});

// Batch scrape endpoint (synchronous - for parallel processing of multiple domains)
app.post("/scrape/batch", authMiddleware, async (req: Request, res: Response) => {
  const { 
    urls, 
    maxPages = 8,
    maxConcurrency = 5,
    includeSitemap = true,
  } = req.body;

  if (!Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: "URLs array is required" });
    return;
  }

  // Limit batch size
  const limitedUrls = urls.slice(0, 50);

  console.log(`[Server] Starting batch scrape for ${limitedUrls.length} URLs`);

  const results = await Promise.allSettled(
    limitedUrls.map((url: string) => crawlWebsite(url, Math.min(maxPages, 100), {
      maxConcurrency: Math.min(maxConcurrency, 10),
      includeSitemap,
    }))
  );

  const response = results.map((result, index) => ({
    url: limitedUrls[index],
    ...(result.status === "fulfilled"
      ? result.value
      : { success: false, error: result.reason?.message || "Unknown error", pages: [], totalPages: 0, duration: 0 }),
  }));

  res.json({ results: response });
});

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

async function shutdown(signal: string): Promise<void> {
  console.log(`[Server] Received ${signal}, shutting down gracefully...`);
  
  if (QUEUE_MODE) {
    await stopWorker();
  }
  
  await closeBrowser();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, async () => {
  console.log(`[Server] Scraper service running on port ${PORT}`);
  console.log(`[Server] Mode: ${QUEUE_MODE ? "queue (async)" : "sync"}`);
  console.log(`[Server] Max concurrent requests: ${MAX_CONCURRENT}`);
  console.log(`[Server] Auth: ${AUTH_TOKEN ? "enabled" : "disabled"}`);
  
  // Start worker if in queue mode
  if (QUEUE_MODE) {
    console.log("[Server] Starting queue worker...");
    await startWorker();
  }
});
