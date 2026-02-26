const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;
const UPRN = "100080360324";

let cache = { data: null, timestamp: null };
const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours

async function scrapeCollections() {
  console.log("Fetching RBWM page...");

  // Try fetching with different approaches
  const urls = [
    `https://forms.rbwm.gov.uk/bincollections?uprn=${UPRN}`,
    `https://api.allorigins.win/get?url=${encodeURIComponent(`https://forms.rbwm.gov.uk/bincollections?uprn=${UPRN}`)}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,*/*",
          "Accept-Language": "en-GB,en;q=0.9",
        },
        timeout: 15000,
      });

      let html = await res.text();

      // allorigins wraps response in JSON
      if (url.includes("allorigins")) {
        try {
          const json = JSON.parse(html);
          html = json.contents || html;
        } catch {}
      }

      console.log("Got HTML, length:", html.length);
      console.log("HTML snippet:", html.substring(0, 300));

      const $ = cheerio.load(html);
      const collections = [];

      const months = "January|February|March|April|May|June|July|August|September|October|November|December";
      const dateRegex = new RegExp(`\\d{1,2}\\s+(?:${months})\\s+\\d{4}`, "i");

      // Try tables
      $("tr").each((_, row) => {
        const cells = $(row).find("td, th").map((_, c) => $(c).text().trim()).get();
        const dateCell = cells.find(c => dateRegex.test(c));
        const typeCell = cells.find(c => /general|refuse|recycl|garden|food|waste/i.test(c));
        if (dateCell && typeCell) {
          const d = new Date(dateCell);
          if (!isNaN(d)) {
            collections.push({ date: d.toISOString().split("T")[0], type: normaliseType(typeCell) });
          }
        }
      });

      // Try any element containing a date + bin type
      if (collections.length === 0) {
        $("*").each((_, el) => {
          const text = $(el).text().trim();
          const dateMatch = text.match(dateRegex);
          const typeMatch = text.match(/general waste|refuse|recycling|garden waste|food waste/i);
          if (dateMatch && typeMatch && text.length < 200) {
            const d = new Date(dateMatch[0]);
            if (!isNaN(d)) {
              collections.push({ date: d.toISOString().split("T")[0], type: normaliseType(typeMatch[0]) });
            }
          }
        });
      }

      if (collections.length > 0) {
        const unique = collections
          .filter((c, i, a) => a.findIndex(x => x.date === c.date && x.type === c.type) === i)
          .sort((a, b) => a.date.localeCompare(b.date));
        return { success: true, collections: unique, source: url };
      }

      // Return debug info if nothing found
      return { success: false, htmlLength: html.length, snippet: html.substring(0, 1000) };

    } catch (err) {
      console.error("Error fetching", url, err.message);
    }
  }

  return { success: false, error: "All fetch attempts failed" };
}

function normaliseType(raw) {
  const r = raw.toLowerCase();
  if (r.includes("food")) return "Food Waste";
  if (r.includes("garden")) return "Garden Waste";
  if (r.includes("recycl")) return "Recycling";
  if (r.includes("general") || r.includes("refuse") || r.includes("rubbish")) return "General Waste";
  return raw.trim();
}

app.get("/collections", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Content-Type", "application/json");

  if (cache.data && cache.timestamp && (Date.now() - cache.timestamp) < CACHE_DURATION) {
    return res.json({ ...cache.data, cached: true });
  }

  try {
    const result = await scrapeCollections();
    if (result.success) cache = { data: result, timestamp: Date.now() };
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/", (req, res) => {
  res.json({ status: "Bin Boy is running! 🗑️", endpoint: "/collections" });
});

app.listen(PORT, () => console.log(`Bin Boy running on port ${PORT}`));
