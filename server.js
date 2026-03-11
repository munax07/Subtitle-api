const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const NodeCache = require("node-cache");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const compression = require("compression");
const https = require("https");
const path = require("path");
const { HttpsProxyAgent } = require("https-proxy-agent");
const pino = require("pino");
const pinoHttp = require("pino-http");

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------------------------------------
// PINO LOGGER SETUP
// --------------------------------------------------
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
app.use(pinoHttp({ logger }));

// --------------------------------------------------
// PLATFORM DETECTION
// --------------------------------------------------
const PLATFORM = (function() {
  if (process.env.RENDER === "true" || process.env.RENDER_EXTERNAL_URL) return "render";
  if (process.env.KOYEB_APP_NAME || process.env.KOYEB) return "koyeb";
  if (process.env.VERCEL || process.env.VERCEL_URL) return "vercel";
  if (process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_ENVIRONMENT) return "railway";
  if (process.env.FLY_APP_NAME) return "fly";
  return "local";
}());

const BASE_URL = (function() {
  if (PLATFORM === "render") return process.env.RENDER_EXTERNAL_URL || (`http://localhost:${PORT}`);
  if (PLATFORM === "koyeb") return "https://" + (process.env.KOYEB_PUBLIC_DOMAIN || (process.env.KOYEB_APP_NAME || "app") + ".koyeb.app");
  if (PLATFORM === "vercel") return process.env.VERCEL_URL ? ("https://" + process.env.VERCEL_URL) : (`http://localhost:${PORT}`);
  if (PLATFORM === "railway") return process.env.RAILWAY_STATIC_URL || (`http://localhost:${PORT}`);
  if (PLATFORM === "fly") return "https://" + process.env.FLY_APP_NAME + ".fly.dev";
  return `http://localhost:${PORT}`;
}());

const IS_SERVERLESS = PLATFORM === "vercel";
const IS_PROD = process.env.NODE_ENV === "production";
const NEEDS_PING = (PLATFORM === "render" || PLATFORM === "koyeb" || PLATFORM === "railway");

app.set("trust proxy", IS_SERVERLESS ? false : 1);

// --------------------------------------------------
// COMPRESSION MIDDLEWARE
// --------------------------------------------------
app.use(compression({ threshold: 512 })); // compress responses larger than 512 bytes

// --------------------------------------------------
// PROXY SETUP
// --------------------------------------------------
let proxyAgent = null;
if (process.env.PROXY_URL) {
  try {
    proxyAgent = new HttpsProxyAgent(process.env.PROXY_URL);
    logger.info(`Proxy configured: ${process.env.PROXY_URL.split("@")[1] || process.env.PROXY_URL}`);
  } catch (e) {
    logger.warn("Invalid PROXY_URL, continuing without proxy");
  }
}

// --------------------------------------------------
// CONFIG
// --------------------------------------------------
const CFG = {
  CACHE_SEARCH_TTL: parseInt(process.env.CACHE_TTL_SEARCH) || 300,
  CACHE_DL_TTL: parseInt(process.env.CACHE_TTL_DL) || 600,
  RATE_WINDOW_MS: 15 * 60 * 1000,
  RATE_MAX: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  REQ_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT_MS) || 22000,
  MAX_REDIRECTS: 5,
  SEARCH_RETRIES: 4,
  DELAY_MIN: 1100,
  DELAY_MAX: 3600,
  DL_DELAY_MIN: 700,
  DL_DELAY_MAX: 2000,
  MEMORY_LIMIT: (parseInt(process.env.MEMORY_LIMIT_MB) || 512) * 1024 * 1024,
  MEMORY_WARN: 0.80,
  SELF_PING_MS: 9 * 60 * 1000,
  SESSION_REFRESH_MS: 2 * 60 * 60 * 1000,
  WARMUP_RETRIES: 4,
  WARMUP_DELAY: 7000,
  MAX_QUERY_LEN: 200,
  MAX_PAGE: 100,
};

// --------------------------------------------------
// CACHES
// --------------------------------------------------
const searchCache = new NodeCache({ stdTTL: CFG.CACHE_SEARCH_TTL, checkperiod: 90, useClones: false });
const dlCache = new NodeCache({ stdTTL: CFG.CACHE_DL_TTL, checkperiod: 120, useClones: false });

// --------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------
app.use(cors({ origin: "*", methods: ["GET", "OPTIONS"] }));
app.use(express.json({ limit: "1mb" }));

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Powered-By", "VOID CINEMA API");
  next();
});

const limiter = rateLimit({
  windowMs: CFG.RATE_WINDOW_MS,
  max: CFG.RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => IS_SERVERLESS,
  message: { success: false, error: "Rate limit exceeded. Try again in 15 minutes." },
});

// --------------------------------------------------
// BROWSER PROFILES
// --------------------------------------------------
const PROFILES = [
  {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  },
  {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  },
  {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  },
  {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  },
];

let profileIdx = 0;
function nextProfile() {
  return PROFILES[profileIdx++ % PROFILES.length];
}

// --------------------------------------------------
// COOKIE JAR
// --------------------------------------------------
const cookieJar = new Map([
  ["lang", "en"],
  ["oslocale", "en"],
]);

function extractCookies(res) {
  const setCookie = res?.headers?.["set-cookie"];
  if (!Array.isArray(setCookie)) return;
  setCookie.forEach(raw => {
    const pair = raw.split(";")[0];
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 1) return;
    const key = pair.slice(0, eqIdx).trim();
    const val = pair.slice(eqIdx + 1).trim();
    if (key) cookieJar.set(key, val);
  });
}

function cookieHeader() {
  const parts = [];
  cookieJar.forEach((val, key) => parts.push(key + "=" + val));
  return parts.join("; ");
}

// --------------------------------------------------
// TLS AGENT
// --------------------------------------------------
const TLS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 20,
  minVersion: "TLSv1.2",
  honorCipherOrder: true,
  ciphers: [
    "TLS_AES_128_GCM_SHA256",
    "TLS_AES_256_GCM_SHA384",
    "TLS_CHACHA20_POLY1305_SHA256",
    "ECDHE-RSA-AES128-GCM-SHA256",
    "ECDHE-ECDSA-AES128-GCM-SHA256",
    "ECDHE-RSA-AES256-GCM-SHA384",
  ].join(":"),
});

// --------------------------------------------------
// HTTP CLIENT
// --------------------------------------------------
function createClient(extraHeaders = {}) {
  const headers = { ...nextProfile(), Cookie: cookieHeader(), ...extraHeaders };
  const config = {
    timeout: CFG.REQ_TIMEOUT,
    maxRedirects: CFG.MAX_REDIRECTS,
    httpsAgent: TLS_AGENT,
    decompress: true,
    validateStatus: () => true,
    headers,
  };
  if (proxyAgent) {
    config.httpsAgent = proxyAgent;
    config.proxy = false;
  }
  return axios.create(config);
}

// --------------------------------------------------
// UTILITIES
// --------------------------------------------------
function mkErr(type, message, debug = null) {
  const e = new Error(message);
  e.type = type;
  e.debug = IS_PROD ? null : debug;
  return e;
}

function delay(min = CFG.DELAY_MIN, max = CFG.DELAY_MAX) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(r => setTimeout(r, ms));
}

function fmtBytes(b) {
  if (!b || b === 0) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(2) + " " + u[i];
}

function fmtUptime(s) {
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(Math.floor(s % 60)).padStart(2, "0");
  return `${h}:${m}:${sec}`;
}

function isHtmlBody(buf) {
  const sample = Buffer.isBuffer(buf) ? buf.subarray(0, 800).toString("utf8") : String(buf).slice(0, 800);
  return /<(html|!doctype|body|head)\b/i.test(sample);
}

// --------------------------------------------------
// PARSER (HTML search results) – hardened
// --------------------------------------------------
function parseSearchPage(html) {
  if (typeof html !== "string" || !html) return null;
  const $ = cheerio.load(html);
  if ($("#search_results").length === 0) return null;

  const results = [];
  $("#search_results tbody tr").each((_, row) => {
    try {
      const $r = $(row);
      if ($r.hasClass("head") || $r.attr("style") === "display:none" || !$r.attr("onclick")) return;

      const onclick = $r.attr("onclick") || "";
      const rowId = $r.attr("id") || "";
      const idMatch = onclick.match(/servOC\((\d+)/) || rowId.match(/name(\d+)/);
      if (!idMatch) return;
      const id = idMatch[1];

      let title = $r.find("td:first-child strong a").first().text().trim();
      if (!title) return;
      let year = null;
      const ym = title.match(/\((\d{4})\)$/);
      if (ym) {
        year = ym[1];
        title = title.replace(/\s*\(\d{4}\)$/, "").trim();
      }

      let language = "unknown";
      const flagCls = $r.find(".flag").first().attr("class") || "";
      const lm = flagCls.match(/flag\s+([a-z]{2})/);
      if (lm) language = lm[1];

      let downloads = 0;
      const dlLink = $r.find("a[href*='subtitleserve']").first();
      if (dlLink.length) downloads = parseInt(dlLink.text().replace(/[^\d]/g, ""), 10) || 0;

      const uploader = $r.find("td:last-child a").first().text().trim() || "anonymous";
      const uploadDate = $r.find("time").first().text().trim() || null;

      let filename = null;
      const spanTitle = $r.find("span[title]").first().attr("title");
      if (spanTitle && !/^\d+\s+votes?$/i.test(spanTitle)) filename = spanTitle;

      const features = {
        hd: $r.find("img[src*='hd.gif']").length > 0,
        hearingImpaired: $r.find("img[src*='hearing_impaired.gif']").length > 0,
        trusted: $r.find("img[src*='from_trusted.gif']").length > 0,
      };

      results.push({ id, title, year, language, downloads, uploader, uploadDate, filename, features });
    } catch (err) {
      logger.warn({ err }, "Skipping a row due to parsing error");
    }
  });
  return results;
}

// --------------------------------------------------
// SIMPLEXML SEARCH (fallback)
// --------------------------------------------------
async function simpleXmlSearch(query) {
  try {
    const url = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${encodeURIComponent(query)}/simplexml`;
    const client = createClient({ Accept: "application/xml" });
    const res = await client.get(url);
    if (res.status !== 200) return null;
    const $ = cheerio.load(res.data, { xmlMode: true });
    const results = [];
    $("subtitle").each((i, el) => {
      results.push({
        id: $(el).find("idsubtitle").text(),
        title: $(el).find("moviename").text() || $(el).find("releasename").text(),
        language: $(el).find("iso639").text(),
        downloads: parseInt($(el).find("subdownloads").text(), 10) || 0,
        filename: $(el).find("subfilename").text(),
        uploader: $(el).find("userusername").text(),
        uploadDate: $(el).find("subadddate").text(),
        features: {
          hd: $(el).find("subhd").text() === "1",
          hearingImpaired: $(el).find("subhearing_impaired").text() === "1",
        },
      });
    });
    return results;
  } catch (e) {
    logger.warn({ err: e }, "SimpleXML search failed");
    return null;
  }
}

// --------------------------------------------------
// SESSION WARM-UP
// --------------------------------------------------
let sessionReady = false;
let sessionWarming = false;

async function warmUpSession(attempt = 1) {
  if (sessionWarming) return;
  sessionWarming = true;
  logger.info(`Warming up session (attempt ${attempt})...`);
  const client = createClient({ "Sec-Fetch-Site": "none", "Sec-Fetch-User": "?1" });
  try {
    const res = await client.get("https://www.opensubtitles.org/en");
    extractCookies(res);
    if (res.status === 200) {
      sessionReady = true;
      logger.info(`Session ready. Cookies: ${cookieJar.size}`);
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    logger.warn(`Warm-up attempt ${attempt} failed: ${err.message}`);
    if (attempt < CFG.WARMUP_RETRIES) {
      sessionWarming = false;
      await delay(CFG.WARMUP_DELAY, CFG.WARMUP_DELAY * 1.5);
      return warmUpSession(attempt + 1);
    }
    logger.warn("Warm-up gave up.");
  } finally {
    sessionWarming = false;
  }
}

// --------------------------------------------------
// SEARCH (with fallback)
// --------------------------------------------------
function buildSearchURLs(query, page) {
  const enc = encodeURIComponent(query);
  const offset = (page - 1) * 40;
  return [
    `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${enc}/${page}`,
    `https://www.opensubtitles.org/en/search2/sublanguageid-all/moviename-${enc}/offset-${offset}/sort-7/asc-0`,
  ];
}

async function searchSubtitles(query, page = 1) {
  const cacheKey = `s:${query}:${page}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const urls = buildSearchURLs(query, page);
  let lastError = null;
  let attempt = 0;

  while (attempt < CFG.SEARCH_RETRIES) {
    const backoff = CFG.DELAY_MIN * Math.pow(1.5, attempt);
    const url = urls[attempt % urls.length];
    attempt++;
    await delay(backoff, backoff + 1400);

    try {
      const client = createClient({ Referer: "https://www.opensubtitles.org/en" });
      const res = await client.get(url);
      extractCookies(res);

      if (res.status === 403 || res.status === 429 || res.status === 503) {
        logger.warn(`Status ${res.status} on attempt ${attempt} - re-warming...`);
        lastError = mkErr("blocked", `Remote returned HTTP ${res.status}`);
        await warmUpSession();
        continue;
      }
      if (res.status !== 200) {
        lastError = mkErr("search_failed", `Remote returned HTTP ${res.status}`);
        continue;
      }
      if (typeof res.data === "string" && !res.data.includes("search_results")) {
        logger.warn(`Got homepage redirect on attempt ${attempt} - re-warming...`);
        lastError = mkErr("redirected", "OpenSubtitles redirected to homepage.");
        await warmUpSession();
        continue;
      }

      const results = parseSearchPage(res.data);
      if (!results) {
        logger.error(`Parse failed on attempt ${attempt}`);
        lastError = mkErr("parse_failed", "Could not parse results page.");
        continue;
      }

      results.sort((a, b) => b.downloads - a.downloads);
      const payload = { query, page, total: results.length, fromCache: false, results };
      searchCache.set(cacheKey, payload);
      return payload;
    } catch (err) {
      if (err.type) throw err;
      logger.error({ err }, `Network error attempt ${attempt}`);
      lastError = mkErr("network_error", `Network failed: ${err.message}`);
    }
  }

  // Fallback to SimpleXML if all attempts failed
  logger.info("Falling back to SimpleXML search for:", query);
  const fallbackResults = await simpleXmlSearch(query);
  if (fallbackResults?.length) {
    const payload = { query, page, total: fallbackResults.length, fromCache: false, results: fallbackResults };
    searchCache.set(cacheKey, payload);
    return payload;
  }

  throw lastError || mkErr("search_failed", "All search attempts exhausted.");
}

// --------------------------------------------------
// FILTER BY LANGUAGE
// --------------------------------------------------
function filterByLanguage(data, lang) {
  if (!lang || lang === "all") return data;
  const filtered = data.results.filter(r => r.language.toLowerCase() === lang.toLowerCase());
  return { ...data, language: lang, total: filtered.length, results: filtered };
}

// --------------------------------------------------
// DOWNLOAD SUBTITLE
// --------------------------------------------------
async function downloadSubtitle(id, hintFilename) {
  const cacheKey = `dl:${id}`;
  const cached = dlCache.get(cacheKey);
  if (cached) return cached;

  const urls = [
    `https://dl.opensubtitles.org/en/download/sub/${id}`,
    `https://www.opensubtitles.org/en/subtitleserve/sub/${id}`,
  ];

  for (const url of urls) {
    await delay(CFG.DL_DELAY_MIN, CFG.DL_DELAY_MAX);
    const client = createClient({
      Referer: `https://www.opensubtitles.org/en/subtitles/${id}`,
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    });
    try {
      const res = await client.get(url, { responseType: "arraybuffer" });
      extractCookies(res);
      if (res.status !== 200) continue;
      const buffer = Buffer.from(res.data);
      if (buffer.length < 16) continue;
      if (isHtmlBody(buffer)) continue;

      let ext = "srt";
      let name = hintFilename || null;
      const cd = res.headers["content-disposition"] || "";
      const cdm = cd.match(/filename[^;=\n]*=(['"]?)([^\n'"]*)\1/i);
      if (cdm?.[2]) name = path.basename(cdm[2]).replace(/[^\w.\-]/g, "_");
      if (name) {
        const parts = name.split(".");
        if (parts.length > 1) ext = parts.pop().toLowerCase();
      }
      if (!name) name = `subtitle_${id}.${ext}`;

      const result = { buffer, ext, filename: name, size: buffer.length };
      dlCache.set(cacheKey, result);
      return result;
    } catch (err) {
      logger.warn({ err }, `Download attempt failed for ${url}`);
    }
  }
  throw mkErr("download_failed", "All download sources failed.");
}

// --------------------------------------------------
// VALIDATION
// --------------------------------------------------
function validateQuery(q) {
  if (!q || typeof q !== "string") return "Missing required parameter q";
  if (!q.trim()) return "Query cannot be blank";
  if (q.trim().length > CFG.MAX_QUERY_LEN) return `Query too long (max ${CFG.MAX_QUERY_LEN} chars)`;
  return null;
}

function validatePage(str) {
  if (str === undefined || str === null) return 1;
  const n = parseInt(str, 10);
  if (isNaN(n) || n < 1 || n > CFG.MAX_PAGE) return null;
  return n;
}

function validateId(id) {
  return typeof id === "string" && /^\d{1,12}$/.test(id.trim());
}

// --------------------------------------------------
// BACKGROUND JOBS
// --------------------------------------------------
if (!IS_SERVERLESS) {
  if (NEEDS_PING) {
    setInterval(() => {
      axios.get(`${BASE_URL}/health`, { timeout: 6000 })
        .then(r => logger.info(`Self-ping ${new Date().toISOString()} -> ${r.status}`))
        .catch(e => logger.warn(`Self-ping failed: ${e.message}`));
    }, CFG.SELF_PING_MS);
  }

  setInterval(() => warmUpSession(), CFG.SESSION_REFRESH_MS);

  setInterval(() => {
    const heapUsed = process.memoryUsage().heapUsed;
    if (heapUsed > CFG.MEMORY_LIMIT * CFG.MEMORY_WARN) {
      logger.warn("Memory threshold exceeded - flushing caches");
      searchCache.flushAll();
      dlCache.flushAll();
      if (typeof global.gc === "function") global.gc();
    }
  }, 5 * 60 * 1000);
}

// --------------------------------------------------
// ROOT PAGE (Beautiful Dashboard)
// --------------------------------------------------
const ROOT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>VOID CINEMA - Subtitle Proxy API</title>
  <style>
    :root{--bg:#07090e;--surface:#0c0f18;--surface2:#111520;--border:#1a2035;--border2:#232b42;--accent:#e2ff47;--accent2:#47f4c8;--accent3:#f447a8;--muted:#3d4d6a;--muted2:#5a6e90;--text:#b8c8e0;--white:#e8eef8;--mono:"Space Mono",monospace;--sans:"Syne",sans-serif;}
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh}
    .wrap{max-width:880px;margin:0 auto;padding:64px 24px}
    h1{font-size:clamp(2.6rem,7vw,4.4rem);font-weight:800;line-height:.95;letter-spacing:-.04em;color:var(--white)}
    h1 .dim{color:var(--muted)} h1 .hi{color:var(--accent)} h1 .hi2{color:var(--accent2)}
    .badges{display:flex;flex-wrap:wrap;gap:8px;margin:32px 0}
    .badge{padding:4px 12px;border-radius:3px;border:1px solid var(--border2);color:var(--muted2);font-family:var(--mono);font-size:.62rem}
    .endpoint{background:var(--surface);border:1px solid var(--border);padding:22px;margin:10px 0}
    .method{font-family:var(--mono);font-size:.6rem;background:rgba(226,255,71,.08);color:var(--accent);padding:3px 9px;border-radius:3px}
    .url{font-family:var(--mono);font-size:.8rem;color:var(--white);margin-top:8px}
    .desc{color:var(--muted2);margin:10px 0}
    footer{margin-top:64px;border-top:1px solid var(--border);padding-top:28px;font-family:var(--mono);font-size:.6rem;color:var(--muted);text-align:center}
  </style>
</head>
<body>
<div class="wrap">
  <h1><span class="dim">VOID</span><span class="hi">.</span><br>CINEMA<br><span class="hi2">API</span></h1>
  <div class="badges">
    <span class="badge">⚡ Ultra Peak v4.1</span>
    <span class="badge">🛡️ Proxy ready</span>
    <span class="badge">📦 Compressed</span>
    <span class="badge">📊 Pino logs</span>
  </div>
  <div class="endpoint"><span class="method">GET</span><div class="url">/subtitle?action=search&q={query}&lang={lang}&page={n}</div><div class="desc">Search subtitles</div></div>
  <div class="endpoint"><span class="method">GET</span><div class="url">/subtitle?action=download&id={id}</div><div class="desc">Download subtitle file</div></div>
  <div class="endpoint"><span class="method">GET</span><div class="url">/languages?q={query}</div><div class="desc">Get available languages</div></div>
  <div class="endpoint"><span class="method">GET</span><div class="url">/stats</div><div class="desc">Server stats</div></div>
  <div class="endpoint"><span class="method">GET</span><div class="url">/health</div><div class="desc">Health check</div></div>
  <footer>Built by Munax, Jerry, Sahid Ikka – MIT License</footer>
</div>
</body>
</html>`;

// --------------------------------------------------
// ROUTES
// --------------------------------------------------
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(ROOT_HTML);
});

app.get("/languages", limiter, async (req, res) => {
  const qErr = validateQuery(req.query.q);
  if (qErr) return res.status(400).json({ success: false, error: qErr });
  try {
    const data = await searchSubtitles(req.query.q.trim());
    const languages = [...new Set(data.results.map(r => r.language))].sort();
    res.json({ success: true, query: req.query.q, fromCache: data.fromCache, count: languages.length, languages });
  } catch (e) {
    logger.error({ err: e }, "[/languages]");
    res.status(500).json({ success: false, error: e.type || "internal", message: e.message });
  }
});

app.get("/stats", (req, res) => {
  const ss = searchCache.getStats();
  const ds = dlCache.getStats();
  const mem = process.memoryUsage();
  res.json({
    success: true,
    uptime: Math.floor(process.uptime()),
    uptimeFormatted: fmtUptime(process.uptime()),
    platform: PLATFORM,
    baseUrl: BASE_URL,
    sessionReady,
    cookieCount: cookieJar.size,
    memory: { rss: fmtBytes(mem.rss), heapUsed: fmtBytes(mem.heapUsed), heapTotal: fmtBytes(mem.heapTotal) },
    cache: {
      search: { keys: searchCache.keys().length, hits: ss.hits, misses: ss.misses },
      download: { keys: dlCache.keys().length, hits: ds.hits, misses: ds.misses },
    },
    config: { searchTTL: CFG.CACHE_SEARCH_TTL, dlTTL: CFG.CACHE_DL_TTL, rateMax: CFG.RATE_MAX, retries: CFG.SEARCH_RETRIES, proxyActive: !!proxyAgent, selfPing: NEEDS_PING, serverless: IS_SERVERLESS },
    credits: { creator: "Munax", collaborator: "Jerry", codeDev: "Sahid Ikka" },
    timestamp: new Date().toISOString(),
  });
});

app.get("/subtitle", limiter, async (req, res) => {
  const { action } = req.query;
  if (action === "search") {
    const qErr = validateQuery(req.query.q);
    if (qErr) return res.status(400).json({ success: false, error: qErr });
    const page = validatePage(req.query.page);
    if (req.query.page !== undefined && page === null) {
      return res.status(400).json({ success: false, error: "Page must be between 1 and 100." });
    }
    try {
      const raw = await searchSubtitles(req.query.q.trim(), page || 1);
      const result = req.query.lang ? filterByLanguage(raw, req.query.lang.trim()) : raw;
      res.json({ success: true, data: result });
    } catch (e) {
      logger.error({ err: e }, "[/subtitle search]");
      res.status(500).json({ success: false, error: e.type || "internal", message: e.message });
    }
    return;
  }
  if (action === "download") {
    const id = req.query.id;
    if (!validateId(id)) return res.status(400).json({ success: false, error: "Invalid or missing id." });
    try {
      const file = await downloadSubtitle(id.trim(), req.query.filename);
      const mime = file.ext === "srt" ? "application/x-subrip" : "application/octet-stream";
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      res.setHeader("Content-Type", mime);
      res.setHeader("Content-Length", file.size);
      res.setHeader("X-File-Extension", file.ext);
      res.send(file.buffer);
    } catch (e) {
      logger.error({ err: e }, "[/subtitle download]");
      res.status(500).json({ success: false, error: e.type || "internal", message: e.message });
    }
    return;
  }
  res.status(400).json({ success: false, error: "Invalid action. Use search or download." });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", uptime: Math.floor(process.uptime()), platform: PLATFORM, sessionReady });
});

app.get("/favicon.ico", (req, res) => res.status(204).end());

app.use((req, res) => {
  res.status(404).json({ success: false, error: "Endpoint not found." });
});

app.use((err, req, res, next) => {
  logger.error({ err }, "Unhandled error");
  res.status(500).json({ success: false, error: "server_error" });
});

// --------------------------------------------------
// START
// --------------------------------------------------
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    logger.info("================================================");
    logger.info("  VOID CINEMA - OpenSubtitles Proxy API");
    logger.info("  Ultra Peak Edition  v4.1  by Munax + Jerry");
    logger.info("================================================");
    logger.info(`  Platform  : ${PLATFORM}`);
    logger.info(`  Port      : ${PORT}`);
    logger.info(`  Proxy     : ${proxyAgent ? "✅ ACTIVE" : "❌ OFF"}`);
    logger.info(`  Self-ping : ${NEEDS_PING ? "YES" : "OFF"}`);
    logger.info("================================================");
    warmUpSession();
  });
}

module.exports = app;
