// server.js – VIDISKY proxy (Outscraper + ApartmentRatings + Apartments.com)
// Node 22, ESM

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { load } from "cheerio";

const app = express();
app.use(cors());
app.use(express.json());

// ---------- config / helpers ----------
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

// ---- helper: detect if Outscraper JSON actually contains review data ----
function hasReviewData(json) {
  if (!json) return false;
  if (Array.isArray(json)) return json.length > 0;

  const arrays = [
    json.data,
    json.results,
    json.reviews,
    json.reviews_data,
  ].filter(Array.isArray);

  if (arrays.some((a) => a.length > 0)) return true;

  // some payloads: { items: [{ reviews_data:[...] }, ...] }
  if (Array.isArray(json.items)) {
    for (const it of json.items) {
      if (Array.isArray(it?.reviews_data) && it.reviews_data.length > 0) return true;
      if (Array.isArray(it?.reviews) && it.reviews.length > 0) return true;
    }
  }
  return false;
}

// ---- helper: poll Outscraper results until ready (handles 202 + Pending) ----
async function pollOutscraper(requestUrl, headers, { maxWaitMs = 60000, intervalMs = 1500 } = {}) {
  const started = Date.now();
  let lastJson = null;

  while (Date.now() - started < maxWaitMs) {
    const r = await fetch(requestUrl, { headers });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore parse error */ }
    lastJson = json;

    // Only return when we actually see data
    if (hasReviewData(json)) return json;

    // If explicitly marked success/done but no data, still return (we'll normalize to [])
    if (json && typeof json === "object") {
      const s = String(json.status || "").toLowerCase();
      if (s === "success" || s === "done" || s === "ok" || s === "completed") {
        return json;
      }
    }

    // Otherwise keep waiting (still pending)
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  // timeout: return whatever we last saw
  return lastJson;
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

    // 2) Immediate data (rare)
    if (hasReviewData(triggerJson)) {
      finalJson = triggerJson;
    } else {
      // 3) Poll results_location (typical for 202 Pending)
      const resultsUrl =
        triggerJson?.results_location ||
        triggerJson?.resultsLocation ||
        triggerJson?.result_url ||
        (triggerJson?.id ? `https://api.outscraper.cloud/requests/${triggerJson.id}` : null);

      if (!resultsUrl) {
        console.warn("[WARN] No results_location or id returned by Outscraper trigger.");
        return res.json([]);
      }
      finalJson = await pollOutscraper(resultsUrl, headers);
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
    if (!blocks.length && Array.isArray(finalJson?.items)) blocks.push(...finalJson.items);

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
