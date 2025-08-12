// backend/scrapers/googleScraper.js
import { chromium, devices } from "playwright";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function scrapeGoogleReviews({ name, location, maxReviews = 80, timeoutMs = 90000 }) {
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
    geolocation: { latitude: 27.4989, longitude: -82.5748 }, // near Bradenton; doesn’t really matter
    permissions: ["geolocation"],
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
  });

  const page = await context.newPage();
  const q = `${name} ${location}`.trim();
  const mapsSearch = `https://www.google.com/maps/search/${encodeURIComponent(q)}`;
  const out = [];

  try {
    // 1) open search
    await page.goto(mapsSearch, { waitUntil: "domcontentloaded", timeout: 45000 });

    // 2) Click first result in left panel
    // Left panel result selectors change; handle two common variants
    const firstCard = page.locator('a[data-result-id]:has(h3), a.hfpxzc'); // robust-ish
    await firstCard.first().click({ timeout: 20000 });

    // 3) Wait for the place panel to load
    await page.waitForSelector('button[aria-label*="reviews"], button[jsaction*="pane.reviewChart"]', { timeout: 20000 });

    // 4) Click "All reviews"
    const allReviewsBtn = page.locator('button[aria-label*="reviews"], button[jsaction*="pane.reviewChart"]');
    await allReviewsBtn.first().click({ timeout: 15000 });

    // 5) Try to switch sort to "Newest" (if available)
    // Sort menu button (three-lines icon) or dropdown
    const sortButton = page.locator('button[aria-label*="Sort"], div[role="button"][aria-label*="Sort"]');
    if (await sortButton.first().isVisible().catch(()=>false)) {
      await sortButton.first().click({ timeout: 8000 }).catch(()=>{});
      // Click "Newest"
      const newest = page.locator('div[role="menuitem"]:has-text("Newest")');
      if (await newest.first().isVisible().catch(()=>false)) {
        await newest.first().click({ timeout: 8000 }).catch(()=>{});
      }
    }

    // 6) Scroll the reviews container to load more
    const scroller = page.locator('div[aria-label*="Google reviews"], div[aria-label="Reviews"], div[role="region"]');
    await scroller.first().waitFor({ timeout: 10000 });

    let loaded = 0, stagnation = 0, lastCount = 0;
    while (loaded < maxReviews && Date.now() - start < timeoutMs) {
      // pull current reviews
      const reviewCards = page.locator('div[data-review-id], div[jscontroller][data-review-id]');
      const count = await reviewCards.count().catch(()=>0);

      if (count > lastCount) {
        lastCount = count;
        stagnation = 0;
      } else {
        stagnation += 1;
      }

      // Try to extract texts from the currently loaded set
      const items = await reviewCards.evaluateAll(cards => {
        const arr = [];
        for (const el of cards) {
          // long text often in span[jsname="fbQN7e"] or "bN97Pc"
          const long = el.querySelector('span[jsname="fbQN7e"], span[class*="review-full-text"]');
          const short = el.querySelector('span[jsname="bN97Pc"], span[class*="review-snippet"]');
          const text = (long?.textContent || short?.textContent || "").trim();
          if (text && text.length > 5) arr.push({ text });
        }
        return arr;
      });

      // append uniques
      for (const it of items) {
        const k = it.text.toLowerCase();
        if (!out.some(x => x.text.toLowerCase() === k)) out.push(it);
      }
      loaded = out.length;

      if (loaded >= maxReviews) break;
      if (stagnation >= 6) break; // stop if not loading more

      // Scroll to bottom of reviews panel
      await scroller.evaluate(el => { el.scrollBy(0, el.scrollHeight); });
      await sleep(900);
    }

    // Create a shareable place URL (if available)
    let placeUrl = "";
    try {
      const shareBtn = page.locator('button[aria-label*="Share"]');
      if (await shareBtn.first().isVisible({ timeout: 2000 }).catch(()=>false)) {
        await shareBtn.first().click().catch(()=>{});
        const input = page.locator('input[aria-label="Link to share"]');
        if (await input.first().isVisible().catch(()=>false)) {
          placeUrl = await input.first().inputValue().catch(()=> "");
          // close dialog
          await page.keyboard.press("Escape").catch(()=>{});
        }
      }
    } catch {}

    // attach url & trim to maxReviews
    const result = out.slice(0, maxReviews).map(r => ({ text: r.text, url: placeUrl || "" }));
    return result;
  } finally {
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
}
