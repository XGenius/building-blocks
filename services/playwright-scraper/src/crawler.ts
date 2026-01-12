import { chromium, Browser, BrowserContext, Page } from "playwright";
import TurndownService from "turndown";
import * as cheerio from "cheerio";

// Types
export interface CrawlPage {
  url: string;
  title: string;
  content: string; // Markdown content
  wordCount: number;
}

export interface CrawlResult {
  success: boolean;
  pages: CrawlPage[];
  totalPages: number;
  duration: number;
  sitemapUrls?: number; // How many URLs found via sitemap
  error?: string;
}

interface CrawlOptions {
  maxPages?: number;
  maxConcurrency?: number;
  includeSitemap?: boolean;
}

// Turndown service for HTML to Markdown conversion
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

// Remove script, style, nav, footer, aside elements
turndown.remove(["script", "style", "nav", "footer", "aside", "header", "noscript", "iframe"]);

// Browser singleton for reuse with mutex to prevent race conditions
let browser: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;
let browserRestartCount = 0;

async function getBrowser(forceRestart = false): Promise<Browser> {
  // Force restart if requested (e.g., after crash)
  if (forceRestart && browser) {
    console.log("[Crawler] Force restarting browser...");
    try {
      await browser.close();
    } catch {
      // Ignore close errors
    }
    browser = null;
    browserLaunchPromise = null;
  }

  // If browser is ready and connected, return it
  if (browser && browser.isConnected()) {
    return browser;
  }
  
  // Browser died, clear it
  if (browser && !browser.isConnected()) {
    console.log("[Crawler] Browser disconnected, relaunching...");
    browser = null;
    browserLaunchPromise = null;
    browserRestartCount++;
  }
  
  // If a launch is already in progress, wait for it
  if (browserLaunchPromise) {
    return browserLaunchPromise;
  }
  
  // Start a new launch with mutex
  console.log(`[Crawler] Launching browser... (restart #${browserRestartCount})`);
  browserLaunchPromise = chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
  
  try {
    browser = await browserLaunchPromise;
    return browser;
  } finally {
    browserLaunchPromise = null;
  }
}

/**
 * Extract clean content from HTML
 */
function extractContent(html: string): { content: string; title: string } {
  const $ = cheerio.load(html);

  // Remove unwanted elements
  $("script, style, nav, footer, aside, header, noscript, iframe, .nav, .footer, .header, .sidebar, .menu, .advertisement, .ad, [role='navigation'], [role='banner'], [role='contentinfo']").remove();

  // Get title
  const title = $("title").text().trim() || $("h1").first().text().trim() || "";

  // Try to find main content area
  let mainContent = $("main, article, [role='main'], .content, .main-content, #content, #main").first();
  
  if (mainContent.length === 0) {
    mainContent = $("body");
  }

  // Convert to markdown
  const markdown = turndown.turndown(mainContent.html() || "");

  // Clean up excessive whitespace
  const cleanedContent = markdown
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "")
    .trim();

  return { content: cleanedContent, title };
}

/**
 * Extract all internal links from a page
 */
function extractInternalLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const links: Set<string> = new Set();
  const baseHost = new URL(baseUrl).host;

  $("a[href]").each((_, el) => {
    try {
      const href = $(el).attr("href");
      if (!href) return;

      // Resolve relative URLs
      const absoluteUrl = new URL(href, baseUrl);

      // Only include same-domain links
      if (absoluteUrl.host !== baseHost) return;

      // Skip anchors, downloads, etc.
      if (absoluteUrl.hash && absoluteUrl.pathname === new URL(baseUrl).pathname) return;
      if (/\.(pdf|zip|doc|docx|xls|xlsx|png|jpg|jpeg|gif|svg|mp4|mp3)$/i.test(absoluteUrl.pathname)) return;

      // Normalize URL (remove trailing slash, query params for deduplication)
      let normalizedUrl = `${absoluteUrl.protocol}//${absoluteUrl.host}${absoluteUrl.pathname}`;
      normalizedUrl = normalizedUrl.replace(/\/$/, "");

      links.add(normalizedUrl);
    } catch {
      // Invalid URL, skip
    }
  });

  return Array.from(links);
}

/**
 * Normalize a URL for consistent comparison
 */
function normalizeUrl(url: string, baseUrl?: string): string | null {
  try {
    const parsed = baseUrl ? new URL(url, baseUrl) : new URL(url);
    let normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    return normalized.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * Fetch sitemap URLs from robots.txt
 */
async function fetchSitemapFromRobots(baseUrl: string, context: BrowserContext): Promise<string[]> {
  const sitemapUrls: string[] = [];
  const page = await context.newPage();
  
  try {
    const robotsUrl = `${baseUrl}/robots.txt`;
    console.log(`[Crawler] Checking robots.txt: ${robotsUrl}`);
    
    const response = await page.goto(robotsUrl, { 
      waitUntil: "domcontentloaded",
      timeout: 10000 
    });
    
    if (response?.ok()) {
      const text = await page.evaluate(() => document.body.innerText);
      const lines = text.split("\n");
      
      for (const line of lines) {
        const match = line.match(/^sitemap:\s*(.+)$/i);
        if (match) {
          const sitemapUrl = match[1].trim();
          console.log(`[Crawler] Found sitemap in robots.txt: ${sitemapUrl}`);
          sitemapUrls.push(sitemapUrl);
        }
      }
    }
  } catch (error) {
    console.log(`[Crawler] Could not fetch robots.txt: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    await page.close();
  }
  
  return sitemapUrls;
}

/**
 * Parse a sitemap XML and extract URLs
 */
async function parseSitemap(sitemapUrl: string, context: BrowserContext, baseHost: string, depth = 0): Promise<string[]> {
  if (depth > 3) {
    console.log(`[Crawler] Max sitemap depth reached, stopping recursion`);
    return [];
  }
  
  const urls: string[] = [];
  const page = await context.newPage();
  
  try {
    console.log(`[Crawler] Fetching sitemap: ${sitemapUrl}`);
    
    const response = await page.goto(sitemapUrl, { 
      waitUntil: "domcontentloaded",
      timeout: 15000 
    });
    
    if (!response?.ok()) {
      console.log(`[Crawler] Sitemap not found or error: ${sitemapUrl}`);
      return [];
    }
    
    const content = await page.content();
    const $ = cheerio.load(content, { xmlMode: true });
    
    // Check for sitemap index (contains other sitemaps)
    const sitemapLocs = $("sitemap > loc");
    if (sitemapLocs.length > 0) {
      console.log(`[Crawler] Found sitemap index with ${sitemapLocs.length} sitemaps`);
      
      // Recursively parse each sitemap (limit to first 10 sitemaps)
      const nestedSitemaps: string[] = [];
      sitemapLocs.slice(0, 10).each((_, el) => {
        const loc = $(el).text().trim();
        if (loc) nestedSitemaps.push(loc);
      });
      
      await page.close();
      
      // Fetch nested sitemaps in parallel (max 3 at a time)
      const chunks = [];
      for (let i = 0; i < nestedSitemaps.length; i += 3) {
        chunks.push(nestedSitemaps.slice(i, i + 3));
      }
      
      for (const chunk of chunks) {
        const results = await Promise.all(
          chunk.map(sm => parseSitemap(sm, context, baseHost, depth + 1))
        );
        urls.push(...results.flat());
      }
      
      return urls;
    }
    
    // Regular sitemap with URLs
    $("url > loc").each((_, el) => {
      const loc = $(el).text().trim();
      if (loc) {
        try {
          const parsedUrl = new URL(loc);
          // Only include same-domain URLs
          if (parsedUrl.host === baseHost) {
            const normalized = normalizeUrl(loc);
            if (normalized) urls.push(normalized);
          }
        } catch {
          // Invalid URL, skip
        }
      }
    });
    
    console.log(`[Crawler] Found ${urls.length} URLs in sitemap`);
  } catch (error) {
    console.log(`[Crawler] Error parsing sitemap ${sitemapUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    if (!page.isClosed()) await page.close();
  }
  
  return urls;
}

/**
 * Discover all sitemap URLs for a domain
 */
async function discoverSitemapUrls(baseUrl: string, context: BrowserContext): Promise<string[]> {
  const baseHost = new URL(baseUrl).host;
  const allUrls: Set<string> = new Set();
  
  // Common sitemap locations to check
  const defaultSitemaps = [
    `${baseUrl}/sitemap.xml`,
    `${baseUrl}/sitemap_index.xml`,
    `${baseUrl}/sitemap-index.xml`,
  ];
  
  // Get sitemap URLs from robots.txt
  const robotsSitemaps = await fetchSitemapFromRobots(baseUrl, context);
  const sitemapsToCheck = [...new Set([...robotsSitemaps, ...defaultSitemaps])];
  
  // Parse each sitemap
  for (const sitemapUrl of sitemapsToCheck) {
    const urls = await parseSitemap(sitemapUrl, context, baseHost);
    urls.forEach(url => allUrls.add(url));
    
    // If we found URLs, we can stop checking default locations
    if (allUrls.size > 0 && robotsSitemaps.includes(sitemapUrl)) {
      break;
    }
  }
  
  console.log(`[Crawler] Total URLs discovered from sitemaps: ${allUrls.size}`);
  return Array.from(allUrls);
}

/**
 * Scrape a single page
 */
async function scrapePage(
  url: string,
  context: BrowserContext
): Promise<{ page: CrawlPage; links: string[] } | null> {
  const page = await context.newPage();
  
  try {
    // Block unnecessary resources for faster loading
    await page.route("**/*", (route) => {
      const resourceType = route.request().resourceType();
      if (["image", "media", "font", "stylesheet"].includes(resourceType)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    console.log(`[Crawler] Scraping: ${url}`);
    
    const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });

    // Check for non-HTML or error responses
        const contentType = response?.headers()["content-type"] || "";
        const statusCode = response?.status() || 0;
        
        if (!contentType.includes("text/html") || statusCode >= 400) {
      console.log(`[Crawler] Non-HTML or error (${statusCode}): ${url}`);
      return null;
        }

        // Wait a bit for dynamic content
    await page.waitForTimeout(500);

        // Get HTML content
        const html = await page.content();

        // Extract content
        const { content, title } = extractContent(html);
    const wordCount = content.split(/\s+/).length;
    
    // Extract links for further crawling
    const links = extractInternalLinks(html, url);
    
    console.log(`[Crawler] Scraped: ${title} (${wordCount} words, ${links.length} links)`);
    
    return {
      page: { url, title, content, wordCount },
      links,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Crawler] Error scraping ${url}:`, errorMsg);
    return null;
  } finally {
    await page.close();
  }
}

/**
 * Simple concurrency pool for parallel execution
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const running: Promise<void>[] = [];
  
  async function runNext(): Promise<void> {
    if (queue.length === 0) return;
    
    const item = queue.shift()!;
    await fn(item);
    await runNext();
  }
  
  // Start initial batch
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    running.push(runNext());
  }
  
  await Promise.all(running);
}

/**
 * Crawl a website starting from the given URL with parallel processing
 */
export async function crawlWebsite(
  startUrl: string,
  maxPages: number = 8,
  options: CrawlOptions = {}
): Promise<CrawlResult> {
  const {
    maxConcurrency = 5,
    includeSitemap = true,
  } = options;
  
  const startTime = Date.now();
  const pages: CrawlPage[] = [];
  const visited: Set<string> = new Set();
  const queue: string[] = [];
  let sitemapUrlCount = 0;

  // Normalize start URL
  let normalizedStartUrl = startUrl.trim();
  const hasExplicitProtocol = normalizedStartUrl.startsWith("http://") || normalizedStartUrl.startsWith("https://");
  
  if (!hasExplicitProtocol) {
    normalizedStartUrl = `https://${normalizedStartUrl}`;
  }
  normalizedStartUrl = normalizedStartUrl.replace(/\/$/, "");
  
  // Extract base URL (protocol + host)
  const parsedUrl = new URL(normalizedStartUrl);
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

  let browserInstance: Browser;
  let context: BrowserContext;

  try {
    browserInstance = await getBrowser();
    context = await browserInstance.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: "Mozilla/5.0 (compatible; BuildingBlocksCrawler/1.0)",
    });

    // Discover sitemap URLs first
    if (includeSitemap) {
      const sitemapUrls = await discoverSitemapUrls(baseUrl, context);
      sitemapUrlCount = sitemapUrls.length;
      
      // Add sitemap URLs to queue (prioritize start URL)
      for (const url of sitemapUrls) {
        if (!queue.includes(url)) {
          queue.push(url);
        }
      }
    }
    
    // Ensure start URL is at the front
    if (!queue.includes(normalizedStartUrl)) {
      queue.unshift(normalizedStartUrl);
    } else {
      // Move to front if already in queue
      const idx = queue.indexOf(normalizedStartUrl);
      if (idx > 0) {
        queue.splice(idx, 1);
        queue.unshift(normalizedStartUrl);
      }
    }

    console.log(`[Crawler] Starting parallel crawl with concurrency=${maxConcurrency}, maxPages=${maxPages}`);
    console.log(`[Crawler] Queue initialized with ${queue.length} URLs`);

    // Process queue with parallel workers
    while (queue.length > 0 && pages.length < maxPages) {
      // Take a batch from the queue
      const batchSize = Math.min(maxConcurrency, maxPages - pages.length, queue.length);
      const batch: string[] = [];
      
      while (batch.length < batchSize && queue.length > 0) {
        const url = queue.shift()!;
        if (!visited.has(url)) {
          visited.add(url);
          batch.push(url);
        }
      }
      
      if (batch.length === 0) break;
      
      console.log(`[Crawler] Processing batch of ${batch.length} URLs in parallel`);
      
      // Scrape batch in parallel
      const results = await Promise.all(
        batch.map(url => scrapePage(url, context))
      );
      
      // Process results
      for (const result of results) {
        if (result && pages.length < maxPages) {
          pages.push(result.page);
          
          // Add new links to queue
          for (const link of result.links) {
          if (!visited.has(link) && !queue.includes(link)) {
            queue.push(link);
          }
          }
        }
      }
    }

    await context.close();

    return {
      success: pages.length > 0,
      pages,
      totalPages: pages.length,
      duration: Date.now() - startTime,
      sitemapUrls: sitemapUrlCount,
      error: pages.length === 0 ? "No content could be extracted from any pages" : undefined,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Crawler] Fatal error:`, error);
    return {
      success: false,
      pages,
      totalPages: pages.length,
      duration: Date.now() - startTime,
      error: errorMsg,
    };
  }
}

/**
 * Graceful shutdown
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
