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
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-blink-features=AutomationControlled"]
  });

  const context = await browser.newContext({
    ...devices["Desktop Chrome"],
    locale: "en-US",
    geolocation: { latitude: 37.3382, longitude: -121.8863 },
    permissions: ["geolocation"],
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
  });

  const page = await context.newPage();
  const q = `${name} ${location}`.trim();
  const searchVariants = [
    `https://www.google.com/maps/search/${encodeURIComponent(q)}?hl=en&gl=us`,
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}&hl=en&gl=us`
  ];

  // Helper: wait for "place" UI (either heading or any reviews button)
  const waitForPlaceUI = async (ms = 8000) => {
    return await Promise.race([
      page.waitForSelector('button[aria-label*="reviews"], button[jsaction*="pane.reviewChart"]', { timeout: ms }).then(() => true).catch(() => false),
      page.waitForSelector('h1[aria-level="1"], h1[role="heading"]', { timeout: ms }).then(() => true).catch(() => false)
    ]);
  };

  // Try to open the first result if we land on a results list
  const tryOpenFirstResult = async () => {
    if (await waitForPlaceUI()) return true;

    const candidates = [
      'a[data-result-id]:has(h3)',
      'a.hfpxzc',
      '[role="feed"] a[href*="/place/"]',
      'div[role="article"] a[href*="/place/"]',
      'a[aria-label][href*="/place/"]'
    ];

    for (const sel of candidates) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 8000 }).catch(() => {});
        if (await waitForPlaceUI()) return true;
      }
    }

    const searchBox = page.locator('input[aria-label*="Search"]');
    if (await searchBox.first().isVisible().catch(() => false)) {
      await searchBox.first().press("Enter").catch(() => {});
      if (await waitForPlaceUI()) return true;
    }
    return false;
  };

  // Click into reviews view (button, chart, or Reviews tab)
  const openReviews = async () => {
    const btns = [
      'button[aria-label*="reviews"]',
      'button[jsaction*="pane.reviewChart"]',
      '[role="tab"]:has-text("Reviews")',
      'a[href*="reviews"]'
    ];
    for (const sel of btns) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);
        // if a modal opened, it still contains review cards, so just proceed
        return true;
      }
    }
    return false;
  };

  try {
    // Navigate using variants until we’re on a place page
    let onPlace = false;
    for (const url of searchVariants) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      onPlace = (await tryOpenFirstResult()) || (await waitForPlaceUI());
      if (onPlace) break;
    }
    if (!onPlace) throw new Error("Could not open a place page.");

    // Open reviews
    await openReviews();

    // Wait until we actually see review cards (handle multiple UIs)
    const cardSelectors = [
      'div[data-review-id]',                       // common
      '[aria-label="Review"]',                     // ARIA region
      'div[jscontroller][data-review-id]',
      'div.section-review',                        // legacy
      'div[data-section-id="reviews"] div[role="article"]'
    ];
    let cardsLocator = null;
    for (const sel of cardSelectors) {
      const loc = page.locator(sel);
      if (await loc.first().isVisible({ timeout: 3000 }).catch(() => false)) {
        cardsLocator = loc;
        break;
      }
    }
    if (!cardsLocator) {
      // try a short wait then one more pass
      await page.waitForTimeout(2000);
      for (const sel of cardSelectors) {
        const loc = page.locator(sel);
        if (await loc.first().isVisible({ timeout: 3000 }).catch(() => false)) {
          cardsLocator = loc;
          break;
        }
      }
    }
    if (!cardsLocator) throw new Error("Review cards not found");

    // Find the nearest scrollable ancestor of the first review card
    const scroller = await cardsLocator.first().evaluateHandle((el) => {
      function isScrollable(n){ return n && n.scrollHeight > n.clientHeight; }
      let cur = el;
      while (cur && cur !== document.body && !isScrollable(cur)) cur = cur.parentElement;
      return cur && isScrollable(cur) ? cur : document.scrollingElement || document.body;
    });

    // Sort menu → "Newest" (best effort)
    const sortBtn = page.locator('button[aria-label*="Sort"], div[role="button"][aria-label*="Sort"]');
    if (await sortBtn.first().isVisible().catch(()=>false)) {
      await sortBtn.first().click({ timeout: 8000 }).catch(()=>{});
      const newest = page.locator('div[role="menuitem"]:has-text("Newest")');
      if (await newest.first().isVisible().catch(()=>false)) {
        await newest.first().click({ timeout: 8000 }).catch(()=>{});
      }
    }

    // Scroll & collect
    const texts = new Set();
    let stagnation = 0, lastCount = 0;

    while (texts.size < maxReviews && Date.now() - start < timeoutMs) {
      // Extract from each visible card (multiple patterns)
      const chunk = await cardsLocator.evaluateAll((nodes) => {
        const arr = [];
        for (const n of nodes) {
          const long = n.querySelector('span[jsname="fbQN7e"], span[class*="full-text"], div[data-review-text]');
          const short = n.querySelector('span[jsname="bN97Pc"], span[class*="snippet"], span[class*="review-text"]');
          const alt = n.querySelector('[data-review-text], [itemprop="reviewBody"]');
          const t = (long?.innerText || short?.innerText || alt?.innerText || "").trim();
          if (t && t.length > 5) arr.push(t);
        }
        return arr;
      });

      for (const t of chunk) texts.add(t);

      const countNow = texts.size;
      stagnation = countNow > lastCount ? 0 : (stagnation + 1);
      lastCount = countNow;
      if (texts.size >= maxReviews || stagnation >= 6) break;

      // scroll the detected container
      await scroller.evaluate((el) => { el.scrollBy(0, el.scrollHeight); });
      await page.waitForTimeout(1000);
    }

    // Try to fetch a shareable place URL (optional)
    let placeUrl = "";
    try {
      const shareBtn = page.locator('button[aria-label*="Share"]');
      if (await shareBtn.first().isVisible({ timeout: 1500 }).catch(() => false)) {
        await shareBtn.first().click().catch(() => {});
        const input = page.locator('input[aria-label="Link to share"]');
        if (await input.first().isVisible().catch(() => false)) {
          placeUrl = await input.first().inputValue().catch(() => "");
          await page.keyboard.press("Escape").catch(() => {});
        }
      }
    } catch {}

    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});

    return Array.from(texts).slice(0, maxReviews).map(text => ({ text, url: placeUrl || searchVariants[0] }));
  } catch (e) {
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
    throw e;
  }
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
