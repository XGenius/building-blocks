import express, { Request, Response, NextFunction } from "express";
import { crawlWebsite, closeBrowser, CrawlResult } from "./crawler.js";

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "32", 10);

// Track concurrent requests
let activeRequests = 0;

app.use(express.json());

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "healthy",
    activeRequests,
    maxConcurrent: MAX_CONCURRENT,
    uptime: process.uptime(),
  });
});

// Auth middleware
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

// Scrape endpoint
app.post("/scrape", authMiddleware, async (req: Request, res: Response) => {
  const { url, maxPages = 8 } = req.body;

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
    });
    return;
  }

  activeRequests++;
  console.log(`[Server] Starting scrape for ${url} (${activeRequests}/${MAX_CONCURRENT} active)`);

  try {
    const result: CrawlResult = await crawlWebsite(url, Math.min(maxPages, 20));

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

// Batch scrape endpoint (for parallel processing)
app.post("/scrape/batch", authMiddleware, async (req: Request, res: Response) => {
  const { urls, maxPages = 8 } = req.body;

  if (!Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: "URLs array is required" });
    return;
  }

  // Limit batch size
  const limitedUrls = urls.slice(0, 50);

  console.log(`[Server] Starting batch scrape for ${limitedUrls.length} URLs`);

  const results = await Promise.allSettled(
    limitedUrls.map((url: string) => crawlWebsite(url, Math.min(maxPages, 20)))
  );

  const response = results.map((result, index) => ({
    url: limitedUrls[index],
    ...(result.status === "fulfilled"
      ? result.value
      : { success: false, error: result.reason?.message || "Unknown error", pages: [], totalPages: 0, duration: 0 }),
  }));

  res.json({ results: response });
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[Server] Received SIGTERM, shutting down gracefully...");
  await closeBrowser();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[Server] Received SIGINT, shutting down gracefully...");
  await closeBrowser();
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`[Server] Scraper service running on port ${PORT}`);
  console.log(`[Server] Max concurrent requests: ${MAX_CONCURRENT}`);
  console.log(`[Server] Auth: ${AUTH_TOKEN ? "enabled" : "disabled"}`);
});

