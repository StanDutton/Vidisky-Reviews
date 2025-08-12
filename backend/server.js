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

// ---- detect if Outscraper JSON actually contains review data ----
function hasReviewData(json) {
  if (!json) return false;
  if (Array.isArray(json)) return json.length > 0;

  const arrays = [json.data, json.results, json.reviews, json.reviews_data].filter(
    Array.isArray
  );
  if (arrays.some((a) => a.length > 0)) return true;

  if (Array.isArray(json.items)) {
    for (const it of json.items) {
      if (Array.isArray(it?.reviews_data) && it.reviews_data.length > 0) return true;
      if (Array.isArray(it?.reviews) && it.reviews.length > 0) return true;
    }
  }
  return false;
}

// ---- normalize any Outscraper payload → [{ text, url }] ----
function normalizeReviews(payload) {
  const out = [];
  const push = (rv, placeUrl) => {
    const text =
      (rv &&
        (rv.text ||
          rv.review_text ||
          rv.snippet ||
          rv.review ||
          rv.content)) ||
      "";
    const t = String(text).trim();
    if (!t) return;
    const url = rv.review_link || rv.url || rv.review_url || placeUrl || "";
    out.push({ text: t, url });
  };

  const blocks = [];
  if (Array.isArray(payload)) blocks.push(...payload);
  if (payload?.data) blocks.push(...payload.data);
  if (payload?.results) blocks.push(...payload.results);
  if (!blocks.length && (payload?.reviews_data || payload?.reviews)) blocks.push(payload);
  if (!blocks.length && Array.isArray(payload?.items)) blocks.push(...payload.items);

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

  // dedupe by text
  const seen = new Set();
  const uniq = [];
  for (const r of out) {
    const k = r.text.toLowerCase();
    if (k && !seen.has(k)) { seen.add(k); uniq.push(r); }
  }
  return uniq;
}

// ---- polling helper for results_location (handles long jobs) ----
async function pollOutscraper(requestUrl, headers, { maxWaitMs = 120000, intervalMs = 2000 } = {}) {
  const started = Date.now();
  let lastJson = null;

  while (Date.now() - started < maxWaitMs) {
    const r = await fetch(requestUrl, { headers });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    lastJson = json;

    if (hasReviewData(json)) return json;

    const s = String(json?.status || "").toLowerCase();
    if (s === "error" || s === "failed") return json; // don’t loop forever

    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return lastJson;
}

// ====== GOOGLE REVIEWS (ASYNC JOB FLOW) ======

// 1) Start job, return { id, results_location }
app.get("/google-reviews/start", async (req, res) => {
  try {
    const name = required(req.query, "name");
    const location = required(req.query, "location");

    if (!OUTSCRAPER_API_KEY) {
      return res.status(400).json({ error: "OUTSCRAPER_API_KEY missing on server" });
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

    const resp = await fetch(triggerUrl, { headers });
    const text = await resp.text();
    let json = null; try { json = JSON.parse(text); } catch {}

    if (!resp.ok) {
      console.error("Outscraper start error", resp.status, text);
      return res.status(resp.status).json({ error: "start_failed", detail: text.slice(0, 500) });
    }

    const id = json?.id || null;
    const results_location =
      json?.results_location ||
      json?.resultsLocation ||
      (id ? `https://api.outscraper.cloud/requests/${id}` : null);

    if (!results_location) {
      return res.status(202).json({ status: "Pending", id });
    }
    res.status(202).json({ status: "Pending", id, results_location });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "google-reviews/start failed" });
  }
});

// 2) Poll for result by id or results_location; when ready, return normalized array
app.get("/google-reviews/result", async (req, res) => {
  try {
    const id = (req.query.id || "").trim();
    const results_location = (req.query.results_location || "").trim();
    if (!id && !results_location) {
      return res.status(400).json({ error: "Missing id or results_location" });
    }
    if (!OUTSCRAPER_API_KEY) {
      return res.status(400).json({ error: "OUTSCRAPER_API_KEY missing on server" });
    }
    const headers = { "X-API-KEY": OUTSCRAPER_API_KEY };
    const url = results_location || `https://api.outscraper.cloud/requests/${id}`;

    const payload = await pollOutscraper(url, headers);
    if (!payload) return res.status(202).json({ status: "Pending" });

    if (!hasReviewData(payload)) return res.json([]); // success but no data
    const reviews = normalizeReviews(payload);
    res.json(reviews);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "google-reviews/result failed" });
  }
});

// 3) Backward-compatible "sync" route: try brief poll; if not ready, return Pending descriptor
app.get("/google-reviews", async (req, res) => {
  try {
    const name = required(req.query, "name");
    const location = required(req.query, "location");
    const cacheKey = `g:${name}|${location}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    if (!OUTSCRAPER_API_KEY) return res.json([]);

    // try cache first by firing start, then quick poll
    const headers = { "X-API-KEY": OUTSCRAPER_API_KEY };
    const startUrl =
      `https://api.app.outscraper.com/maps/reviews?` +
      qParam({
        query: `${name} ${location}`,
        reviewsLimit: "50",
        reviewsSort: "newest",
        language: "en",
      });

    const startResp = await fetch(startUrl, { headers });
    const startText = await startResp.text();
    let startJson = null; try { startJson = JSON.parse(startText); } catch {}

    if (!startResp.ok) {
      console.error("Outscraper sync start error", startResp.status, startText);
      return res.json([]);
    }

    if (hasReviewData(startJson)) {
      const reviews = normalizeReviews(startJson);
      setCache(cacheKey, reviews);
      return res.json(reviews);
    }

    // brief poll (8s) for synchronous-ish experience
    const resultsUrl =
      startJson?.results_location ||
      startJson?.resultsLocation ||
      (startJson?.id ? `https://api.outscraper.cloud/requests/${startJson.id}` : null);

    if (!resultsUrl) return res.status(202).json({ status: "Pending" });

    const payload = await pollOutscraper(resultsUrl, headers, { maxWaitMs: 8000, intervalMs: 1500 });
    if (hasReviewData(payload)) {
      const reviews = normalizeReviews(payload);
      setCache(cacheKey, reviews);
      return res.json(reviews);
    }

    // not ready yet → tell the client how to poll
    return res.status(202).json({
      status: "Pending",
      id: startJson?.id || null,
      results_location: resultsUrl
    });
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
    console.log("[NOTE] Set OUTSCRAPER_API_KEY to enable /google-reviews.");
  }
});
