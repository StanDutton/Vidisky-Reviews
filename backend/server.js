import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import cheerio from "cheerio";

const app = express();
app.use(cors());
app.use(express.json());

const OUTSCRAPER_API_KEY = process.env.OUTSCRAPER_API_KEY;

// Google Reviews via Outscraper API
app.get("/google-reviews", async (req, res) => {
  try {
    const { name, location } = req.query;
    if (!name || !location) {
      return res.status(400).json({ error: "Missing name or location" });
    }

    const query = `${name}, ${location}`;
    const url = `https://api.app.outscraper.com/maps/reviews-v3?query=${encodeURIComponent(query)}&reviewsLimit=20`;
    const response = await fetch(url, {
      headers: { "X-API-KEY": OUTSCRAPER_API_KEY }
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Error fetching Google reviews:", err);
    res.status(500).json({ error: "Failed to fetch Google reviews" });
  }
});

// Apartments.com scraper
app.get("/apartments-com", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: "Missing URL" });
    }

    const response = await fetch(url);
    const html = await response.text();
    const $ = cheerio.load(html);

    const reviews = [];
    $(".ReviewText__ReviewTextWrapper-sc-1kl4g5o-0").each((_, el) => {
      reviews.push($(el).text().trim());
    });

    res.json({ reviews });
  } catch (err) {
    console.error("Error scraping Apartments.com:", err);
    res.status(500).json({ error: "Failed to scrape Apartments.com" });
  }
});

// ApartmentRatings.com scraper
app.get("/apartmentratings", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: "Missing URL" });
    }

    const response = await fetch(url);
    const html = await response.text();
    const $ = cheerio.load(html);

    const reviews = [];
    $(".Review__ReviewContent-sc-1h4m0o1-4").each((_, el) => {
      reviews.push($(el).text().trim());
    });

    res.json({ reviews });
  } catch (err) {
    console.error("Error scraping ApartmentRatings.com:", err);
    res.status(500).json({ error: "Failed to scrape ApartmentRatings.com" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
