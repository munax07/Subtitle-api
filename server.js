const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const NodeCache = require("node-cache");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// ==================== TRUST PROXY ====================
app.set('trust proxy', 1);

// ==================== CONFIGURATION ====================
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// CORS
app.use(cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, please try again later." },
});

// Modern User-Agents
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

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
    validateStatus: () => true,
  });
}

// ==================== HELPER FUNCTIONS ====================
function createError(type, message, debug = null) {
  const err = new Error(message);
  err.type = type;
  err.debug = debug;
  return err;
}

function serializeError(res, url) {
  return {
    status: res?.status,
    statusText: res?.statusText,
    url,
    body: typeof res?.data === "string" ? res.data.slice(0, 500) : null,
  };
}

function parseSearch(html) {
  if (!html || typeof html !== "string") return [];

  const $ = cheerio.load(html);
  if ($("#search_results").length === 0) return null;

  const results = [];

  $("#search_results tbody tr").each((_, row) => {
    const $row = $(row);

    if (
      $row.hasClass("head") ||
      $row.attr("style") === "display:none" ||
      !$row.attr("onclick")
    )
      return;

    const idMatch =
      $row.attr("onclick")?.match(/servOC\((\d+)/) ||
      $row.attr("id")?.match(/name(\d+)/);
    if (!idMatch) return;
    const id = idMatch[1];

    let title = $row.find("td:first-child strong a").first().text().trim();
    let year = null;
    const yearMatch = title.match(/\((\d{4})\)$/);
    if (yearMatch) {
      year = yearMatch[1];
      title = title.replace(/\s*\(\d{4}\)$/, "").trim();
    }

    if (!title) return;

    let language = "unknown";
    const flag = $row.find(".flag").first();
    if (flag.length) {
      const flagClass = flag.attr("class") || "";
      const langMatch = flagClass.match(/flag\s+([a-z]{2})/);
      if (langMatch) language = langMatch[1];
    }

    let downloads = 0;
    const downloadLink = $row.find('a[href*="subtitleserve"]').first();
    if (downloadLink.length) {
      const dlText = downloadLink.text().trim().replace("x", "").replace(/,/g, "");
      downloads = parseInt(dlText) || 0;
    }

    const uploader = $row.find("td:last-child a").first().text().trim() || "anonymous";
    const uploadDate = $row.find("time").first().text().trim() || null;

    // REAL FILENAME (not vote count)
    let filename = null;
    const span = $row.find("span[title]").first();
    if (span.length) {
      const possibleFilename = span.attr("title");
      if (possibleFilename && !possibleFilename.match(/^\d+\s+votes?$/i)) {
        filename = possibleFilename;
      }
    }

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
      filename, // Now contains REAL filename or null
      features,
    });
  });

  return results;
}

// ==================== CORE FUNCTIONS ====================
async function searchSubtitles(query, page = 1) {
  const cacheKey = `search_${query}_page_${page}`;
  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const url = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${encodeURIComponent(query)}/${page}`;

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 2000));

    const userAgent = getRandomUserAgent();
    const client = createClient(userAgent);

    let res;
    try {
      res = await client.get(url);
    } catch (e) {
      lastError = createError("network_error", `Failed to reach OpenSubtitles: ${e.message}`);
      continue;
    }

    if (res.status !== 200) {
      lastError = createError("search_failed", `OpenSubtitles returned status ${res.status}`, serializeError(res, url));
      if (res.status === 403) continue;
      else break;
    }

    const results = parseSearch(res.data);
    if (results === null) {
      lastError = createError("parse_failed", "Could not parse OpenSubtitles response.", serializeError(res, url));
      continue;
    }

    results.sort((a, b) => b.downloads - a.downloads);

    const data = { query, page, total: results.length, fromCache: false, results };
    cache.set(cacheKey, data);
    return data;
  }

  throw lastError || createError("search_failed", "All attempts failed");
}

function filterByLanguage(searchData, lang) {
  if (!lang || lang === "all") return searchData;
  const filtered = searchData.results.filter(
    (item) => item.language.toLowerCase() === lang.toLowerCase()
  );
  return { ...searchData, language: lang, total: filtered.length, results: filtered };
}

async function downloadSubtitle(id, originalFilename = null) {
  const cacheKey = `download_${id}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const urls = [
    `https://dl.opensubtitles.org/en/download/sub/${id}`,
    `https://www.opensubtitles.org/en/subtitleserve/sub/${id}`,
  ];

  for (const url of urls) {
    await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));
    const userAgent = getRandomUserAgent();
    const client = createClient(userAgent);

    let res;
    try {
      res = await client.get(url, { responseType: "arraybuffer" });
    } catch {
      continue;
    }

    if (res.status !== 200) continue;

    const buffer = Buffer.from(res.data);
    if (buffer.length === 0) continue;

    const head = buffer.slice(0, 300).toString("utf8");
    if (head.includes("<html") || head.includes("<!DOCTYPE") || head.includes("<!doctype"))
      continue;

    let ext = "srt";
    let finalFilename = null;

    // Priority 1: Use original filename from search
    if (originalFilename) {
      finalFilename = originalFilename.replace(/[^a-zA-Z0-9.\-_\s]/g, '');
      const parts = finalFilename.split(".");
      if (parts.length > 1) ext = parts.pop().toLowerCase();
    } else {
      // Priority 2: Extract from Content-Disposition
      const cd = res.headers["content-disposition"];
      if (cd) {
        const match = cd.match(/filename[^;=\n]*=(['"]?)([^\n'"]*)\1/i);
        if (match && match[2]) {
          finalFilename = match[2];
          const parts = finalFilename.split(".");
          if (parts.length > 1) ext = parts.pop().toLowerCase();
        }
      }
    }

    if (!finalFilename) {
      finalFilename = `subtitle_${id}.${ext}`;
    }

    const result = { buffer, ext, filename: finalFilename, size: buffer.length };
    cache.set(cacheKey, result, 600);
    return result;
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
  const page = parseInt(pageStr) || 1;
  if (page < 1 || page > 100) return null;
  return page;
}

function validateId(id) {
  if (!id || typeof id !== "string") return false;
  return /^\d+$/.test(id.trim());
}

// ==================== SELF-WAKE MECHANISM ====================
// Only runs in production (Render) to keep the service awake
if (process.env.RENDER_EXTERNAL_URL) {
  console.log("⏰ Self-wake mechanism activated – pinging every 10 minutes");
  setInterval(() => {
    https.get(`${BASE_URL}/health`, (res) => {
      console.log(`💤 Self-ping at ${new Date().toISOString()} – status: ${res.statusCode}`);
    }).on('error', (err) => {
      console.log(`⚠️ Self-ping failed: ${err.message}`);
    });
  }, 10 * 60 * 1000); // Every 10 minutes
}

// ==================== ROUTES ====================

// Root – beautiful docs (shortened for brevity, keep your full HTML)
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>...`); // Keep your existing beautiful HTML
});

// Languages
app.get("/languages", async (req, res) => {
  const queryErr = validateQuery(req.query.q);
  if (queryErr) return res.status(400).json({ success: false, error: queryErr });

  try {
    const data = await searchSubtitles(req.query.q.trim());
    const languages = [...new Set(data.results.map(i => i.language))].sort();
    res.json({ success: true, query: req.query.q, fromCache: data.fromCache, count: languages.length, languages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.type, message: err.message, debug: err.debug });
  }
});

// Stats
app.get("/stats", (req, res) => {
  const stats = cache.getStats();
  const mem = process.memoryUsage();
  const formatBytes = (b) => b ? `${(b / 1024 / 1024).toFixed(2)} MB` : "0 B";
  res.json({
    success: true,
    uptime: Math.floor(process.uptime()),
    uptimeFormatted: new Date(process.uptime() * 1000).toISOString().substr(11, 8),
    memory: { rss: formatBytes(mem.rss), heapUsed: formatBytes(mem.heapUsed), heapTotal: formatBytes(mem.heapTotal) },
    cache: { keys: cache.keys().length, hits: stats.hits, misses: stats.misses, ksize: formatBytes(stats.ksize), vsize: formatBytes(stats.vsize) },
    timestamp: new Date().toISOString()
  });
});

// Main endpoint
app.get("/subtitle", limiter, async (req, res) => {
  const { action } = req.query;

  try {
    if (action === "search") {
      const qErr = validateQuery(req.query.q);
      if (qErr) return res.status(400).json({ success: false, error: qErr });

      const data = await searchSubtitles(req.query.q.trim(), validatePage(req.query.page) || 1);
      const final = req.query.lang ? filterByLanguage(data, req.query.lang) : data;
      return res.json({ success: true, data: final });
    }

    if (action === "download") {
      const { id, filename } = req.query;
      if (!validateId(id)) return res.status(400).json({ success: false, error: "Invalid subtitle ID" });

      const file = await downloadSubtitle(id.trim(), filename);
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", file.size);
      res.setHeader("X-File-Extension", file.ext);
      return res.send(file.buffer);
    }

    return res.status(400).json({ success: false, error: "Invalid action" });
  } catch (err) {
    console.error("[/subtitle error]", err.message);
    res.status(500).json({ success: false, error: err.type || "internal", message: err.message, debug: err.debug });
  }
});

// Health
app.get("/health", (req, res) => res.status(200).json({ status: "healthy", uptime: process.uptime(), timestamp: new Date().toISOString() }));

// 404
app.use((req, res) => res.status(404).json({ success: false, error: "Not found" }));

// Global error handler
app.use((err, req, res, next) => {
  console.error("[Unhandled]", err);
  res.status(500).json({ success: false, error: "server_error" });
});

// ==================== START ====================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║     🎬  OPENSUBTITLES PROXY API – PEAK EDITION       ║
╠══════════════════════════════════════════════════════╣
║  ✅  Port: ${PORT}                                          ║
║  🚀  Anti-block: ON (UA + delays + retries)          ║
║  ⏰  Self-wake: ${process.env.RENDER_EXTERNAL_URL ? 'ACTIVE' : 'OFF (local)'}        ║
║  📦  Cache: 300s                                     ║
║  🛡️   Rate limit: 100/15min                          ║
║  🌐  CORS: Enabled                                   ║
║  ⭐  Made with ❤️ by Munax                            ║
╚══════════════════════════════════════════════════════╝
  `);
});
