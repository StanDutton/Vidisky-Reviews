// server.js – VIDISKY proxy (Outscraper + ApartmentRatings + Apartments.com)
// Node: ESM, compatible with Node 22

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { load } from "cheerio"; // ← correct ESM import

const app = express();
// In prod, lock this down: app.use(cors({ origin: "https://YOUR-FRONTEND.example" }));
app.use(cors());
app.use(express.json());

// ----- config / helpers -----
const OUTSCRAPER_API_KEY =
  process.env.OUTSCRAPER_API_KEY || process.env.OUTSCRAPER_KEY;

const cache = new Map();
const TTL_MS = 1000 * 60 * 60 * 6; // 6h cache for cost control

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

    const url = `https://api.app.outscraper.com/maps/reviews?${qParam({
      query: `${name} ${location}`,
      reviewsLimit: "50", // adjust if you want more/less
      reviewsSort: "newest",
      language: "en",
    })}`;

    const resp = await fetch(url, { headers: { "X-API-KEY": OUTSCRAPER_API_KEY } });
    if (!resp.ok) {
      const t = await resp.text();
      console.error("Outscraper error", resp.status, t);
      return res.json([]);
    }
    const raw = await resp.json();

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
      const url =
        rv.review_link || rv.url || rv.review_url || placeUrl || "";
      out.push({ text: t, url });
    };

    // Normalize various shapes Outscraper may return
    const blocks = [];
    if (Array.isArray(raw)) blocks.push(...raw);
    if (raw?.data) blocks.push(...raw.data);
    if (raw?.results) blocks.push(...raw.results);
    if (!blocks.length && (raw?.reviews_data || raw?.reviews)) blocks.push(raw);

    for (const block of blocks) {
      const placeUrl = block?.url || block?.place_link || "";
      let reviews =
        block?.reviews ||
        block?.reviews_data ||
        block?.reviewsData ||
        block?.data ||
        [];

      // Some payloads nest reviews inside "items"
      if (!Array.isArray(reviews) && Array.isArray(block?.items)) {
        reviews = block.items.flatMap(
          (it) => it?.reviews_data || it?.reviews || []
        );
      }

      if (Array.isArray(reviews)) {
        reviews.forEach((rv) => push(rv, placeUrl));
      }
    }

    // Deduplicate by review text
    const seen = new Set();
    const unique = [];
    for (const r of out) {
      const k = r.text.toLowerCase();
      if (k && !seen.has(k)) {
        seen.add(k);
        unique.push(r);
      }
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
    const searchUrl = `https://www.apartmentratings.com/search/?q=${encodeURIComponent(
      query
    )}`;
    const sr = await fetch(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!sr.ok) return res.json([]);
    let $ = load(await sr.text());

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
    $ = load(await pr.text());

    const out = [];
    // NOTE: AR often renders via JS; selectors may return few/none.
    $(".review__content, .review__text, .review-body").each((_, el) => {
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
    const searchUrl = `https://www.apartments.com/search/?q=${encodeURIComponent(
      query
    )}`;
    const sr = await fetch(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!sr.ok) return res.json([]);
    let $ = load(await sr.text());

    const firstLink = $(
      'a.placardTitle, a.property-link, a[data-tid="listing-card-title"]'
    )
      .first()
      .attr("href");
    if (!firstLink) return res.json([]);
    const propertyUrl = firstLink.startsWith("http")
      ? firstLink
      : `https://www.apartments.com${firstLink}`;

    const pr = await fetch(propertyUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
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
// Start server
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
  if (!OUTSCRAPER_API_KEY) {
    console.log(
      "[NOTE] Set OUTSCRAPER_API_KEY to enable /google-reviews (otherwise it returns [])."
    );
  }
});
