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

// ---- fetch JSON with key, return parsed or null ----
async function fetchJson(url, headers) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return null; }
}

// --- replace the existing fetchResultsUntilData helper with this ---
async function fetchJsonMaybe(url, headers, withHeader) {
  const r = await fetch(url, withHeader ? { headers } : undefined);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return null; }
}

async function fetchResultsUntilData(baseOrId, headers, { maxWaitMs = 180000, intervalMs = 2000 } = {}) {
  const started = Date.now();
  const id = baseOrId.startsWith('http') ? null : baseOrId;
  const baseUrl = baseOrId.startsWith('http') ? baseOrId : `https://api.outscraper.cloud/requests/${id}`;

  // Candidate URLs to try, in order, with & without header
  const candidates = (u) => ([
    u,
    `${u.replace(/\/$/, '')}/results`,
    // try the "app" domain too
    u.replace('api.outscraper.cloud', 'api.app.outscraper.com'),
    `${u.replace(/\/$/, '').replace('api.outscraper.cloud', 'api.app.outscraper.com')}/results`,
  ]);

  let lastJson = null;

  while (Date.now() - started < maxWaitMs) {
    // 1) Try all candidates (with and without header)
    for (const url of candidates(baseUrl)) {
      for (const withHeader of [true, false]) {
        const json = await fetchJsonMaybe(url, headers, withHeader);
        if (json) {
          lastJson = json;
          if (hasReviewData(json)) return json;

          // Follow any links inside the payload
          const linkFields = []
            .concat(json.results_location || [])
            .concat(json.resultsLocation || [])
            .concat(json.result_url || [])
            .concat(json.results_url || [])
            .concat(json.file_url || [])
            .concat(json.download_url || [])
            .concat(Array.isArray(json.links) ? json.links : []);

          for (const lf of linkFields) {
            const link = typeof lf === 'string' ? lf : lf?.url || lf?.href;
            if (!link) continue;
            for (const wh of [true, false]) {
              const j2 = await fetchJsonMaybe(link, headers, wh);
              if (j2) {
                lastJson = j2;
                if (hasReviewData(j2)) return j2;
                if (Array.isArray(j2) && j2.length) return j2; // some links return the array directly
              }
            }
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return lastJson;
}


// --- replace ONLY the /google-reviews/result route with this robust version ---
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
    const handle = results_location || id;

    const payload = await fetchResultsUntilData(handle, headers);
    if (!payload) return res.status(202).json({ status: "Pending" });

    if (!hasReviewData(payload)) return res.json([]); // success but no data
    const reviews = normalizeReviews(payload);
    res.json(reviews);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "google-reviews/result failed" });
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
    const base = results_location || `https://api.outscraper.cloud/requests/${id}`;

    const payload = await fetchResultsUntilData(base, headers);
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

    const resultsUrl =
      startJson?.results_location ||
      startJson?.resultsLocation ||
      (startJson?.id ? `https://api.outscraper.cloud/requests/${startJson.id}` : null);

    if (!resultsUrl) return res.status(202).json({ status: "Pending" });

    const payload = await fetchResultsUntilData(resultsUrl, headers, { maxWaitMs: 8000, intervalMs: 1500 });
    if (hasReviewData(payload)) {
      const reviews = normalizeReviews(payload);
      setCache(cacheKey, reviews);
      return res.json(reviews);
    }

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

// Show what the results URL(s) are returning right now
app.get("/debug-google-result", async (req, res) => {
  try {
    const id = (req.query.id || "").trim();
    const url = (req.query.url || "").trim();
    if (!id && !url) {
      return res.status(400).json({ error: "Provide ?id=... or ?url=..." });
    }
    if (!OUTSCRAPER_API_KEY) {
      return res.status(400).json({ error: "OUTSCRAPER_API_KEY missing on server" });
    }
    const headers = { "X-API-KEY": OUTSCRAPER_API_KEY };
    const base = url || `https://api.outscraper.cloud/requests/${id}`;

    const tryUrls = [
      base,
      `${base.replace(/\/$/, "")}/results`
    ];

    const results = [];
    for (const u of tryUrls) {
      const r = await fetch(u, { headers });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      results.push({
        url: u,
        status: r.status,
        hasData: hasReviewData(json),
        preview: text.slice(0, 1200),
        keys: json && !Array.isArray(json) ? Object.keys(json) : undefined,
        isArray: Array.isArray(json),
        length: Array.isArray(json) ? json.length : undefined
      });
    }
    res.json({ tried: results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "debug-google-result failed", message: e.message });
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
