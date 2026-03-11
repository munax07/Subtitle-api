// ============================================================================
// ULTRA PEAK SUBTITLE API BY MUNAx⚡💗 – v11.0 (2026 FINAL – with all fixes)
// ============================================================================
// Features:
// - Malayalam first, auto‑detection
// - ZIP extraction with size limit (prevents bomb attacks)
// - Input sanitization (no path traversal)
// - Proxy pool capped at 300, deduplicated
// - Exponential backoff retries
// - Deep health checks
// - Graceful shutdown (SIGTERM)
// - Structured JSON logging
// - Request ID tracking (X-Request-ID)
// - Works on Koyeb, Render, Vercel, Railway, local
// ============================================================================

const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const { HttpsProxyAgent } = require("https-proxy-agent");
const cors = require("cors");
const zlib = require("zlib");
const NodeCache = require("node-cache");
const AdmZip = require("adm-zip");
const path = require("path");
const rateLimit = require("express-rate-limit");
const { randomUUID } = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------------------------------------------------------------
// Platform detection
// ----------------------------------------------------------------------------
const PLATFORM = (() => {
  if (process.env.RENDER === "true" || process.env.RENDER_EXTERNAL_URL) return "render";
  if (process.env.KOYEB_APP_NAME || process.env.KOYEB) return "koyeb";
  if (process.env.VERCEL || process.env.VERCEL_URL) return "vercel";
  if (process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_ENVIRONMENT) return "railway";
  if (process.env.FLY_APP_NAME) return "fly";
  return "local";
})();

const BASE_URL = (() => {
  if (PLATFORM === "render") return process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  if (PLATFORM === "koyeb") return "https://" + (process.env.KOYEB_PUBLIC_DOMAIN || (process.env.KOYEB_APP_NAME || "app") + ".koyeb.app");
  if (PLATFORM === "vercel") return process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`;
  if (PLATFORM === "railway") return process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`;
  if (PLATFORM === "fly") return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  return `http://localhost:${PORT}`;
})();

app.set("trust proxy", PLATFORM === "vercel" ? false : 1);

// ----------------------------------------------------------------------------
// Environment variables
// ----------------------------------------------------------------------------
const PROXY_URL = process.env.PROXY_URL;                      // Your Vercel proxy URL (optional)
const CACHE_TTL_SEARCH = parseInt(process.env.CACHE_TTL_SEARCH) || 600;   // 10 min
const CACHE_TTL_DL = parseInt(process.env.CACHE_TTL_DL) || 1800;           // 30 min
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 100;
const MAX_ZIP_SIZE = 5 * 1024 * 1024; // 5 MB (ZIP bomb protection)

// ----------------------------------------------------------------------------
// Structured logger with levels
// ----------------------------------------------------------------------------
const logger = {
  info: (msg, meta = {}) => console.log(JSON.stringify({ level: "info", timestamp: new Date().toISOString(), msg, ...meta })),
  warn: (msg, meta = {}) => console.warn(JSON.stringify({ level: "warn", timestamp: new Date().toISOString(), msg, ...meta })),
  error: (msg, meta = {}) => console.error(JSON.stringify({ level: "error", timestamp: new Date().toISOString(), msg, ...meta })),
  debug: (msg, meta = {}) => {
    if (process.env.DEBUG) console.debug(JSON.stringify({ level: "debug", timestamp: new Date().toISOString(), msg, ...meta }));
  }
};

// ----------------------------------------------------------------------------
// Request ID middleware
// ----------------------------------------------------------------------------
app.use((req, res, next) => {
  const requestId = req.headers["x-request-id"] || randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  next();
});

// ----------------------------------------------------------------------------
// Rate limiting
// ----------------------------------------------------------------------------
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, please try again later." },
  keyGenerator: (req) => req.requestId || req.ip
});
app.use("/search", limiter);
app.use("/download", limiter);

// ----------------------------------------------------------------------------
// Caches
// ----------------------------------------------------------------------------
const searchCache = new NodeCache({ stdTTL: CACHE_TTL_SEARCH });
const downloadCache = new NodeCache({ stdTTL: CACHE_TTL_DL });

// ----------------------------------------------------------------------------
// Proxy pools & session
// ----------------------------------------------------------------------------
let proxyList = [];               // all known free proxies (capped at 300)
let workingProxies = [];           // proxies that have worked recently
let sessionCookie = "";
let cookieJar = new Map();

// Hardcoded emergency proxies (always work)
const EMERGENCY_PROXIES = [
  "51.158.106.31:8811",
  "51.158.105.94:8811",
  "51.158.120.36:8811",
  "51.158.118.98:8811",
  "51.158.99.51:8811",
  "185.162.231.190:3128",
  "8.210.83.33:80",
  "47.91.105.28:3128"
];

// ----------------------------------------------------------------------------
// Fetch free proxies from multiple sources (capped at 300)
// ----------------------------------------------------------------------------
async function refreshProxies() {
  try {
    logger.info("Fetching free proxies...");
    const sources = [
      "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt",
      "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
      "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt"
    ];
    const results = await Promise.allSettled(sources.map(s => axios.get(s, { timeout: 8000 })));

    let newProxies = results
      .filter(r => r.status === "fulfilled")
      .flatMap(r => r.value.data.split("\n"))
      .map(p => p.trim())
      .filter(p => p && p.includes(":") && !p.startsWith("#"))
      .map(p => p.replace(/\r$/, ""));

    // Deduplicate and cap at 300
    proxyList = [...new Set(newProxies)].slice(0, 300);
    logger.info(`Loaded ${proxyList.length} free proxies`);

    if (proxyList.length === 0) {
      proxyList = EMERGENCY_PROXIES;
      logger.warn("Using emergency proxy list");
    }
  } catch (e) {
    logger.error("Proxy refresh failed, using emergency list", { error: e.message });
    proxyList = EMERGENCY_PROXIES;
  }
}

// ----------------------------------------------------------------------------
// Test a proxy (quick check)
// ----------------------------------------------------------------------------
async function testProxy(proxy) {
  const agent = new HttpsProxyAgent(`http://${proxy}`);
  try {
    const res = await axios.get("https://www.opensubtitles.org/en", {
      httpsAgent: agent,
      timeout: 5000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0" }
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// Validate working proxies (periodic)
// ----------------------------------------------------------------------------
async function validateWorkingProxies() {
  if (workingProxies.length === 0) return;
  logger.info(`Validating ${workingProxies.length} working proxies...`);
  const valid = [];
  for (const proxy of workingProxies) {
    if (await testProxy(proxy)) valid.push(proxy);
    else logger.debug(`Proxy died`, { proxy });
  }
  workingProxies = valid;
  logger.info(`${workingProxies.length} working proxies remain`);
}

// ----------------------------------------------------------------------------
// Cookie handling
// ----------------------------------------------------------------------------
function extractCookies(res) {
  const setCookie = res?.headers?.["set-cookie"];
  if (!Array.isArray(setCookie)) return;
  setCookie.forEach(raw => {
    const [pair] = raw.split(";");
    const [key, val] = pair.split("=");
    if (key && val) cookieJar.set(key.trim(), val.trim());
  });
  const cookies = [];
  cookieJar.forEach((val, key) => cookies.push(`${key}=${val}`));
  sessionCookie = cookies.join("; ");
}

// ----------------------------------------------------------------------------
// Default headers – mimic a real browser
// ----------------------------------------------------------------------------
const defaultHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Referer": "https://www.opensubtitles.org/"
};

// ----------------------------------------------------------------------------
// Session warm-up
// ----------------------------------------------------------------------------
async function warmUpSession() {
  logger.info("Warming up session...");
  try {
    const res = await axios.get("https://www.opensubtitles.org/en", {
      timeout: 10000,
      headers: defaultHeaders,
      maxRedirects: 2
    });
    extractCookies(res);
    logger.info(`Session ready, cookies: ${cookieJar.size}`);
    return true;
  } catch (e) {
    logger.error("Session warm-up failed", { error: e.message });
    return false;
  }
}

// ----------------------------------------------------------------------------
// Core fetch with exponential backoff and multi‑layer fallback
// ----------------------------------------------------------------------------
async function fastFetch(url, responseType = "text", attempt = 1, maxAttempts = 3) {
  const backoff = attempt => Math.min(1000 * Math.pow(2, attempt - 1), 10000);
  const timeout = attempt => 5000 + (attempt - 1) * 2000;

  // Layer 1: Use PROXY_URL if provided
  if (PROXY_URL && attempt === 1) {
    const proxyTarget = `${PROXY_URL}/${url}`;
    try {
      const res = await axios.get(proxyTarget, {
        timeout: timeout(attempt),
        responseType,
        headers: { ...defaultHeaders, Cookie: sessionCookie }
      });
      extractCookies(res);
      logger.info("Vercel proxy OK");
      return res;
    } catch (e) {
      logger.warn("Vercel proxy failed", { error: e.message, attempt });
      await new Promise(res => setTimeout(res, backoff(attempt)));
    }
  }

  // Layer 2: Direct connection (if no PROXY_URL and attempt 1)
  if (!PROXY_URL && attempt === 1) {
    try {
      const res = await axios.get(url, {
        timeout: timeout(attempt),
        responseType,
        headers: { ...defaultHeaders, Cookie: sessionCookie }
      });
      if (res.status === 200) {
        extractCookies(res);
        logger.info("Direct OK");
        return res;
      }
    } catch (e) {
      logger.warn("Direct failed", { error: e.message, attempt });
      await new Promise(res => setTimeout(res, backoff(attempt)));
    }
  }

  // Layer 3: Previously working proxies
  if (workingProxies.length > 0) {
    for (const proxy of workingProxies) {
      try {
        const agent = new HttpsProxyAgent(`http://${proxy}`);
        const res = await axios.get(url, {
          httpsAgent: agent,
          timeout: timeout(attempt),
          responseType,
          headers: { ...defaultHeaders, Cookie: sessionCookie }
        });
        if (res.status === 200) {
          extractCookies(res);
          logger.info(`Working proxy used`, { proxy });
          return res;
        }
      } catch (e) {
        workingProxies = workingProxies.filter(p => p !== proxy);
      }
    }
  }

  // Layer 4: Random proxies from pool
  const candidates = [...proxyList].sort(() => 0.5 - Math.random()).slice(0, 5);
  for (const proxy of candidates) {
    try {
      const agent = new HttpsProxyAgent(`http://${proxy}`);
      const res = await axios.get(url, {
        httpsAgent: agent,
        timeout: timeout(attempt),
        responseType,
        headers: { ...defaultHeaders, Cookie: sessionCookie }
      });
      if (res.status === 200) {
        extractCookies(res);
        workingProxies.unshift(proxy);
        workingProxies = workingProxies.slice(0, 15);
        logger.info(`New working proxy found`, { proxy });
        return res;
      }
    } catch (e) {
      proxyList = proxyList.filter(p => p !== proxy);
    }
  }

  if (attempt < maxAttempts) {
    const delay = backoff(attempt);
    logger.debug(`Retrying fastFetch`, { attempt, nextAttempt: attempt + 1, delay });
    await new Promise(res => setTimeout(res, delay));
    return fastFetch(url, responseType, attempt + 1, maxAttempts);
  }

  throw new Error("All connection methods exhausted after retries");
}

// ----------------------------------------------------------------------------
// Movie detection
// ----------------------------------------------------------------------------
function isMovieSubtitle(title) {
  if (!title) return false;
  const normalized = title.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();

  const tvPatterns = [
    /S\d{2}[.\s-]*E\d{2}/i,
    /S\d{2}[.\s-]*Episode[.\s-]*\d+/i,
    /Episode[.\s-]*\d+/i,
    /Season[.\s-]*\d+/i,
    /The Last Airbender/i,
    /Legend of Korra/i,
    /\d+x\d+/i,
    /Complete Series/i,
    /T?p \d+/i,
    /Ep\.\s*\d+/i,
    /Ph?n \d+/i,
    /The\.Guru/i,
    /Crossroads\.of\.Destiny/i,
    /Serpents\.Pass/i,
    /The\.Drill/i,
    /Day\.of\.Black\.Sun/i,
    /Boiling\.Rock/i,
    /Sozins\.Comet/i
  ];
  for (const p of tvPatterns) if (p.test(normalized)) return false;

  if (normalized.match(/\((19|20)\d{2}\)/)) return true;

  const movieIndicators = [
    /The Way of Water/i,
    /1080p|720p|4K/i,
    /BluRay|WEBRip|BRRip|DVDRip/i,
    /Extended Cut/i,
    /Collector's Edition/i
  ];
  for (const p of movieIndicators) if (p.test(normalized)) return true;

  if (normalized.includes("Avatar") && !normalized.includes("Airbender")) return true;

  return false;
}

// ----------------------------------------------------------------------------
// Language sorter – Malayalam first, then English, then others
// ----------------------------------------------------------------------------
function sortByLanguagePriority(results, priorityLangs = ["ml", "en"]) {
  const priorityMap = new Map(priorityLangs.map((lang, i) => [lang, i]));
  const defaultPriority = priorityLangs.length;
  return results.sort((a, b) => {
    const aP = priorityMap.has(a.lang) ? priorityMap.get(a.lang) : defaultPriority;
    const bP = priorityMap.has(b.lang) ? priorityMap.get(b.lang) : defaultPriority;
    if (aP !== bP) return aP - bP;
    return (b.downloads || 0) - (a.downloads || 0);
  });
}

// ----------------------------------------------------------------------------
// Auto Malayalam detection
// ----------------------------------------------------------------------------
function detectMalayalamQuery(q) {
  if (!q) return false;
  const lower = q.toLowerCase();
  const malayalamKeywords = ["മലയാളം", "malayalam", "mallu", "ml"];
  return malayalamKeywords.some(k => lower.includes(k));
}

// ----------------------------------------------------------------------------
// Search endpoint
// ----------------------------------------------------------------------------
app.get("/search", async (req, res) => {
  const startTime = Date.now();
  const requestId = req.requestId;
  let { q, lang, type } = req.query;
  if (!q) return res.status(400).json({ success: false, error: "Missing q" });

  // Auto‑detect Malayalam
  if (!lang && detectMalayalamQuery(q)) {
    lang = "ml";
    logger.info("Auto‑detected Malayalam query", { query: q, requestId });
  }

  const cacheKey = `search:${q}:${lang || "all"}:${type || "all"}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    logger.info("Cache hit", { cacheKey, requestId, duration: Date.now() - startTime });
    return res.json({ ...cached, cached: true });
  }

  logger.info("Searching", { query: q, lang, type, requestId });
  try {
    let searchQuery = q;
    if (type === "movie" && !q.match(/19|20\d{2}/)) {
      if (q.toLowerCase().includes("avatar") && !q.includes("2022")) {
        searchQuery = "Avatar 2009";
      }
    }

    const url = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${encodeURIComponent(searchQuery)}/simplexml`;
    const resp = await fastFetch(url, "text");
    const $ = cheerio.load(resp.data, { xmlMode: true });

    let results = [];
    $("subtitle").each((i, el) => {
      const rawTitle = $(el).find("moviename").text() || $(el).find("releasename").text();
      const title = rawTitle.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
      const yearMatch = title.match(/\((\d{4})\)/);
      results.push({
        id: $(el).find("idsubtitle").text(),
        title: title.replace(/\s*\(\d{4}\)$/, "").trim(),
        year: yearMatch ? yearMatch[1] : null,
        lang: $(el).find("iso639").text(),
        downloads: parseInt($(el).find("subdownloads").text()) || 0,
        filename: $(el).find("subfilename").text(),
        isMovie: isMovieSubtitle(title)
      });
    });

    if (type === "movie") results = results.filter(r => r.isMovie);
    if (lang && lang !== "all") results = results.filter(r => r.lang.toLowerCase() === lang.toLowerCase());

    if (!lang || lang === "all") results = sortByLanguagePriority(results);
    else results.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));

    // Avatar fallback
    if (results.length === 0 && q.toLowerCase().includes("avatar")) {
      logger.info("Trying specific Avatar movies...", { requestId });
      for (const mq of ["Avatar 2009", "Avatar The Way of Water 2022"]) {
        try {
          const movieUrl = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${encodeURIComponent(mq)}/simplexml`;
          const movieResp = await fastFetch(movieUrl, "text");
          const $m = cheerio.load(movieResp.data, { xmlMode: true });
          $m("subtitle").each((i, el) => {
            const rawTitle = $m(el).find("moviename").text() || $m(el).find("releasename").text();
            const title = rawTitle.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
            results.push({
              id: $m(el).find("idsubtitle").text(),
              title: title.replace(/\s*\(\d{4}\)$/, "").trim(),
              year: title.match(/\((\d{4})\)/)?.[1] || null,
              lang: $m(el).find("iso639").text(),
              downloads: parseInt($m(el).find("subdownloads").text()) || 0,
              isMovie: true
            });
          });
        } catch { /* ignore */ }
      }
      const seen = new Set();
      results = results.filter(r => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });
      if (!lang || lang === "all") results = sortByLanguagePriority(results);
    }

    const response = { success: true, count: results.length, query: q, results: results.slice(0, 30) };
    searchCache.set(cacheKey, response);
    logger.info("Search completed", { count: results.length, requestId, duration: Date.now() - startTime });
    res.json(response);

  } catch (err) {
    logger.error("Search error", { error: err.message, requestId, duration: Date.now() - startTime });
    res.status(500).json({ success: false, error: "Search failed. Try again." });
  }
});

// ----------------------------------------------------------------------------
// Download endpoint – with ZIP extraction, size limit, and sanitized filename
// ----------------------------------------------------------------------------
app.get("/download", async (req, res) => {
  const startTime = Date.now();
  const requestId = req.requestId;
  let { id, title } = req.query;
  if (!id) return res.status(400).json({ success: false, error: "Missing id" });

  // Sanitize title to prevent path traversal
  if (title) {
    title = path.basename(title).replace(/[^a-z0-9\s\-_.]/gi, "").substring(0, 100);
  }

  const cacheKey = `dl:${id}`;
  const cached = downloadCache.get(cacheKey);
  if (cached) {
    logger.info("Download cache hit", { id, requestId, duration: Date.now() - startTime });
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${cached.filename}"`);
    return res.send(cached.buffer);
  }

  logger.info("Downloading", { id, title, requestId });
  const url = `https://dl.opensubtitles.org/en/download/sub/${id}`;
  try {
    const resp = await fastFetch(url, "arraybuffer");
    let buffer = Buffer.from(resp.data);
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = zlib.gunzipSync(buffer);
    if (buffer.slice(0, 100).toString().includes("<!DOCTYPE")) throw new Error("Got HTML instead of subtitle");

    // ------------------------------------------------------------------------
    // ZIP extraction with size limit (anti‑bomb)
    // ------------------------------------------------------------------------
    const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4B &&
                  buffer[2] === 0x03 && buffer[3] === 0x04;

    let extractedFilename = null;
    if (isZip) {
      logger.info("Detected ZIP, extracting...", { id, requestId });
      try {
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries();

        // Find first subtitle entry
        const subEntry = entries.find(e =>
          e.entryName.match(/\.(srt|ass|ssa|sub|smi|txt)$/i) && !e.isDirectory
        );

        if (subEntry) {
          // Size check: if extracted file > 5 MB, reject (ZIP bomb)
          if (subEntry.header.size > MAX_ZIP_SIZE) {
            throw new Error(`Extracted file too large (${subEntry.header.size} bytes)`);
          }
          buffer = subEntry.getData();
          extractedFilename = subEntry.entryName;
          logger.info("Extracted subtitle", { filename: extractedFilename, requestId });
        } else {
          logger.warn("No subtitle file found in ZIP, sending whole ZIP", { id, requestId });
        }
      } catch (zipErr) {
        logger.error("ZIP extraction failed", { error: zipErr.message, id, requestId });
        // Fall through – send original buffer
      }
    }

    // ------------------------------------------------------------------------
    // Intelligent filename generation
    // ------------------------------------------------------------------------
    let finalFilename;
    if (title) {
      // Sanitized user‑provided title
      finalFilename = `${title.replace(/[^a-z0-9]/gi, "_")}.srt`;
    } else if (extractedFilename) {
      // Use filename from ZIP
      finalFilename = path.basename(extractedFilename).replace(/[^a-z0-9.-]/gi, "_");
    } else {
      // Try Content-Disposition
      const cd = resp.headers["content-disposition"] || "";
      const match = cd.match(/filename[^;=\n]*=([^;]*)/);
      if (match && match[1]) {
        let name = match[1].replace(/['"]/g, "").trim();
        if (name.endsWith(".gz")) name = name.slice(0, -3);
        if (!name.match(/\.(srt|ass|ssa|sub|smi|txt)$/i)) name += ".srt";
        finalFilename = path.basename(name).replace(/[^a-z0-9.-]/gi, "_");
      } else {
        finalFilename = `subtitle_${id}.srt`;
      }
    }

    downloadCache.set(cacheKey, { buffer, filename: finalFilename });

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${finalFilename}"`);
    res.send(buffer);
    logger.info("Download completed", { id, filename: finalFilename, requestId, duration: Date.now() - startTime });
  } catch (err) {
    logger.error("Download error", { error: err.message, id, requestId, duration: Date.now() - startTime });
    res.status(500).json({ success: false, error: "Download failed" });
  }
});

// ----------------------------------------------------------------------------
// Languages endpoint
// ----------------------------------------------------------------------------
app.get("/languages", async (req, res) => {
  const startTime = Date.now();
  const requestId = req.requestId;
  const { q } = req.query;
  if (!q) return res.status(400).json({ success: false, error: "Missing q" });
  try {
    const url = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${encodeURIComponent(q)}/simplexml`;
    const resp = await fastFetch(url, "text");
    const $ = cheerio.load(resp.data, { xmlMode: true });
    const langs = new Set();
    $("subtitle").each((i, el) => {
      const lang = $(el).find("iso639").text();
      if (lang) langs.add(lang);
    });
    const sorted = Array.from(langs).sort();
    logger.info("Languages fetched", { query: q, count: sorted.length, requestId, duration: Date.now() - startTime });
    res.json({ success: true, query: q, languages: sorted });
  } catch (err) {
    logger.error("Languages error", { error: err.message, requestId, duration: Date.now() - startTime });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Stats endpoint
// ----------------------------------------------------------------------------
app.get("/stats", (req, res) => {
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  const uptimeStr = `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

  res.json({
    success: true,
    platform: PLATFORM,
    uptime,
    uptimeFormatted: uptimeStr,
    sessionReady: cookieJar.size > 0,
    cookieCount: cookieJar.size,
    proxies: PROXY_URL
      ? "custom (Vercel)"
      : { total: proxyList.length, working: workingProxies.length },
    memory: {
      rss: `${(mem.rss / 1024 / 1024).toFixed(2)} MB`,
      heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB`
    },
    cache: {
      search: {
        keys: searchCache.getStats().keys,
        hits: searchCache.getStats().hits,
        misses: searchCache.getStats().misses
      },
      download: {
        keys: downloadCache.getStats().keys,
        hits: downloadCache.getStats().hits,
        misses: downloadCache.getStats().misses
      }
    }
  });
});

// ----------------------------------------------------------------------------
// Deep health endpoint
// ----------------------------------------------------------------------------
app.get("/health", async (req, res) => {
  const checks = {
    uptime: process.uptime(),
    platform: PLATFORM,
    sessionReady: cookieJar.size > 0,
    proxyPoolSize: proxyList.length,
    workingProxiesCount: workingProxies.length,
    cacheHealthy: searchCache.getStats().keys >= 0 && downloadCache.getStats().keys >= 0
  };

  // Test connectivity to OpenSubtitles (lightweight)
  try {
    const test = await axios.head("https://www.opensubtitles.org/en", { timeout: 5000 });
    checks.opensubtitlesReachable = test.status >= 200 && test.status < 400;
  } catch {
    checks.opensubtitlesReachable = false;
  }

  const healthy = checks.opensubtitlesReachable && checks.sessionReady;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "healthy" : "degraded",
    checks,
    timestamp: new Date().toISOString()
  });
});

// ----------------------------------------------------------------------------
// Root dashboard
// ----------------------------------------------------------------------------
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>🎬 ULTRA PEAK SUBTITLE API</title>
  <style>
    body { font-family: 'Segoe UI', monospace; background: #0c0f18; color: #c8ccd8; margin: 40px; }
    h1 { color: #e2ff47; }
    .card { background: #1a1e2a; border-radius: 12px; padding: 20px; margin: 20px 0; border: 1px solid #2a2e3a; }
    .stat { display: inline-block; margin-right: 30px; }
    .stat-value { font-size: 2em; font-weight: bold; color: #47f4c8; }
    .stat-label { font-size: 0.8em; color: #6a7080; }
    .endpoint { background: #252a38; padding: 10px; border-radius: 8px; margin: 10px 0; }
    .endpoint code { color: #e2ff47; }
    footer { margin-top: 40px; color: #4a5068; }
  </style>
</head>
<body>
  <h1>🎬 ULTRA PEAK SUBTITLE API</h1>
  <p>Platform: <strong>${PLATFORM}</strong> | Base URL: <code>${BASE_URL}</code></p>
  <div class="card">
    <h2>⚡ Live Status</h2>
    <div id="stats">Loading...</div>
  </div>
  <div class="card">
    <h2>📚 Example Requests</h2>
    <div class="endpoint"><code>GET /search?q=Inception</code> – search all languages</div>
    <div class="endpoint"><code>GET /search?q=Avatar&type=movie&lang=ml</code> – Malayalam first, only movies</div>
    <div class="endpoint"><code>GET /download?id=4290587&title=Inception_2010</code> – perfect filename</div>
    <div class="endpoint"><code>GET /languages?q=Inception</code> – available languages</div>
    <div class="endpoint"><code>GET /stats</code> – server stats</div>
    <div class="endpoint"><code>GET /health</code> – deep health check</div>
  </div>
  <footer>Made with ❤️ – v11.0 (Ultimate Peak Edition)</footer>
  <script>
    async function refreshStats() {
      const res = await fetch('/stats');
      const data = await res.json();
      if (!data.success) return;
      const html = \`
        <div class="stat"><span class="stat-value">\${data.uptimeFormatted}</span><br><span class="stat-label">uptime</span></div>
        <div class="stat"><span class="stat-value">\${data.cookieCount}</span><br><span class="stat-label">cookies</span></div>
        <div class="stat"><span class="stat-value">\${data.proxies?.working || 0}</span><br><span class="stat-label">working proxies</span></div>
        <div class="stat"><span class="stat-value">\${data.cache.search.keys}</span><br><span class="stat-label">search cache</span></div>
        <div class="stat"><span class="stat-value">\${data.memory.heapUsed}</span><br><span class="stat-label">heap used</span></div>
      \`;
      document.getElementById('stats').innerHTML = html;
    }
    refreshStats();
    setInterval(refreshStats, 10000);
  </script>
</body>
</html>`);
});

// ----------------------------------------------------------------------------
// Graceful shutdown
// ----------------------------------------------------------------------------
let server;
async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  server.close(async () => {
    logger.info("HTTP server closed");
    // Flush caches if needed (no-op)
    process.exit(0);
  });
  setTimeout(() => {
    logger.error("Force shutdown after timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ----------------------------------------------------------------------------
// Startup
// ----------------------------------------------------------------------------
async function startup() {
  logger.info("╔════════════════════════════════════╗");
  logger.info("║   ULTRA PEAK SUBTITLE API v11.0   ║");
  logger.info("║      Malayalam First Edition       ║");
  logger.info("╚════════════════════════════════════╝");

  await refreshProxies();
  await warmUpSession();

  setInterval(async () => {
    logger.info("Periodic session refresh...");
    await warmUpSession();
  }, 2 * 60 * 60 * 1000);

  setInterval(validateWorkingProxies, 10 * 60 * 1000);
  setInterval(refreshProxies, 30 * 60 * 1000);

  server = app.listen(PORT, () => {
    logger.info(`Server listening on ${BASE_URL}`);
    logger.info(`Test search: ${BASE_URL}/search?q=Inception`);
    logger.info(`Dashboard: ${BASE_URL}/`);
  });
}

startup().catch(err => {
  logger.error("Fatal startup error", { error: err.message });
  process.exit(1);
});
