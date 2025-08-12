// server.js – VIDISKY proxy (Google scraper via Playwright + ApartmentRatings + Apartments.com)
// Node 22, ESM

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { load } from "cheerio";
import { chromium, devices } from "playwright";

const app = express();
app.use(cors());            // In prod, restrict to your frontend origin
app.use(express.json());

// ---------------- tiny in-memory cache ----------------
const cache = new Map();
const TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

const getCache = (k) => {
  const x = cache.get(k);
  if (!x) return null;
  if (Date.now() - x.ts > TTL_MS) { cache.delete(k); return null; }
  return x.v;
};
const setCache = (k, v) => cache.set(k, { ts: Date.now(), v });

function required(q, name) {
  const v = (q[name] || "").toString().trim();
  if (!v) {
    const e = new Error(`Missing required query param: ${name}`);
    e.statusCode = 400;
    throw e;
  }
  return v;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================================
// GOOGLE MAPS SCRAPER (Playwright) – /google-scrape
// ============================================================================
/**
 * Scrapes Google Maps reviews for "{name} {location}"
 * Steps:
 * 1) Open Maps search for the query
 * 2) Click first result
 * 3) Click "All reviews"
 * 4) (If available) set sort to "Newest"
 * 5) Scroll the reviews panel to load more
 * Returns: [{ text, url }]
 */
async function scrapeGoogleReviews({ name, location, maxReviews = 80, timeoutMs = 120000 }) {
  const start = Date.now();
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const context = await browser.newContext({
    ...devices["Desktop Chrome"],
    locale: "en-US",
    geolocation: { latitude: 37.3382, longitude: -121.8863 }, // San Jose area
    permissions: ["geolocation"],
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
  });

  const page = await context.newPage();
  const q = `${name} ${location}`.trim();
  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(q)}?hl=en&gl=us`;

  await page.goto(searchUrl, { timeout: 45000, waitUntil: "domcontentloaded" });

  // Click into first search result if not already on a place page
  const firstResultSel = [
    'a[data-result-id]:has(h3)',
    'a.hfpxzc',
    '[role="feed"] a[href*="/place/"]',
    'div[role="article"] a[href*="/place/"]'
  ];
  let foundResult = false;
  for (const sel of firstResultSel) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 8000 }).catch(() => {});
      foundResult = true;
      break;
    }
  }
  if (foundResult) {
    await page.waitForTimeout(4000);
  }

  // Click the "All reviews" or "Reviews" button
  const reviewBtn = page.locator(
    'button[aria-label*="reviews"], button[jsaction*="pane.reviewChart"]'
  ).first();
  if (await reviewBtn.isVisible().catch(() => false)) {
    await reviewBtn.click({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  // Find the scrollable reviews container dynamically
  const scrollerHandle = await page.evaluateHandle(() => {
    const reviewEls = document.querySelectorAll('[aria-label^="Reviews"], [aria-label*="reviews"]');
    if (reviewEls.length > 0) {
      let el = reviewEls[0];
      while (el && el.scrollHeight <= el.clientHeight) {
        el = el.parentElement;
      }
      return el;
    }
    // fallback: biggest scrollable div
    let biggest = null;
    document.querySelectorAll("div").forEach(d => {
      if (d.scrollHeight > d.clientHeight) {
        if (!biggest || d.scrollHeight > biggest.scrollHeight) biggest = d;
      }
    });
    return biggest;
  });

  if (!scrollerHandle) throw new Error("Could not find reviews scroller");

  // Scroll to load reviews
  let reviews = new Set();
  while (reviews.size < maxReviews && Date.now() - start < timeoutMs) {
    await scrollerHandle.evaluate(el => {
      el.scrollBy(0, el.scrollHeight);
    });
    await page.waitForTimeout(1500);

    const texts = await page.$$eval('div[aria-label="Review"] div[jscontroller] > div:last-child', els =>
      els.map(e => e.innerText).filter(Boolean)
    );
    texts.forEach(t => reviews.add(t));
    if (reviews.size >= maxReviews) break;
  }

  await browser.close();
  return Array.from(reviews).map(text => ({
    text,
    url: searchUrl,
    source: "Google"
  }));
}



// Route: FREE Google scraper
// Usage: /google-scrape?name=...&location=...&max=80&keywords=security,pet%20waste,loiter
app.get("/google-scrape", async (req, res) => {
  try {
    const name = required(req.query, "name");
    const location = required(req.query, "location");
    const max = Math.min(parseInt(req.query.max || "80", 10) || 80, 200);
    const keywordsStr = (req.query.keywords || "").toLowerCase();
    const keywords = keywordsStr ? keywordsStr.split(",").map(s => s.trim()).filter(Boolean) : [];

    const cacheKey = `gs:${name}|${location}|${max}`;
    let base = getCache(cacheKey);
    if (!base) {
      base = await scrapeGoogleReviews({ name, location, maxReviews: max, timeoutMs: 90000 });
      setCache(cacheKey, base);
    }

    let result = base;
    if (keywords.length) {
      result = base.filter(r => keywords.some(k => r.text.toLowerCase().includes(k)));
    }

    res.json(result);
  } catch (e) {
    console.error("google-scrape failed", e);
    res.status(500).json({ error: "google-scrape failed", message: e.message || String(e) });
  }
});

// ============================================================================
// ApartmentRatings.com – best-effort HTML parse (no API key)
// ============================================================================
app.get("/apartmentratings", async (req, res) => {
  try {
    const name = required(req.query, "name");
    const location = required(req.query, "location");
    const cacheKey = `ar:${name}|${location}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const query = `${name} ${location}`;
    const searchUrl = `https://www.apartmentratings.com/search/?q=${encodeURIComponent(query)}`;
    const sr = await fetch(searchUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!sr.ok) return res.json([]);
    let $ = load(await sr.text());

    const firstLink = $('a.property-title, a[href*="/apartment/"]').first().attr("href");
    if (!firstLink) return res.json([]);
    const propertyUrl = firstLink.startsWith("http")
      ? firstLink
      : `https://www.apartmentratings.com${firstLink}`;

    const pr = await fetch(propertyUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!pr.ok) return res.json([]);
    $ = load(await pr.text());

    const out = [];
    // NOTE: AR often renders with JS; expect sparse yields.
    $(".review__content, .review__text, .review-body").each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 30) out.push({ text, url: propertyUrl });
    });

    setCache(cacheKey, out);
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(e.statusCode || 500).json({ error: "apartmentratings failed" });
  }
});

// ============================================================================
// Apartments.com – best-effort HTML parse (no API key)
// ============================================================================
app.get("/apartments-com", async (req, res) => {
  try {
    const name = required(req.query, "name");
    const location = required(req.query, "location");
    const cacheKey = `ac:${name}|${location}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const query = `${name} ${location}`;
    const searchUrl = `https://www.apartments.com/search/?q=${encodeURIComponent(query)}`;
    const sr = await fetch(searchUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!sr.ok) return res.json([]);
    let $ = load(await sr.text());

    const firstLink = $(
      'a.placardTitle, a.property-link, a[data-tid="listing-card-title"]'
    ).first().attr("href");
    if (!firstLink) return res.json([]);
    const propertyUrl = firstLink.startsWith("http")
      ? firstLink
      : `https://www.apartments.com${firstLink}`;

    const pr = await fetch(propertyUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!pr.ok) return res.json([]);
    $ = load(await pr.text());

    const out = [];
    const selectors = [
      'section:contains("Reviews") p',
      "#reviews p",
      ".review, .reviewText, .review__content, .review__text",
    ];
    $(selectors.join(",")).each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 30) out.push({ text, url: propertyUrl });
    });

    setCache(cacheKey, out);
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(e.statusCode || 500).json({ error: "apartments-com failed" });
  }
});

// ============================================================================
// Health check
// ============================================================================
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ============================================================================
// Start server
// ============================================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
