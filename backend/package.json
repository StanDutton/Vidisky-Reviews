// server.js – Node/Express proxy for VIDISKY Review Summarizer (Outscraper + Apartments.com + ApartmentRatings)
//
// Endpoints:
//   GET /google-reviews?name=...&location=...
//   GET /apartments-com?name=...&location=...
//   GET /apartmentratings?name=...&location=...
//
// Env vars:
//   OUTSCRAPER_API_KEY  -> from https://app.outscraper.com
//   PORT                -> optional (default 3001)

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import cheerio from "cheerio";

const app = express();
// In production, lock this to your frontend origin: app.use(cors({ origin: "https://YOUR-FRONTEND" }));
app.use(cors());

const OUTSCRAPER_API_KEY =
  process.env.OUTSCRAPER_API_KEY || process.env.OUTSCRAPER_KEY;
if (!OUTSCRAPER_API_KEY)
  console.warn(
    "[WARN] OUTSCRAPER_API_KEY not set. /google-reviews will return []."
  );

// --- tiny in-memory cache to limit paid calls ---
const cache = new Map();
const TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

function getCache(key) {
  const x = cache.get(key);
  if (!x) return null;
  if (Date.now() - x.ts > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return x.v;
}
function setCache(key, v) {
  cache.set(key, { ts: Date.now(), v });
}
function qParam(obj) {
  return new URLSearchParams(obj).toString();
}
function required(q, name) {
  const v = (q[name] || "").toString().trim();
  if (!v) {
    const e = new Error(`Missing required query param: ${name}`);
    e.statusCode = 400;
    throw e;
  }
  return v;
}

// -----------------------------------------------------------------------------
// Google reviews via Outscraper
// -----------------------------------------------------------------------------
app.get("/google-reviews", async (req, res) => {
  try {
    const name = required(req.query, "name");
    const location = required(req.query, "location");
    const cacheKey = `g:${name}|${location}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    if (!OUTSCRAPER_API_KEY) return res.json([]);

    const url = `https://api.app.outscraper.com/maps/reviews?${qParam({
      query: `${name} ${location}`,
      reviewsLimit: "100", // adjust down for lower cost
      reviewsSort: "newest",
      language: "en",
    })}`;

    const resp = await fetch(url, {
      headers: { "X-API-KEY": OUTSCRAPER_API_KEY },
    });
    if (!resp.ok) {
      const t = await resp.text();
      console.error("Outscraper error", resp.status, t);
      return res.json([]);
    }
    const json = await resp.json();

    const reviews = [];
    const pushItem = (rv, placeUrl) => {
      const text = (rv.text || rv.review_text || rv.snippet || "")
        .toString()
        .trim();
      if (!text) return;
      const url = rv.review_link || rv.url || placeUrl || "";
      reviews.push({ text, url });
    };

    const arr = Array.isArray(json) ? json : [];
    for (const block of arr) {
      const items = block?.reviews || block?.data || block || [];
      const placeUrl = block?.url || block?.place_link || "";
      if (Array.isArray(items)) items.forEach((rv) => pushItem(rv, placeUrl));
    }

    // dedupe by text
    const seen = new Set();
    const unique = [];
    for (const r of reviews) {
      const k = r.text.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        unique.push(r);
      }
    }

    setCache(cacheKey, unique);
    res.json(unique);
  } catch (e) {
    console.error(e);
    res
      .status(e.statusCode || 500)
      .json({ error: "google-reviews failed" });
  }
});

// -----------------------------------------------------------------------------
// Apartments.com (best-effort HTML parse)
// -----------------------------------------------------------------------------
app.get("/apartments-com", async (req, res) => {
  try {
    const name = required(req.query, "name");
    const location = required(req.query, "location");
    const cacheKey = `ac:${name}|${location}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    // Search
    const query = `${name} ${location}`;
    const searchUrl = `https://www.apartments.com/search/?q=${encodeURIComponent(
      query
    )}`;
    const sr = await fetch(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!sr.ok) return res.json([]);
    let $ = cheerio.load(await sr.text());

    // Find listing URL
    const firstLink = $(
      'a.placardTitle, a.property-link, a[data-tid="listing-card-title"]'
    )
      .first()
      .attr("href");
    if (!firstLink) return res.json([]);
    const propertyUrl = firstLink.startsWith("http")
      ? firstLink
      : `https://www.apartments.com${firstLink}`;

    // Fetch listing page
    const pr = await fetch(propertyUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!pr.ok) return res.json([]);
    $ = cheerio.load(await pr.text());

    // Extract review text nodes (selectors may need tuning over time)
    const out = [];
    const selectors = [
      'section:contains("Reviews") p',
      "#reviews p",
      ".review, .reviewText, .review__content, .review__text",
    ];
    $(selectors.join(",")).each((i, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 30) out.push({ text, url: propertyUrl });
    });

    setCache(cacheKey, out);
    res.json(out);
  } catch (e) {
    console.error(e);
    res
      .status(e.statusCode || 500)
      .json({ error: "apartments-com failed" });
  }
});

// -----------------------------------------------------------------------------
// ApartmentRatings.com (best-effort HTML parse)
// -----------------------------------------------------------------------------
app.get("/apartmentratings", async (req, res) => {
  try {
    const name = required(req.query, "name");
    const location = required(req.query, "location");
    const cacheKey = `ar:${name}|${location}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const query = `${name} ${location}`;
    const searchUrl = `https://www.apartmentratings.com/search/?q=${encodeURIComponent(
      query
    )}`;
    const sr = await fetch(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!sr.ok) return res.json([]);
    let $ = cheerio.load(await sr.text());

    const firstLink = $('a.property-title, a[href*="/apartment/"]')
      .first()
      .attr("href");
    if (!firstLink) return res.json([]);
    const propertyUrl = firstLink.startsWith("http")
      ? firstLink
      : `https://www.apartmentratings.com${firstLink}`;

    const pr = await fetch(propertyUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!pr.ok) return res.json([]);
    $ = cheerio.load(await pr.text());

    const out = [];
    $(".review__content, .review__text, .review-body").each((i, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 30) out.push({ text, url: propertyUrl });
    });

    setCache(cacheKey, out);
    res.json(out);
  } catch (e) {
    console.error(e);
    res
      .status(e.statusCode || 500)
      .json({ error: "apartmentratings failed" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`Proxy server running on port ${PORT}`)
);
