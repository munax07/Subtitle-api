const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const NodeCache = require("node-cache");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== PLATFORM DETECTION ====================
const IS_RENDER = process.env.RENDER === "true" || !!process.env.RENDER_EXTERNAL_URL;
const BASE_URL = IS_RENDER
  ? process.env.RENDER_EXTERNAL_URL
  : `http://localhost:${PORT}`;
const NODE_ENV = process.env.NODE_ENV || "development";

// Trust proxy (Render uses one proxy)
app.set("trust proxy", 1);

// ==================== CONFIGURATION ====================
const CACHE_TTL_SEARCH = parseInt(process.env.CACHE_TTL_SEARCH) || 300;      // seconds
const CACHE_TTL_DOWNLOAD_META = parseInt(process.env.CACHE_TTL_DOWNLOAD_META) || 600;
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;            // 15 minutes
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 100;
const REQUEST_TIMEOUT = 20000;                        // 20 seconds
const MAX_REDIRECTS = 5;
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 3000;
const SEARCH_RETRIES = 2;

// Memory threshold (Render free tier: 512 MB)
const MEMORY_LIMIT = 512 * 1024 * 1024; // 512 MB

// ==================== CACHES ====================
const searchCache = new NodeCache({ stdTTL: CACHE_TTL_SEARCH, checkperiod: 60 });
// Only lightweight metadata (filename, extension) is cached – never subtitle buffers
const downloadMetaCache = new NodeCache({ stdTTL: CACHE_TTL_DOWNLOAD_META, checkperiod: 120 });

// ==================== MIDDLEWARE ====================
app.use(cors()); // Allow all origins (customise if needed)

const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, please try again later." },
});

// ==================== USER AGENT ROTATION ====================
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
];

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// ==================== HTTP CLIENT FACTORY ====================
function createClient(userAgent = null) {
  return axios.create({
    timeout: REQUEST_TIMEOUT,
    maxRedirects: MAX_REDIRECTS,
    headers: {
      "User-Agent": userAgent || getRandomUserAgent(),
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
    validateStatus: () => true, // We handle status codes manually
  });
}

// ==================== HELPER FUNCTIONS ====================
/**
 * Create a standardised error object.
 * Debug info is only attached in non‑production environments.
 */
function createError(type, message, debug = null) {
  const err = new Error(message);
  err.type = type;
  if (NODE_ENV !== "production" && debug) {
    err.debug = debug;
  }
  return err;
}

/**
 * Serialise a failed response for debugging (safe, limited size).
 */
function serializeError(res, url) {
  if (!res) return null;
  return {
    status: res.status,
    statusText: res.statusText,
    url,
    body: typeof res.data === "string" ? res.data.slice(0, 500) : null,
  };
}

/**
 * Wait a random amount of time between min and max milliseconds.
 */
function randomDelay(min = MIN_DELAY_MS, max = MAX_DELAY_MS) {
  return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1) + min)));
}

/**
 * Parse search results HTML into a structured array.
 * Returns null if the page doesn't look like a search results page.
 */
function parseSearch(html) {
  if (!html || typeof html !== "string") return [];
  const $ = cheerio.load(html);
  if ($("#search_results").length === 0) return null; // Not a search results page

  const results = [];
  $("#search_results tbody tr").each((_, row) => {
    const $row = $(row);
    // Skip header rows, hidden rows, or rows without onclick (likely ads)
    if ($row.hasClass("head") || $row.attr("style") === "display:none" || !$row.attr("onclick")) return;

    // Extract subtitle ID from onclick or id attribute
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

    // Language from flag class
    let language = "unknown";
    const flag = $row.find(".flag").first();
    if (flag.length) {
      const langMatch = (flag.attr("class") || "").match(/flag\s+([a-z]{2})/);
      if (langMatch) language = langMatch[1];
    }

    // Download count – extract all digits
    let downloads = 0;
    const downloadLink = $row.find('a[href*="subtitleserve"]').first();
    if (downloadLink.length) {
      const dlText = downloadLink.text().trim();
      const digits = dlText.replace(/[^\d]/g, "");
      downloads = parseInt(digits, 10) || 0;
    }

    // Uploader and date
    const uploader = $row.find("td:last-child a").first().text().trim() || "anonymous";
    const uploadDate = $row.find("time").first().text().trim() || null;

    // Filename (if available)
    let filename = null;
    const span = $row.find("span[title]").first();
    if (span.length) {
      const possibleFilename = span.attr("title");
      if (possibleFilename && !possibleFilename.match(/^\d+\s+votes?$/i)) filename = possibleFilename;
    }

    // Features
    const features = {
      hd: $row.find('img[src*="hd.gif"]').length > 0,
      hearingImpaired: $row.find('img[src*="hearing_impaired.gif"]').length > 0,
      trusted: $row.find('img[src*="from_trusted.gif"]').length > 0,
    };

    results.push({ id, title, year, language, downloads, uploader, uploadDate, filename, features });
  });

  return results;
}

// ==================== CORE FUNCTIONS ====================
/**
 * Search for subtitles by movie name (query) with pagination.
 * Implements retries, random delays, and user‑agent rotation.
 */
async function searchSubtitles(query, page = 1) {
  const cacheKey = `search_${query}_page_${page}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const url = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${encodeURIComponent(query)}/${page}`;

  let lastError = null;
  for (let attempt = 0; attempt < SEARCH_RETRIES; attempt++) {
    await randomDelay(); // Polite delay

    const client = createClient(getRandomUserAgent());
    let res;
    try {
      res = await client.get(url);
    } catch (err) {
      console.error(`[search] Network error attempt ${attempt + 1}:`, err.message);
      lastError = createError("network_error", `Failed to reach OpenSubtitles: ${err.message}`);
      continue;
    }

    if (res.status !== 200) {
      console.error(`[search] Status ${res.status} attempt ${attempt + 1}`);
      lastError = createError("search_failed", `OpenSubtitles returned status ${res.status}`, serializeError(res, url));
      // On 403 (forbidden) we might retry; otherwise break early
      if (res.status === 403) continue;
      else break;
    }

    const results = parseSearch(res.data);
    if (results === null) {
      console.error(`[search] Parse failed attempt ${attempt + 1}`);
      lastError = createError("parse_failed", "Could not parse OpenSubtitles response.", serializeError(res, url));
      continue;
    }

    // Sort by downloads descending (most popular first)
    results.sort((a, b) => b.downloads - a.downloads);
    const data = { query, page, total: results.length, fromCache: false, results };
    searchCache.set(cacheKey, data);
    return data;
  }

  throw lastError || createError("search_failed", "All attempts failed");
}

/**
 * Filter search results by language (ISO 639-1 code, e.g. 'en').
 * Returns a new object with filtered results.
 */
function filterByLanguage(searchData, lang) {
  if (!lang || lang === "all") return searchData;
  const filtered = searchData.results.filter(
    (item) => item.language.toLowerCase() === lang.toLowerCase()
  );
  return { ...searchData, language: lang, total: filtered.length, results: filtered };
}

/**
 * Download a subtitle file by its ID.
 * Tries multiple download endpoints, validates that we didn't receive HTML,
 * and returns the buffer, file extension, and a safe filename.
 *
 * Important: The subtitle buffer is NOT cached to avoid memory bloat.
 * Only metadata (filename, extension) is cached for quick header generation.
 */
async function downloadSubtitle(id, requestedFilename = null) {
  const urls = [
    `https://dl.opensubtitles.org/en/download/sub/${id}`,
    `https://www.opensubtitles.org/en/subtitleserve/sub/${id}`,
  ];

  for (const url of urls) {
    await randomDelay(1000, 2000);

    const client = createClient(getRandomUserAgent());
    let res;
    try {
      // Important: responseType 'arraybuffer' to get raw binary
      res = await client.get(url, { responseType: "arraybuffer" });
    } catch (err) {
      console.error(`[download] Failed to fetch ${url}:`, err.message);
      continue;
    }

    if (res.status !== 200) {
      console.error(`[download] Status ${res.status} from ${url}`);
      continue;
    }

    const buffer = Buffer.from(res.data);
    if (buffer.length === 0) {
      console.error(`[download] Empty buffer from ${url}`);
      continue;
    }

    // Robust check for HTML error pages (case‑insensitive, partial match)
    const head = buffer.subarray(0, 500).toString("utf8").toLowerCase();
    const isHtml = /<(html|!doctype|body|head)/i.test(head);
    if (isHtml) {
      console.error(`[download] Received HTML instead of subtitle from ${url}`);
      continue;
    }

    // Determine file extension and final filename
    let ext = "srt";
    let finalFilename = null;

    if (requestedFilename) {
      // Sanitise filename to prevent path traversal
      finalFilename = path.basename(requestedFilename).replace(/[^a-zA-Z0-9.\-_\s]/g, "");
      const parts = finalFilename.split(".");
      if (parts.length > 1) ext = parts.pop().toLowerCase();
    } else {
      // Try to extract from Content-Disposition header
      const cd = res.headers["content-disposition"];
      if (cd) {
        const match = cd.match(/filename[^;=\n]*=(['"]?)([^\n'"]*)\1/i);
        if (match && match[2]) {
          finalFilename = path.basename(match[2]).replace(/[^a-zA-Z0-9.\-_\s]/g, "");
          const parts = finalFilename.split(".");
          if (parts.length > 1) ext = parts.pop().toLowerCase();
        }
      }
    }

    if (!finalFilename) finalFilename = `subtitle_${id}.${ext}`;

    // Cache only metadata, not the buffer
    downloadMetaCache.set(`meta_${id}`, { ext, filename: finalFilename });

    return { buffer, ext, filename: finalFilename, size: buffer.length };
  }

  throw createError("download_failed", "All download sources failed.");
}

// ==================== VALIDATION ====================
function validateQuery(q) {
  if (!q || typeof q !== "string") return "Missing search query 'q'";
  const trimmed = q.trim();
  if (trimmed.length === 0) return "Search query cannot be empty";
  if (trimmed.length > 200) return "Search query is too long (max 200 characters)";
  return null;
}

function validatePage(pageStr) {
  if (pageStr === undefined || pageStr === null) return 1; // default
  const page = parseInt(pageStr, 10);
  if (isNaN(page) || page < 1 || page > 100) return null; // invalid
  return page;
}

function validateId(id) {
  if (!id || typeof id !== "string") return false;
  return /^\d+$/.test(id.trim());
}

// ==================== PLATFORM-SPECIFIC HANDLING (RENDER) ====================
if (IS_RENDER) {
  console.log("🚀 Running on Render - self-wake active (prevents sleeping)");
  // Self-ping every 10 minutes to keep the free tier awake
  setInterval(() => {
    axios.get(`${BASE_URL}/health`, { timeout: 5000 })
      .then(res => console.log(`Self-ping ${new Date().toISOString()} – status: ${res.status}`))
      .catch(err => console.log(`Self-ping failed: ${err.message}`));
  }, 10 * 60 * 1000);
} else {
  console.log("Running in local/development mode");
}

// Memory monitoring (clears caches when usage >80% of limit)
setInterval(() => {
  const mem = process.memoryUsage();
  if (mem.heapUsed > MEMORY_LIMIT * 0.8) {
    console.warn("⚠️ High memory usage, clearing caches");
    searchCache.flushAll();
    downloadMetaCache.flushAll();
    if (global.gc) {
      console.log("🧹 Running garbage collection");
      global.gc();
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// ==================== ROUTES ====================

// Root – serves a custom HTML page if exists, otherwise JSON
app.get("/", (req, res) => {
  const htmlPath = path.join(__dirname, "root-page.html");
  if (fs.existsSync(htmlPath)) {
    res.setHeader("Content-Type", "text/html");
    return res.send(fs.readFileSync(htmlPath, "utf8"));
  }
  res.json({
    success: true,
    name: "OpenSubtitles Proxy API – Peak Edition v2",
    endpoints: [
      "GET /subtitle?action=search&q=<query>&lang=<lang>&page=<page>",
      "GET /subtitle?action=download&id=<id>&filename=<optional>",
      "GET /languages?q=<query>",
      "GET /stats",
      "GET /health",
    ],
  });
});

// Languages endpoint – returns all languages found for a query
app.get("/languages", limiter, async (req, res) => {
  const queryErr = validateQuery(req.query.q);
  if (queryErr) return res.status(400).json({ success: false, error: queryErr });

  try {
    const data = await searchSubtitles(req.query.q.trim());
    const languages = [...new Set(data.results.map((i) => i.language))].sort();
    res.json({ success: true, query: req.query.q, fromCache: data.fromCache, count: languages.length, languages });
  } catch (err) {
    console.error("[/languages error]", err.message);
    res.status(500).json({ success: false, error: err.type, message: err.message, debug: err.debug });
  }
});

// Statistics – shows cache stats and memory usage
app.get("/stats", (req, res) => {
  const searchStats = searchCache.getStats();
  const metaStats = downloadMetaCache.getStats();
  const mem = process.memoryUsage();
  const fmt = (b) => (b ? `${(b / 1024 / 1024).toFixed(2)} MB` : "0 B");

  res.json({
    success: true,
    uptime: Math.floor(process.uptime()),
    uptimeFormatted: new Date(process.uptime() * 1000).toISOString().substr(11, 8),
    memory: {
      rss: fmt(mem.rss),
      heapUsed: fmt(mem.heapUsed),
      heapTotal: fmt(mem.heapTotal),
    },
    cache: {
      search: {
        keys: searchCache.keys().length,
        hits: searchStats.hits,
        misses: searchStats.misses,
        ksize: fmt(searchStats.ksize),
        vsize: fmt(searchStats.vsize),
      },
      downloadMeta: {
        keys: downloadMetaCache.keys().length,
        hits: metaStats.hits,
        misses: metaStats.misses,
      },
    },
    timestamp: new Date().toISOString(),
  });
});

// Main endpoint: search or download
app.get("/subtitle", limiter, async (req, res) => {
  const { action } = req.query;

  try {
    if (action === "search") {
      const qErr = validateQuery(req.query.q);
      if (qErr) return res.status(400).json({ success: false, error: qErr });

      const page = validatePage(req.query.page);
      if (req.query.page && page === null) {
        return res.status(400).json({ success: false, error: "Page must be between 1 and 100" });
      }

      const data = await searchSubtitles(req.query.q.trim(), page || 1);
      const final = req.query.lang ? filterByLanguage(data, req.query.lang) : data;
      return res.json({ success: true, data: final });
    }

    if (action === "download") {
      const { id, filename } = req.query;
      if (!validateId(id)) return res.status(400).json({ success: false, error: "Invalid subtitle ID" });

      const file = await downloadSubtitle(id.trim(), filename);
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      res.setHeader("Content-Type", file.ext === "srt" ? "application/x-subrip" : "application/octet-stream");
      res.setHeader("Content-Length", file.size);
      res.setHeader("X-File-Extension", file.ext);
      return res.send(file.buffer);
    }

    return res.status(400).json({ success: false, error: "Invalid action. Use 'search' or 'download'." });
  } catch (err) {
    console.error("[/subtitle error]", err.message);
    res.status(500).json({ success: false, error: err.type || "internal", message: err.message, debug: err.debug });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ 
    status: "healthy", 
    uptime: process.uptime(), 
    timestamp: new Date().toISOString(),
    platform: IS_RENDER ? "render" : "other"
  });
});

// Favicon (prevents 404 errors)
app.get("/favicon.ico", (req, res) => res.status(204).end());

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("[Unhandled]", err);
  res.status(500).json({ success: false, error: "server_error" });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`
+==============================================+
|   OPENSUBTITLES PROXY API - PEAK EDITION    |
|                 VERSION 2.0                  |
+==============================================+
|  Anti‑block    : UA rotation + delays + retry |
|  Platform      : ${IS_RENDER ? "RENDER" : "LOCAL"} ${IS_RENDER ? "⚡" : ""}             |
|  Self‑wake     : ${IS_RENDER ? "ACTIVE (10min)" : "OFF"}            |
|  Cache search  : ${CACHE_TTL_SEARCH}s                    |
|  Cache dl‑meta : ${CACHE_TTL_DOWNLOAD_META}s                    |
|  Rate limit    : ${RATE_LIMIT_MAX}/15min                    |
|  CORS          : Enabled                       |
|  RAM‑safe      : buffers NOT cached             |
|  Environment   : ${NODE_ENV}                         |
|  GC enabled    : ${typeof global.gc === 'function' ? 'YES' : 'NO (use --expose-gc)'} |
|  Made with ❤️ by Munax & Jerry                  |
+==============================================+
  `);
});
