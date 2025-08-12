// server.js – VIDISKY proxy (Outscraper + ApartmentRatings + Apartments.com)
// Node 22, ESM

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { load } from "cheerio"; // correct ESM import for cheerio

const app = express();
// In prod, restrict to your frontend: app.use(cors({ origin: "https://YOUR-APP.vercel.app" }));
app.use(cors());
app.use(express.json());

// ----- config / helpers -----
const OUTSCRAPER_API_KEY =
  process.env.OUTSCRAPER_API_KEY || process.env.OUTSCRAPER_KEY;

const cache = new Map();
const TTL_MS = 1000 * 60 * 60 * 6; // 6h cache to reduce costs

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

const qParam = (obj) => new URLSearchParams(obj).toString();
function required(q, name) {
  const v = (q[name] || "").toString().trim();
  if (!v) {
    const e = new Error(`Missing required query param: ${name}`);
    e.statusCode = 400;
    throw e;
  }
  return v;
}

// --- helper: poll Outscraper results until ready (handles 202 Pending) ---
async function pollOutscraper(requestUrl, headers, { maxWaitMs = 25000, intervalMs = 1500 } = {}) {
  const started = Date.now();
  let lastJson = null;

  while (Date.now() - started < maxWaitMs) {
    const r = await fetch(requestUrl, { headers });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    lastJson = json;

    // When ready, Outscraper typically returns 200 with data
    if (r.status === 200) return json;
    if (json && (json.status === "Success" || json.status === "Done")) return json;

    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return lastJson; // return whatever we last saw (for debugging)
}

// -----------------------------------------------------------------------------
// Google reviews via Outscraper  →  returns [{ text, url }]
// -----------------------------------------------------------------------------
app.get("/google-reviews", async (req, res) => {
  try {
    const name = required(req.query, "name");
    const location = required(req.query, "location");
    const cacheKey = `g:${name}|${location}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    if (!OUTSCRAPER_API_KEY) {
      console.warn("[WARN] OUTSCRAPER_API_KEY missing; returning [].");
      return res.json([]);
    }

    const headers = { "X-API-KEY": OUTSCRAPER_API_KEY };
    const triggerUrl =
      `https://api.app.outscraper.com/maps/reviews?` +
      qParam({
        query: `${name} ${location}`,
        reviewsLimit: "50",
        reviewsSort: "newest",
        language: "en",
      });

    // 1) Trigger job
    const triggerResp = await fetch(triggerUrl, { headers });
    const triggerText = await triggerResp.text();
    let triggerJson = null;
    try { triggerJson = JSON.parse(triggerText); } catch {}

    if (!triggerResp.ok) {
      console.error("Outscraper trigger error", triggerResp.status, triggerText);
      return res.json([]);
    }

    let finalJson = null;

    // 2) If immediate data returned, use it
    if (
      Array.isArray(triggerJson) ||
      (triggerJson && (triggerJson.data || triggerJson.results || triggerJson.reviews || triggerJson.reviews_data))
    ) {
      finalJson = triggerJson;
    } else {
      // 3) Otherwise poll the results_location (202 Pending case)
      const resultsUrl =
        triggerJson?.results_location ||
        triggerJson?.resultsLocation ||
        triggerJson?.result_url ||
        null;

      if (resultsUrl) {
        finalJson = await pollOutscraper(resultsUrl, headers);
      } else if (triggerJson?.id) {
        // Fallback pattern if only id returned
        finalJson = await pollOutscraper(`https://api.outscraper.cloud/requests/${triggerJson.id}`, headers);
      } else {
        // Nothing else we can do
        return res.json([]);
      }
    }

    // 4) Normalize to [{ text, url }]
    const out = [];
    const push = (rv, placeUrl) => {
      const text =
        (rv &&
          (rv.text ||
           rv.review_text ||
           rv.snippet ||
           rv.review ||
           rv.content)) || "";
      const t = String(text).trim();
      if (!t) return;
      const url = rv.review_link || rv.url || rv.review_url || placeUrl || "";
      out.push({ text: t, url });
    };

    const blocks = [];
    if (Array.isArray(finalJson)) blocks.push(...finalJson);
    if (finalJson?.data) blocks.push(...finalJson.data);
    if (finalJson?.results) blocks.push(...finalJson.results);
    if (!blocks.length && (finalJson?.reviews_data || finalJson?.reviews)) blocks.push(finalJson);

    for (const block of blocks) {
      const placeUrl = block?.url || block?.place_link || "";
      let reviews =
        block?.reviews ||
        block?.reviews_data ||
        block?.reviewsData ||
        block?.data ||
        [];

      if (!Array.isArray(reviews) && Array.isArray(block?.items)) {
        reviews = block.items.flatMap((it) => it?.reviews_data || it?.reviews || []);
      }

      if (Array.isArray(reviews)) reviews.forEach((rv) => push(rv, placeUrl));
    }

    // 5) Dedupe by text
    const seen = new Set();
    const unique = [];
    for (const r of out) {
      const k = r.text.toLowerCase();
      if (k && !seen.has(k)) { seen.add(k); unique.push(r); }
    }

    setCache(cacheKey, unique);
    res.json(unique);
  } catch (e) {
    console.error(e);
    res.status(e.statusCode || 500).json({ error: "google-reviews failed" });
  }
});

// -----------------------------------------------------------------------------
// ApartmentRatings.com (best-effort HTML parse)  → returns [{ text, url }]
// -----------------------------------------------------------------------------
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
    // NOTE: AR often renders reviews client-side; selectors may return few/none.
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

// -----------------------------------------------------------------------------
// Apartments.com (optional best-effort HTML parse)  → returns [{ text, url }]
// -----------------------------------------------------------------------------
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

    const firstLink = $('a.placardTitle, a.property-link, a[data-tid="listing-card-title"]').first().attr("href");
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

// -----------------------------------------------------------------------------
// DEBUG endpoints (optional; remove once stable)
// -----------------------------------------------------------------------------
app.get("/env-check", (req, res) => {
  const key = (process.env.OUTSCRAPER_API_KEY || "").trim();
  res.json({
    hasKey: Boolean(key),
    keyPreview: key ? key.slice(0, 4) + "..." + key.slice(-4) : null,
    nodeVersion: process.version,
  });
});

app.get("/debug-google", async (req, res) => {
  try {
    const name = required(req.query, "name");
    const location = required(req.query, "location");

    if (!process.env.OUTSCRAPER_API_KEY) {
      return res.status(400).json({ error: "OUTSCRAPER_API_KEY missing on server" });
    }

    const requestUrl =
      `https://api.app.outscraper.com/maps/reviews?` +
      new URLSearchParams({
        query: `${name} ${location}`,
        reviewsLimit: "10",
        reviewsSort: "newest",
        language: "en",
      }).toString();

    const resp = await fetch(requestUrl, {
      headers: { "X-API-KEY": process.env.OUTSCRAPER_API_KEY },
    });

    const contentType = resp.headers.get("content-type") || "";
    let bodyText = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(bodyText); } catch {}

    res.status(resp.status).json({
      ok: resp.ok,
      status: resp.status,
      contentType,
      requestUrl,
      bodyPreview: bodyText.slice(0, 2000),
      jsonType: parsed && (Array.isArray(parsed) ? "array" : typeof parsed),
      jsonLength: parsed && (Array.isArray(parsed) ? parsed.length : undefined),
      jsonKeys: parsed && !Array.isArray(parsed) ? Object.keys(parsed) : undefined,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "debug-google failed", message: e.message });
  }
});

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
  if (!OUTSCRAPER_API_KEY) {
    console.log("[NOTE] Set OUTSCRAPER_API_KEY to enable /google-reviews (otherwise it returns []).");
  }
});
