const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const NodeCache = require("node-cache");
const rateLimit = require("express-rate-limit");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== TRUST PROXY (FIX FOR RATE LIMITER WARNING) ====================
app.set('trust proxy', 1); // Trust the first proxy (Render)

// ==================== CONFIGURATION ====================
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min cache

// CORS – allow all origins (customize if needed)
app.use(cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, please try again later." },
});

// List of modern User-Agents to rotate
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];

// Helper to get a random User-Agent
function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// Custom axios client with realistic browser headers – but we'll create a new one per request to rotate UA
// We'll define a function to get a configured client with a specific UA
function createClient(userAgent) {
  return axios.create({
    timeout: 20000,
    maxRedirects: 5,
    headers: {
      "User-Agent": userAgent,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Referer": "https://www.opensubtitles.org/",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Cache-Control": "max-age=0",
    },
    validateStatus: () => true, // never throw on status code
  });
}

// ==================== HELPER FUNCTIONS ====================

/**
 * Create a typed error with extra debug info
 */
function createError(type, message, debug = null) {
  const err = new Error(message);
  err.type = type;
  err.debug = debug;
  return err;
}

/**
 * Serialize response for debug (safe, without sensitive data)
 */
function serializeError(res, url) {
  return {
    status: res?.status,
    statusText: res?.statusText,
    url,
    body: typeof res?.data === "string" ? res.data.slice(0, 500) : null,
  };
}

/**
 * Parse subtitle search results from OpenSubtitles HTML
 */
function parseSearch(html) {
  if (!html || typeof html !== "string") return [];

  const $ = cheerio.load(html);

  // If the search table is missing, structure changed or we got a captcha page
  if ($("#search_results").length === 0) return null;

  const results = [];

  $("#search_results tbody tr").each((_, row) => {
    const $row = $(row);

    // Skip header, hidden, or rows without onclick
    if (
      $row.hasClass("head") ||
      $row.attr("style") === "display:none" ||
      !$row.attr("onclick")
    )
      return;

    // Extract subtitle ID
    const idMatch =
      $row.attr("onclick")?.match(/servOC\((\d+)/) ||
      $row.attr("id")?.match(/name(\d+)/);
    if (!idMatch) return;
    const id = idMatch[1];

    // Title and year
    let title = $row.find("td:first-child strong a").first().text().trim();
    let year = null;
    const yearMatch = title.match(/\((\d{4})\)$/);
    if (yearMatch) {
      year = yearMatch[1];
      title = title.replace(/\s*\(\d{4}\)$/, "").trim();
    }

    if (!title) return;

    // Language from flag
    let language = "unknown";
    const flag = $row.find(".flag").first();
    if (flag.length) {
      const flagClass = flag.attr("class") || "";
      const langMatch = flagClass.match(/flag\s+([a-z]{2})/);
      if (langMatch) language = langMatch[1];
    }

    // Download count
    let downloads = 0;
    const downloadLink = $row.find('a[href*="subtitleserve"]').first();
    if (downloadLink.length) {
      const dlText = downloadLink.text().trim().replace("x", "").replace(/,/g, "");
      downloads = parseInt(dlText) || 0;
    }

    // Uploader
    const uploader = $row.find("td:last-child a").first().text().trim() || "anonymous";

    // Upload date
    const uploadDate = $row.find("time").first().text().trim() || null;

    // Filename (if any)
    const filename = $row.find("span[title]").first().attr("title") || null;

    // Features (HD, hearing impaired, trusted)
    const features = {
      hd: $row.find('img[src*="hd.gif"]').length > 0,
      hearingImpaired: $row.find('img[src*="hearing_impaired.gif"]').length > 0,
      trusted: $row.find('img[src*="from_trusted.gif"]').length > 0,
    };

    results.push({
      id,
      title,
      year,
      language,
      downloads,
      uploader,
      uploadDate,
      filename,
      features,
    });
  });

  return results;
}

// ==================== CORE API FUNCTIONS ====================

/**
 * Search subtitles with caching and anti-blocking measures
 */
async function searchSubtitles(query, page = 1) {
  const cacheKey = `search_${query}_page_${page}`;
  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const url = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${encodeURIComponent(
    query
  )}/${page}`;

  // Try up to 2 times with different User-Agents if we get a 403
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Add a random delay between 2 and 5 seconds to mimic human behavior
    await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 2000));

    const userAgent = getRandomUserAgent();
    const client = createClient(userAgent);

    let res;
    try {
      res = await client.get(url);
    } catch (e) {
      lastError = createError("network_error", `Failed to reach OpenSubtitles: ${e.message}`);
      continue; // try next attempt
    }

    if (res.status !== 200) {
      lastError = createError(
        "search_failed",
        `OpenSubtitles returned status ${res.status}`,
        serializeError(res, url)
      );
      // If status is 403, try again with a different UA
      if (res.status === 403) continue;
      else break; // other errors are not recoverable
    }

    const results = parseSearch(res.data);
    if (results === null) {
      lastError = createError(
        "parse_failed",
        "Could not parse OpenSubtitles response. The site may have changed its structure or returned a captcha.",
        serializeError(res, url)
      );
      continue; // maybe next attempt will work
    }

    // Sort by popularity (most downloads first)
    results.sort((a, b) => b.downloads - a.downloads);

    const data = {
      query,
      page,
      total: results.length,
      fromCache: false,
      results,
    };

    cache.set(cacheKey, data);
    return data;
  }

  // If all attempts failed, throw the last error
  throw lastError || createError("search_failed", "All attempts failed");
}

/**
 * Filter results by language code
 */
function filterByLanguage(searchData, lang) {
  if (!lang || lang === "all") return searchData;

  const filtered = searchData.results.filter(
    (item) => item.language.toLowerCase() === lang.toLowerCase()
  );

  return {
    ...searchData,
    language: lang,
    total: filtered.length,
    results: filtered,
  };
}

/**
 * Download subtitle file by ID (with caching)
 */
async function downloadSubtitle(id) {
  const cacheKey = `download_${id}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const urls = [
    `https://dl.opensubtitles.org/en/download/sub/${id}`,
    `https://www.opensubtitles.org/en/subtitleserve/sub/${id}`,
  ];

  for (const url of urls) {
    // Also add delay and UA rotation for download attempts
    await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));
    const userAgent = getRandomUserAgent();
    const client = createClient(userAgent);

    let res;
    try {
      res = await client.get(url, { responseType: "arraybuffer" });
    } catch {
      continue; // try next URL
    }

    if (res.status !== 200) continue;

    const buffer = Buffer.from(res.data);
    if (buffer.length === 0) continue;

    const head = buffer.slice(0, 300).toString("utf8");
    if (head.includes("<html") || head.includes("<!DOCTYPE") || head.includes("<!doctype"))
      continue;

    // Determine file extension from Content-Disposition
    let ext = "srt";
    const cd = res.headers["content-disposition"];
    if (cd) {
      const match = cd.match(/filename[^;=\n]*=(['"]?)([^\n'"]*)\1/i);
      if (match && match[2]) {
        const parts = match[2].split(".");
        if (parts.length > 1) ext = parts.pop().toLowerCase();
      }
    }

    const result = { buffer, ext, size: buffer.length };
    cache.set(cacheKey, result, 600); // cache for 10 minutes
    return result;
  }

  throw createError("download_failed", "All download sources failed or returned invalid data.");
}

// ==================== INPUT VALIDATION ====================

function validateQuery(q) {
  if (!q || typeof q !== "string") return "Missing search query 'q'";
  const trimmed = q.trim();
  if (trimmed.length === 0) return "Search query cannot be empty";
  if (trimmed.length > 200) return "Search query is too long (max 200 characters)";
  return null;
}

function validatePage(pageStr) {
  const page = parseInt(pageStr) || 1;
  if (page < 1 || page > 100) return null;
  return page;
}

function validateId(id) {
  if (!id || typeof id !== "string") return false;
  return /^\d+$/.test(id.trim());
}

// ==================== ROUTES ====================

// Root – beautiful API documentation (same as before, omitted for brevity, but keep your existing root)
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>...`); // keep your existing HTML
});

// Languages endpoint
app.get("/languages", async (req, res) => {
  const queryErr = validateQuery(req.query.q);
  if (queryErr) return res.status(400).json({ success: false, error: queryErr });

  const q = req.query.q.trim();

  try {
    const data = await searchSubtitles(q);
    const languages = [...new Set(data.results.map((item) => item.language))].sort();

    return res.json({
      success: true,
      query: q,
      fromCache: data.fromCache || false,
      count: languages.length,
      languages,
    });
  } catch (err) {
    console.error("[/languages error]", err.message);
    return res.status(500).json({
      success: false,
      error: err.type || "internal_error",
      message: err.message,
      debug: err.debug || null,
    });
  }
});

// Stats endpoint
app.get("/stats", (req, res) => {
  const stats = cache.getStats();
  const mem = process.memoryUsage();

  const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  const formatUptime = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
  };

  return res.json({
    success: true,
    uptime: Math.floor(process.uptime()),
    uptimeFormatted: formatUptime(process.uptime()),
    memory: {
      rss: formatBytes(mem.rss),
      heapUsed: formatBytes(mem.heapUsed),
      heapTotal: formatBytes(mem.heapTotal),
    },
    cache: {
      keys: cache.keys().length,
      hits: stats.hits,
      misses: stats.misses,
      ksize: formatBytes(stats.ksize),
      vsize: formatBytes(stats.vsize),
    },
    timestamp: new Date().toISOString(),
  });
});

// Main subtitle endpoint (with rate limiting)
app.get("/subtitle", limiter, async (req, res) => {
  const { action } = req.query;

  try {
    // ----- SEARCH -----
    if (action === "search") {
      const queryErr = validateQuery(req.query.q);
      if (queryErr) return res.status(400).json({ success: false, error: queryErr });

      const q = req.query.q.trim();
      const lang = req.query.lang?.trim() || null;
      const page = validatePage(req.query.page);

      if (!page) {
        return res.status(400).json({ success: false, error: "Invalid page number. Must be between 1 and 100." });
      }

      const data = await searchSubtitles(q, page);
      const finalData = lang ? filterByLanguage(data, lang) : data;

      return res.json({ success: true, data: finalData });
    }

    // ----- DOWNLOAD -----
    if (action === "download") {
      const { id } = req.query;

      if (!validateId(id)) {
        return res.status(400).json({ success: false, error: "Missing or invalid subtitle ID. Must be a numeric value." });
      }

      const file = await downloadSubtitle(id.trim());

      res.setHeader("Content-Disposition", `attachment; filename="subtitle_${id}.${file.ext}"`);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", file.size);
      res.setHeader("X-File-Extension", file.ext);

      return res.send(file.buffer);
    }

    // ----- UNKNOWN ACTION -----
    return res.status(400).json({
      success: false,
      error: "Invalid or missing action parameter.",
      usage: {
        search: "/subtitle?action=search&q=inception&lang=en&page=1",
        download: "/subtitle?action=download&id=3962439",
      },
    });
  } catch (err) {
    console.error("[/subtitle error]", err.message, err.type || "");
    return res.status(500).json({
      success: false,
      error: err.type || "internal_error",
      message: err.message || "An unexpected error occurred.",
      debug: err.debug || null,
    });
  }
});

// Health check
app.get("/health", (req, res) => {
  return res.status(200).json({
    status: "healthy",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((req, res) => {
  return res.status(404).json({
    success: false,
    error: "Not found",
    message: "This endpoint does not exist. Visit / for API documentation.",
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("[Unhandled error]", err);
  return res.status(500).json({
    success: false,
    error: "server_error",
    message: "An unexpected server error occurred.",
  });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║     🎬  OPENSUBTITLES PROXY API – PEAK EDITION       ║
╠══════════════════════════════════════════════════════╣
║  ✅  Server running on port ${PORT}                         ║
║  🚀  Anti-block measures: ON (UA rotation + delays)  ║
║  📦  Cache TTL: 300s                                 ║
║  🛡️   Rate limit: 100 req / 15 min per IP            ║
║  🌐  CORS enabled for all origins                     ║
║  ⭐  Made with ❤️ by Munax                            ║
╚══════════════════════════════════════════════════════╝
  `);
});
