const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;
const UPRN = "100080360324";
const URL = `https://forms.rbwm.gov.uk/bincollections?uprn=${UPRN}`;

// Cache results so we don't hammer the RBWM site
let cache = { data: null, timestamp: null };
const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours

async function scrapeCollections() {
  console.log("Launching browser...");
  const browser = await puppeteer.launch({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
    headless: "new",
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    console.log("Navigating to RBWM page...");
    await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for JS to render the bin data
    await new Promise(r => setTimeout(r, 4000));

    // Get all visible text
    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log("Page text snippet:", bodyText.substring(0, 500));

    // Try to extract table rows
    const tableRows = await page.evaluate(() => {
      const rows = [];
      document.querySelectorAll("tr").forEach(row => {
        const cells = Array.from(row.querySelectorAll("td, th"))
          .map(c => c.innerText.trim())
          .filter(c => c.length > 0);
        if (cells.length >= 2) rows.push(cells);
      });
      return rows;
    });

    // Try to extract list items
    const listItems = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("li, p, div"))
        .map(el => el.innerText.trim())
        .filter(t => /\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/i.test(t));
    });

    console.log("Table rows found:", tableRows.length);
    console.log("List items with dates:", listItems.length);

    const collections = [];
    const months = "January|February|March|April|May|June|July|August|September|October|November|December";
    const dateRegex = new RegExp(`\\d{1,2}\\s+(?:${months})\\s+\\d{4}`, "i");

    // Parse from table rows
    for (const cells of tableRows) {
      const dateCell = cells.find(c => dateRegex.test(c));
      const typeCell = cells.find(c => /general|refuse|recycl|garden|food|waste/i.test(c));
      if (dateCell && typeCell) {
        const d = new Date(dateCell);
        if (!isNaN(d)) {
          collections.push({
            date: d.toISOString().split("T")[0],
            type: normaliseType(typeCell),
          });
        }
      }
    }

    // Parse from list items if table gave nothing
    if (collections.length === 0) {
      for (const item of listItems) {
        const dateMatch = item.match(dateRegex);
        const typeMatch = item.match(/general waste|refuse|recycling|garden waste|food waste/i);
        if (dateMatch && typeMatch) {
          const d = new Date(dateMatch[0]);
          if (!isNaN(d)) {
            collections.push({
              date: d.toISOString().split("T")[0],
              type: normaliseType(typeMatch[0]),
            });
          }
        }
      }
    }

    // If still nothing, return the raw text for debugging
    if (collections.length === 0) {
      return { success: false, debug: bodyText.substring(0, 2000), tableRows, listItems };
    }

    return {
      success: true,
      collections: collections
        .filter((c, i, a) => a.findIndex(x => x.date === c.date && x.type === c.type) === i)
        .sort((a, b) => a.date.localeCompare(b.date)),
    };

  } finally {
    await browser.close();
  }
}

function normaliseType(raw) {
  const r = raw.toLowerCase();
  if (r.includes("food")) return "Food Waste";
  if (r.includes("garden")) return "Garden Waste";
  if (r.includes("recycl")) return "Recycling";
  if (r.includes("general") || r.includes("refuse") || r.includes("rubbish")) return "General Waste";
  return raw.trim();
}

// Main API endpoint
app.get("/collections", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Content-Type", "application/json");

  // Return cached data if fresh
  if (cache.data && cache.timestamp && (Date.now() - cache.timestamp) < CACHE_DURATION) {
    console.log("Returning cached data");
    return res.json({ ...cache.data, cached: true });
  }

  try {
    const result = await scrapeCollections();
    if (result.success) {
      cache = { data: result, timestamp: Date.now() };
    }
    res.json(result);
  } catch (err) {
    console.error("Scrape error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Bin Boy is running! 🗑️", endpoint: "/collections" });
});

app.listen(PORT, () => {
  console.log(`Bin Boy server running on port ${PORT}`);
});
