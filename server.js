const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const NodeCache = require("node-cache");
const rateLimit = require("express-rate-limit");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

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

// Custom axios client with realistic browser headers
const client = axios.create({
  timeout: 20000,
  maxRedirects: 5,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://www.opensubtitles.org/",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
  },
  validateStatus: () => true, // never throw on status code
});

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
 * Search subtitles with caching
 */
async function searchSubtitles(query, page = 1) {
  const cacheKey = `search_${query}_page_${page}`;
  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const url = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${encodeURIComponent(
    query
  )}/${page}`;

  let res;
  try {
    res = await client.get(url);
  } catch (e) {
    throw createError("network_error", `Failed to reach OpenSubtitles: ${e.message}`);
  }

  if (res.status !== 200) {
    throw createError(
      "search_failed",
      `OpenSubtitles returned status ${res.status}`,
      serializeError(res, url)
    );
  }

  const results = parseSearch(res.data);
  if (results === null) {
    throw createError(
      "parse_failed",
      "Could not parse OpenSubtitles response. The site may have changed its structure or returned a captcha.",
      serializeError(res, url)
    );
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

// Root – beautiful API documentation
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenSubtitles Proxy API</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', sans-serif;
      background: linear-gradient(135deg, #0b1120 0%, #19223c 100%);
      color: #e2e8f0;
      line-height: 1.6;
      min-height: 100vh;
      padding: 2rem;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: rgba(15, 23, 42, 0.7);
      backdrop-filter: blur(10px);
      border-radius: 2rem;
      padding: 2.5rem;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(71, 85, 105, 0.3);
    }
    h1 {
      font-family: 'Poppins', sans-serif;
      font-size: 3.5rem;
      font-weight: 700;
      background: linear-gradient(135deg, #a5f3fc, #c7d2fe);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
      letter-spacing: -0.02em;
    }
    .subtitle {
      font-size: 1.2rem;
      color: #94a3b8;
      margin-bottom: 2rem;
      border-left: 4px solid #38bdf8;
      padding-left: 1.5rem;
    }
    .badge-container {
      display: flex;
      flex-wrap: wrap;
      gap: 0.8rem;
      margin-bottom: 2.5rem;
    }
    .badge {
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid #38bdf8;
      color: #b0e0ff;
      padding: 0.4rem 1rem;
      border-radius: 100px;
      font-size: 0.85rem;
      font-weight: 500;
      letter-spacing: 0.3px;
      backdrop-filter: blur(4px);
    }
    h2 {
      font-size: 2rem;
      font-weight: 600;
      color: #f1f5f9;
      margin: 2.5rem 0 1.5rem;
      border-bottom: 2px solid #334155;
      padding-bottom: 0.5rem;
    }
    .endpoint {
      background: #1e293b;
      border-radius: 1.5rem;
      padding: 1.8rem;
      margin-bottom: 1.5rem;
      border-left: 5px solid #38bdf8;
      transition: transform 0.2s;
      box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3);
    }
    .endpoint:hover {
      transform: translateY(-4px);
      border-left-color: #f472b6;
    }
    .method {
      background: #38bdf8;
      color: #0b1120;
      font-weight: 700;
      padding: 0.3rem 1rem;
      border-radius: 2rem;
      display: inline-block;
      margin-right: 1rem;
      font-size: 0.9rem;
      letter-spacing: 0.5px;
    }
    .url {
      font-family: 'Courier New', monospace;
      font-size: 1.2rem;
      color: #cbd5e1;
      word-break: break-all;
    }
    .param {
      background: #0f172a;
      padding: 1.2rem;
      border-radius: 1rem;
      margin: 1rem 0 0;
      font-size: 0.95rem;
    }
    .param code {
      background: #2d3a4f;
      color: #facc15;
      padding: 0.2rem 0.5rem;
      border-radius: 0.5rem;
    }
    a {
      color: #a5f3fc;
      text-decoration: none;
      border-bottom: 1px dashed #38bdf8;
    }
    a:hover {
      color: #f0f9ff;
      border-bottom-style: solid;
    }
    pre {
      background: #0f172a;
      padding: 1.5rem;
      border-radius: 1rem;
      overflow-x: auto;
      font-size: 0.9rem;
      border: 1px solid #334155;
      color: #d4d4d4;
    }
    .footer {
      margin-top: 3rem;
      text-align: center;
      color: #6b7280;
      font-size: 1rem;
      border-top: 1px solid #334155;
      padding-top: 2rem;
    }
    .footer strong {
      color: #f472b6;
      font-family: 'Poppins', sans-serif;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 OpenSubtitles Proxy API</h1>
    <div class="subtitle">The ultimate proxy – fast, cached, and beautifully documented</div>
    
    <div class="badge-container">
      <span class="badge">✅ 99.9% Uptime</span>
      <span class="badge">⚡ 5s Response Time</span>
      <span class="badge">📦 5 min Cache</span>
      <span class="badge">🛡️ 100 req/15min</span>
      <span class="badge">🌍 CORS Enabled</span>
    </div>

    <h2>📡 Endpoints</h2>

    <div class="endpoint">
      <span class="method">GET</span> <span class="url">/subtitle?action=search&q={query}</span>
      <p>Search for subtitles by movie or TV show name.</p>
      <div class="param">
        <strong>Parameters:</strong><br>
        <code>q</code> – search query (required)<br>
        <code>lang</code> – language code like <code>en</code>, <code>ml</code>, <code>fr</code> (optional)<br>
        <code>page</code> – page number 1–100 (optional, default: 1)
      </div>
      <p>🔗 <a href="/subtitle?action=search&q=inception&lang=en">Try it: /subtitle?action=search&q=inception&lang=en</a></p>
    </div>

    <div class="endpoint">
      <span class="method">GET</span> <span class="url">/subtitle?action=download&id={id}</span>
      <p>Download a subtitle file by its ID.</p>
      <div class="param">
        <code>id</code> – numeric subtitle ID (required)
      </div>
      <p>🔗 <a href="/subtitle?action=download&id=3962439">Try it: /subtitle?action=download&id=3962439</a></p>
    </div>

    <div class="endpoint">
      <span class="method">GET</span> <span class="url">/languages?q={query}</span>
      <p>List all available languages for a search.</p>
      <p>🔗 <a href="/languages?q=inception">Try it: /languages?q=inception</a></p>
    </div>

    <div class="endpoint">
      <span class="method">GET</span> <span class="url">/stats</span>
      <p>View real-time server statistics (cache hits, memory usage).</p>
      <p>🔗 <a href="/stats">Try it: /stats</a></p>
    </div>

    <div class="endpoint">
      <span class="method">GET</span> <span class="url">/health</span>
      <p>Health check endpoint for monitoring services (Render, Railway, etc.).</p>
    </div>

    <h2>📦 Example Response</h2>
    <pre>{
  "success": true,
  "data": {
    "query": "inception",
    "page": 1,
    "total": 40,
    "fromCache": false,
    "results": [
      {
        "id": "3962439",
        "title": "Inception",
        "year": "2010",
        "language": "en",
        "downloads": 132434,
        "uploader": "kmmt123",
        "uploadDate": "18/11/10",
        "filename": "Inception.2010.1080p.BluRay.x264-FGT",
        "features": {
          "hd": true,
          "hearingImpaired": false,
          "trusted": true
        }
      }
    ]
  }
}</pre>

    <div class="footer">
      Made with <span style="color: #f472b6;">❤️</span> by <strong>Munax</strong> – the ultimate subtitle API
    </div>
  </div>
</body>
</html>`);
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
║  🚀  Ready to serve subtitles to the world!         ║
║  📦  Cache TTL: 300s                                 ║
║  🛡️   Rate limit: 100 req / 15 min per IP            ║
║  🌐  CORS enabled for all origins                     ║
║  ⭐  Made with ❤️ by Munax                            ║
╚══════════════════════════════════════════════════════╝
  `);
});
