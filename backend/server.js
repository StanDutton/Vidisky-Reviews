// server.js – VIDISKY proxy (Google scraper via Playwright + ApartmentRatings + Apartments.com)
// Node 22, ESM

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { load } from "cheerio";
import { chromium, devices } from "playwright";

const app = express();
app.use(cors());
app.use(express.json());

// ---------- tiny cache ----------
const cache = new Map();
const TTL_MS = 1000 * 60 * 60 * 6; // 6h cache

const getCache = (k) => {
  const x = cache.get(k);
  if (!x) return null;
  if (Date.now() - x.ts > TTL_MS) {
    cache.delete(k);
    return null;
  }
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

// ============================================================================
// GOOGLE MAPS SCRAPER (Playwright)
// ============================================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * scrapeGoogleReviews
 * - Opens Google Maps for "{name} {location}"
 * - Clicks first result → "All reviews"
 * - Sorts by "Newest" (if available)
 * - Scrolls to load up to maxReviews
 * - Returns [{ text, url }]
 */
async function scrapeGoogleReviews({ name, location, maxReviews = 80, timeoutMs = 90000 }) {
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
    geolocation: { latitude: 27.4989, longitude: -82.5748 }, // arbitrary; helps Maps load
    permissions: ["geolocation"],
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
  });

  const page = await context.newPage();
  const q = `${name} ${location}`.trim();
  const mapsSearch = `https://www.google.com/maps/search/${encodeURIComponent(q)}`;
  const out = [];

  try {
    // 1) Open search
    await page.goto(mapsSearch, { waitUntil: "domcontentloaded", timeout: 45000 });

    // 2) Click first result in left panel (robust-ish selectors)
    const firstCard = page.locator('a[data-result-id]:has(h3), a.hfpxzc');
    await firstCard.first().click({ timeout: 20000 });

    // 3) Wait for the place panel
    await page.waitForSelector('button[aria-label*="reviews"], button[jsaction*="pane.reviewChart"]', { timeout: 20000 });

    // 4) Open "All reviews"
    const allReviewsBtn = page.locator('button[aria-label*="reviews"], button[jsaction*="pane.reviewChart"]');
    await allReviewsBtn.first().click({ timeout: 15000 });

    // 5) Try to sort by "Newest"
    const sortButton = page.locator('button[aria-label*="Sort"], div[role="button"][aria-label*="Sort"]');
    if (await sortButton.first().isVisible().catch(()=>false)) {
      await sortButton.first().click({ timeout: 8000 }).catch(()=>{});
      const newest = page.locator('div[role="menuitem"]:has-text("Newest")');
      if (await newest.first().isVisible().catch(()=>false)) {
        await newest.first().click({ timeout: 8000 }).catch(()=>{});
      }
    }

    // 6) Scroll to load more reviews
    const scroller = page.locator('div[aria-label*="Google reviews"], div[aria-label="Reviews"], div[role="region"]');
    await scroller.first().waitFor({ timeout: 10000 });

    let loaded = 0, stagnation = 0, lastCount = 0;
    while (loaded < maxReviews && Date.now() - start < timeoutMs) {
      const reviewCards = page.locator('div[data-review-id], div[jscontroller][data-review-id]');
      const count = await reviewCards.count().catch(()=>0);

      if (count > lastCount) { lastCount = count; stagnation = 0; }
      else { stagnation += 1; }

      // extract currently loaded review texts
      const items = await reviewCards.evaluateAll(cards => {
        const arr = [];
        for (const el of cards) {
          const long = el.querySelector('span[jsname="fbQN7e"], span[class*="review-full-text"]');
          const short = el.querySelector('span[jsname="bN97Pc"], span[class*="review-snippet"]');
          const text = (long?.textContent || short?.textContent || "").trim();
          if (text && text.length > 5) arr.push({ text });
        }
        return arr;
      });

      for (const it of items) {
        const k = it.text.toLowerCase();
        if (!out.some(x => x.text.toLowerCase() === k)) out.push(it);
      }
      loaded = out.length;

      if (loaded >= maxReviews) break;
      if (stagnation >= 6) break;

      await scroller.evaluate(el => { el.scrollBy(0, el.scrollHeight); });
      await sleep(900);
    }

    // 7) Try to copy a shareable place URL (nice-to-have)
    let placeUrl = "";
    try {
      const shareBtn = page.locator('button[aria-label*="Share"]');
      if (await shareBtn.first().isVisible({ timeout: 2000 }).catch(()=>false)) {
        await shareBtn.first().click().catch(()=>{});
        const input = page.locator('input[aria-label="Link to share"]');
        if (await input.first().isVisible().catch(()=>false)) {
          placeUrl = await input.first().inputValue().catch(()=> "");
          await page.keyboard.press("Escape").catch(()=>{});
        }
      }
    } catch {}

    return out.slice(0, maxReviews).map(r => ({ text: r.text, url: placeUrl || "" }));
  } finally {
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
}

// ----------------------------------------------------------------------------
// Route: /google-scrape  (FREE, Playwright-based)
//   Query: ?name=...&location=...&max=80&keywords=security,pet%20waste
// ----------------------------------------------------------------------------
app.get("/google-scrape", async (req, res) => {
  try {
    const name = required(req.query, "name");
    const location = required(req.query, "location");
    const max = Math.min(parseInt(req.query.max || "80", 10) || 80, 200);
    const keywordsStr = (req.query.keywords || "").toLowerCase();
    const keywords = keywordsStr ? keywordsStr.split(",").map(s => s.trim()).filter(Boolean) : [];

    const cacheKey = `gs:${name}|${location}|${max}`;
    const cached = getCache(cacheKey);
    let base = cached;
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
    // Return an informative error so you can see what happened in the client
    res.status(500).json({ error: "google-scrape failed", message: e.message || String(e) });
  }
});

// ============================================================================
// ApartmentRatings.com – best-effort HTML parse (no keys)
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
    // NOTE: AR often renders via JS, so yields may be thin.
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
// Apartments.com – best-effort HTML parse (no keys)
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
// Start server
// ============================================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
