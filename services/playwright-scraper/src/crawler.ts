import { chromium, Browser, Page } from "playwright";
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
  error?: string;
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
 * Crawl a website starting from the given URL
 */
export async function crawlWebsite(
  startUrl: string,
  maxPages: number = 8
): Promise<CrawlResult> {
  const startTime = Date.now();
  const pages: CrawlPage[] = [];
  const visited: Set<string> = new Set();
  const queue: string[] = [];

  // Normalize start URL - we'll try https first, then http if that fails
  let normalizedStartUrl = startUrl.trim();
  const hasExplicitProtocol = normalizedStartUrl.startsWith("http://") || normalizedStartUrl.startsWith("https://");
  
  if (!hasExplicitProtocol) {
    normalizedStartUrl = `https://${normalizedStartUrl}`;
  }
  normalizedStartUrl = normalizedStartUrl.replace(/\/$/, "");

  // Track if we should try HTTP fallback
  let shouldTryHttpFallback = !hasExplicitProtocol || normalizedStartUrl.startsWith("https://");
  const baseDomain = normalizedStartUrl.replace(/^https?:\/\//, "");

  queue.push(normalizedStartUrl);

  let browserInstance: Browser;
  let page: Page;

  try {
    browserInstance = await getBrowser();
    page = await browserInstance.newPage();

    // Set reasonable timeout and viewport
    page.setDefaultTimeout(30000);
    await page.setViewportSize({ width: 1280, height: 720 });

    // Block unnecessary resources for faster loading
    await page.route("**/*", (route) => {
      const resourceType = route.request().resourceType();
      if (["image", "media", "font", "stylesheet"].includes(resourceType)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    while (queue.length > 0 && pages.length < maxPages) {
      const currentUrl = queue.shift()!;

      // Skip if already visited
      if (visited.has(currentUrl)) continue;
      visited.add(currentUrl);

      try {
        console.log(`[Crawler] Crawling: ${currentUrl}`);

        // Navigate to page
        const response = await page.goto(currentUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });

        // Check for non-HTML or error responses - try HTTP fallback
        const contentType = response?.headers()["content-type"] || "";
        const statusCode = response?.status() || 0;
        
        if (!contentType.includes("text/html") || statusCode >= 400) {
          console.log(`[Crawler] Non-HTML or error (${statusCode}): ${currentUrl}`);
          
          // Try HTTP fallback if HTTPS returned error
          if (shouldTryHttpFallback && currentUrl.startsWith("https://") && pages.length === 0) {
            const httpUrl = currentUrl.replace("https://", "http://");
            if (!visited.has(httpUrl)) {
              console.log(`[Crawler] Trying HTTP fallback: ${httpUrl}`);
              queue.unshift(httpUrl);
              shouldTryHttpFallback = false;
            }
          }
          continue;
        }

        // Wait a bit for dynamic content
        await page.waitForTimeout(1000);

        // Get HTML content
        const html = await page.content();

        // Extract content
        const { content, title } = extractContent(html);

        // Track word count but don't skip - even low-content pages may be useful
        const wordCount = content.split(/\s+/).length;
        if (wordCount < 10) {
          console.log(`[Crawler] Very low content (${wordCount} words): ${currentUrl}`);
          // Still include it - better than nothing
        }

        pages.push({
          url: currentUrl,
          title,
          content,
          wordCount,
        });

        console.log(`[Crawler] Scraped: ${title} (${wordCount} words)`);

        // Extract links for further crawling
        const links = extractInternalLinks(html, currentUrl);
        for (const link of links) {
          if (!visited.has(link) && !queue.includes(link)) {
            queue.push(link);
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        console.error(`[Crawler] Error crawling ${currentUrl}:`, errorMsg);
        
        // If HTTPS failed and we haven't tried HTTP yet, add HTTP version to queue
        if (shouldTryHttpFallback && currentUrl.startsWith("https://") && pages.length === 0) {
          const httpUrl = currentUrl.replace("https://", "http://");
          if (!visited.has(httpUrl)) {
            console.log(`[Crawler] HTTPS failed, trying HTTP fallback: ${httpUrl}`);
            queue.unshift(httpUrl); // Add to front of queue
            shouldTryHttpFallback = false; // Only try once
          }
        }
        // Continue with next URL
      }
    }

    await page.close();

    return {
      success: pages.length > 0, // Only success if we got at least one page
      pages,
      totalPages: pages.length,
      duration: Date.now() - startTime,
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

