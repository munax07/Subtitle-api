“use strict”;

// ╔══════════════════════════════════════════════════════════════════╗
// ║          VOID CINEMA — OpenSubtitles Proxy API                  ║
// ║          Ultra Peak Edition — Final Version                     ║
// ║                                                                  ║
// ║  Crafted with 🩷 by  Munax  &  Jerry                            ║
// ║  Multi-platform: Render · Koyeb · Vercel · Docker · Local       ║
// ╚══════════════════════════════════════════════════════════════════╝

const express   = require(“express”);
const axios     = require(“axios”);
const cheerio   = require(“cheerio”);
const NodeCache = require(“node-cache”);
const rateLimit = require(“express-rate-limit”);
const cors      = require(“cors”);
const https     = require(“https”);
const path      = require(“path”);
const fs        = require(“fs”);

const app  = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════════════
//  PLATFORM DETECTION
//  Supports: Render · Koyeb · Vercel · Railway · Fly.io · Local
// ═══════════════════════════════════════════════════════════════════
const PLATFORM = (() => {
if (process.env.RENDER === “true” || process.env.RENDER_EXTERNAL_URL)       return “render”;
if (process.env.KOYEB_APP_NAME    || process.env.KOYEB)                     return “koyeb”;
if (process.env.VERCEL            || process.env.VERCEL_URL)                return “vercel”;
if (process.env.RAILWAY_STATIC_URL|| process.env.RAILWAY_ENVIRONMENT)       return “railway”;
if (process.env.FLY_APP_NAME)                                               return “fly”;
return “local”;
})();

const BASE_URL = (() => {
switch (PLATFORM) {
case “render”  : return process.env.RENDER_EXTERNAL_URL   || `http://localhost:${PORT}`;
case “koyeb”   : return process.env.KOYEB_PUBLIC_DOMAIN
? `https://${process.env.KOYEB_PUBLIC_DOMAIN}`
: `https://${process.env.KOYEB_APP_NAME || "app"}.koyeb.app`;
case “vercel”  : return process.env.VERCEL_URL
? `https://${process.env.VERCEL_URL}`
: `http://localhost:${PORT}`;
case “railway” : return process.env.RAILWAY_STATIC_URL    || `http://localhost:${PORT}`;
case “fly”     : return `https://${process.env.FLY_APP_NAME}.fly.dev`;
default        : return `http://localhost:${PORT}`;
}
})();

const IS_SERVERLESS = PLATFORM === “vercel”;
const IS_PROD       = process.env.NODE_ENV === “production”;
const NEEDS_PING    = [“render”, “koyeb”, “railway”].includes(PLATFORM);

// Express trust proxy — required for accurate IP rate limiting behind load balancers
app.set(“trust proxy”, IS_SERVERLESS ? false : 1);

// ═══════════════════════════════════════════════════════════════════
//  TUNABLE CONFIG  (all overridable via environment variables)
// ═══════════════════════════════════════════════════════════════════
const CFG = Object.freeze({
CACHE_SEARCH_TTL    : parseInt(process.env.CACHE_TTL_SEARCH)    || 300,    // 5 min
CACHE_DL_TTL        : parseInt(process.env.CACHE_TTL_DL)        || 600,    // 10 min
RATE_WINDOW_MS      : 15 * 60 * 1000,                                      // 15 min window
RATE_MAX            : parseInt(process.env.RATE_LIMIT_MAX)       || 100,
REQ_TIMEOUT         : parseInt(process.env.REQUEST_TIMEOUT_MS)   || 22000,
MAX_REDIRECTS       : 5,
SEARCH_RETRIES      : 4,
DELAY_MIN_MS        : 1100,
DELAY_MAX_MS        : 3600,
DL_DELAY_MIN_MS     : 700,
DL_DELAY_MAX_MS     : 2000,
MEMORY_LIMIT        : (parseInt(process.env.MEMORY_LIMIT_MB) || 512) * 1024 * 1024,
MEMORY_WARN_RATIO   : 0.80,
SELF_PING_MS        : 9 * 60 * 1000,    // 9 min  (keeps Render/Koyeb free tier alive)
SESSION_REFRESH_MS  : 2 * 60 * 60 * 1000, // re-warm every 2 hours
WARMUP_RETRIES      : 4,
WARMUP_RETRY_DELAY  : 7000,
MAX_QUERY_LEN       : 200,
MAX_PAGE            : 100,
});

// ═══════════════════════════════════════════════════════════════════
//  CACHES
// ═══════════════════════════════════════════════════════════════════
const searchCache = new NodeCache({ stdTTL: CFG.CACHE_SEARCH_TTL, checkperiod: 90,  useClones: false });
const dlCache     = new NodeCache({ stdTTL: CFG.CACHE_DL_TTL,     checkperiod: 120, useClones: false });

// ═══════════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════
app.use(cors({
origin     : “*”,
methods    : [“GET”, “OPTIONS”],
allowedHeaders: [“Content-Type”, “Accept”],
}));
app.use(express.json({ limit: “1mb” }));

// Security headers
app.use((_req, res, next) => {
res.setHeader(“X-Content-Type-Options”, “nosniff”);
res.setHeader(“X-Frame-Options”, “DENY”);
res.setHeader(“X-Powered-By”, “VOID CINEMA API”);
next();
});

const limiter = rateLimit({
windowMs       : CFG.RATE_WINDOW_MS,
max            : CFG.RATE_MAX,
standardHeaders: true,
legacyHeaders  : false,
skip           : () => IS_SERVERLESS, // Vercel handles its own rate limiting
message        : { success: false, error: “Rate limit exceeded — try again in 15 minutes.” },
});

// ═══════════════════════════════════════════════════════════════════
//  BROWSER PROFILES  (UA + perfectly matching client-hint headers)
// ═══════════════════════════════════════════════════════════════════
const BROWSER_PROFILES = [
// Chrome 133 / Windows
{
“User-Agent”            : “Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36”,
“sec-ch-ua”             : ‘“Not(A:Brand”;v=“99”, “Google Chrome”;v=“133”, “Chromium”;v=“133”’,
“sec-ch-ua-mobile”      : “?0”,
“sec-ch-ua-platform”    : ‘“Windows”’,
“Accept”                : “text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7”,
“Accept-Language”       : “en-US,en;q=0.9”,
“Accept-Encoding”       : “gzip, deflate, br, zstd”,
“Connection”            : “keep-alive”,
“Upgrade-Insecure-Requests”: “1”,
“Sec-Fetch-Dest”        : “document”,
“Sec-Fetch-Mode”        : “navigate”,
“Sec-Fetch-Site”        : “none”,
“Sec-Fetch-User”        : “?1”,
},
// Chrome 133 / macOS
{
“User-Agent”            : “Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36”,
“sec-ch-ua”             : ‘“Not(A:Brand”;v=“99”, “Google Chrome”;v=“133”, “Chromium”;v=“133”’,
“sec-ch-ua-mobile”      : “?0”,
“sec-ch-ua-platform”    : ‘“macOS”’,
“Accept”                : “text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7”,
“Accept-Language”       : “en-US,en;q=0.9”,
“Accept-Encoding”       : “gzip, deflate, br, zstd”,
“Connection”            : “keep-alive”,
“Upgrade-Insecure-Requests”: “1”,
“Sec-Fetch-Dest”        : “document”,
“Sec-Fetch-Mode”        : “navigate”,
“Sec-Fetch-Site”        : “none”,
“Sec-Fetch-User”        : “?1”,
},
// Firefox 135 / Windows
{
“User-Agent”            : “Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0”,
“Accept”                : “text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8”,
“Accept-Language”       : “en-US,en;q=0.5”,
“Accept-Encoding”       : “gzip, deflate, br”,
“Connection”            : “keep-alive”,
“Upgrade-Insecure-Requests”: “1”,
“Sec-Fetch-Dest”        : “document”,
“Sec-Fetch-Mode”        : “navigate”,
“Sec-Fetch-Site”        : “none”,
“Sec-Fetch-User”        : “?1”,
},
// Chrome 133 / Linux
{
“User-Agent”            : “Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36”,
“sec-ch-ua”             : ‘“Not(A:Brand”;v=“99”, “Google Chrome”;v=“133”, “Chromium”;v=“133”’,
“sec-ch-ua-mobile”      : “?0”,
“sec-ch-ua-platform”    : ‘“Linux”’,
“Accept”                : “text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8”,
“Accept-Language”       : “en-US,en;q=0.9”,
“Accept-Encoding”       : “gzip, deflate, br”,
“Connection”            : “keep-alive”,
“Upgrade-Insecure-Requests”: “1”,
“Sec-Fetch-Dest”        : “document”,
“Sec-Fetch-Mode”        : “navigate”,
“Sec-Fetch-Site”        : “none”,
“Sec-Fetch-User”        : “?1”,
},
// Edge 133 / Windows
{
“User-Agent”            : “Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0”,
“sec-ch-ua”             : ‘“Not(A:Brand”;v=“99”, “Microsoft Edge”;v=“133”, “Chromium”;v=“133”’,
“sec-ch-ua-mobile”      : “?0”,
“sec-ch-ua-platform”    : ‘“Windows”’,
“Accept”                : “text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7”,
“Accept-Language”       : “en-US,en;q=0.9”,
“Accept-Encoding”       : “gzip, deflate, br”,
“Connection”            : “keep-alive”,
“Upgrade-Insecure-Requests”: “1”,
“Sec-Fetch-Dest”        : “document”,
“Sec-Fetch-Mode”        : “navigate”,
“Sec-Fetch-Site”        : “none”,
“Sec-Fetch-User”        : “?1”,
},
];

let _profileIdx = 0;
// Round-robin profile rotation for even distribution
function nextProfile() {
return BROWSER_PROFILES[_profileIdx++ % BROWSER_PROFILES.length];
}

// ═══════════════════════════════════════════════════════════════════
//  COOKIE JAR
//  Prefilled with English locale cookies so the very first request
//  never gets a Dutch/foreign language redirect.
// ═══════════════════════════════════════════════════════════════════
const cookieJar = new Map([
[“lang”,     “en”],
[“oslocale”, “en”],
]);

function extractCookies(res) {
const setCookie = res?.headers?.[“set-cookie”];
if (!Array.isArray(setCookie)) return;
setCookie.forEach((raw) => {
const [pair] = raw.split(”;”);
const eqIdx  = pair.indexOf(”=”);
if (eqIdx < 1) return;
const key = pair.slice(0, eqIdx).trim();
const val = pair.slice(eqIdx + 1).trim();
if (key) cookieJar.set(key, val);
});
}

function cookieHeader() {
return Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join(”; “);
}

// ═══════════════════════════════════════════════════════════════════
//  TLS AGENT  (curated cipher list, keepAlive for connection reuse)
// ═══════════════════════════════════════════════════════════════════
const TLS_AGENT = new https.Agent({
keepAlive       : true,
keepAliveMsecs  : 30000,
maxSockets      : 20,
minVersion      : “TLSv1.2”,
honorCipherOrder: true,
ciphers: [
“TLS_AES_128_GCM_SHA256”,
“TLS_AES_256_GCM_SHA384”,
“TLS_CHACHA20_POLY1305_SHA256”,
“ECDHE-RSA-AES128-GCM-SHA256”,
“ECDHE-ECDSA-AES128-GCM-SHA256”,
“ECDHE-RSA-AES256-GCM-SHA384”,
“ECDHE-ECDSA-AES256-GCM-SHA384”,
“ECDHE-RSA-AES128-SHA256”,
].join(”:”),
});

// ═══════════════════════════════════════════════════════════════════
//  PROXY CONFIG  (set PROXY_URL env var for residential proxy)
// ═══════════════════════════════════════════════════════════════════
const SHARED_PROXY = (() => {
if (!process.env.PROXY_URL) return false;
try {
const p = new URL(process.env.PROXY_URL);
const proxy = {
protocol: p.protocol.replace(”:”, “”),
host    : p.hostname,
port    : parseInt(p.port, 10),
};
if (p.username) {
proxy.auth = {
username: decodeURIComponent(p.username),
password: decodeURIComponent(p.password),
};
}
console.log(`🔀 Proxy active: ${p.hostname}:${p.port}`);
return proxy;
} catch {
console.warn(“⚠️  Invalid PROXY_URL — proxy disabled.”);
return false;
}
})();

// ═══════════════════════════════════════════════════════════════════
//  HTTP CLIENT FACTORY
// ═══════════════════════════════════════════════════════════════════
function createClient(extraHeaders = {}) {
return axios.create({
timeout       : CFG.REQ_TIMEOUT,
maxRedirects  : CFG.MAX_REDIRECTS,
httpsAgent    : TLS_AGENT,
proxy         : SHARED_PROXY,
decompress    : true,
validateStatus: () => true,   // never throw on any HTTP status
headers: {
…nextProfile(),
Cookie: cookieHeader(),
…extraHeaders,
},
});
}

// ═══════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════
function mkErr(type, message, debug = null) {
const e = new Error(message);
e.type  = type;
e.debug = IS_PROD ? null : debug;
return e;
}

const delay = (min = CFG.DELAY_MIN_MS, max = CFG.DELAY_MAX_MS) =>
new Promise((r) => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));

function fmtBytes(b = 0) {
if (b === 0) return “0 B”;
const u = [“B”, “KB”, “MB”, “GB”];
const i = Math.floor(Math.log(b) / Math.log(1024));
return `${(b / 1024 ** i).toFixed(2)} ${u[i]}`;
}

function fmtUptime(s) {
const h   = String(Math.floor(s / 3600)).padStart(2, “0”);
const m   = String(Math.floor((s % 3600) / 60)).padStart(2, “0”);
const sec = String(Math.floor(s % 60)).padStart(2, “0”);
return `${h}:${m}:${sec}`;
}

// Reliable HTML detection on both Buffer and string
function isHtmlBody(bufOrStr) {
const sample = Buffer.isBuffer(bufOrStr)
? bufOrStr.subarray(0, 800).toString(“utf8”)
: String(bufOrStr).slice(0, 800);
return /<(html|!doctype|body|head)\b/i.test(sample);
}

// ═══════════════════════════════════════════════════════════════════
//  HTML PARSER
// ═══════════════════════════════════════════════════════════════════
function parseSearchPage(html) {
if (typeof html !== “string” || !html) return null;
const $ = cheerio.load(html);

// Hard guard: must have the search table
if ($(”#search_results”).length === 0) return null;

const results = [];

$(”#search_results tbody tr”).each((_, row) => {
const $r = $(row);

```
// Skip header rows, hidden rows, rows without onclick (they're separators/ads)
if ($r.hasClass("head") || $r.attr("style") === "display:none" || !$r.attr("onclick")) return;

// ── ID ─────────────────────────────────────────────────────────
const idMatch =
  ($r.attr("onclick") || "").match(/servOC\((\d+)/) ||
  ($r.attr("id")      || "").match(/name(\d+)/);
if (!idMatch) return;
const id = idMatch[1];

// ── Title + Year ───────────────────────────────────────────────
let title = $r.find("td:first-child strong a").first().text().trim();
if (!title) return;
let year = null;
const ym = title.match(/\((\d{4})\)$/);
if (ym) { year = ym[1]; title = title.replace(/\s*\(\d{4}\)$/, "").trim(); }

// ── Language ───────────────────────────────────────────────────
let language = "unknown";
const lm = ($r.find(".flag").first().attr("class") || "").match(/flag\s+([a-z]{2})/);
if (lm) language = lm[1];

// ── Downloads ──────────────────────────────────────────────────
let downloads = 0;
const dlLink = $r.find('a[href*="subtitleserve"]').first();
if (dlLink.length) downloads = parseInt(dlLink.text().replace(/[^\d]/g, ""), 10) || 0;

// ── Uploader ───────────────────────────────────────────────────
const uploader = $r.find("td:last-child a").first().text().trim() || "anonymous";

// ── Upload date ────────────────────────────────────────────────
const uploadDate = $r.find("time").first().text().trim() || null;

// ── Filename ───────────────────────────────────────────────────
let filename = null;
const spanTitle = $r.find("span[title]").first().attr("title");
if (spanTitle && !/^\d+\s+votes?$/i.test(spanTitle)) filename = spanTitle;

// ── Feature flags ──────────────────────────────────────────────
const features = {
  hd             : $r.find('img[src*="hd.gif"]').length             > 0,
  hearingImpaired: $r.find('img[src*="hearing_impaired.gif"]').length > 0,
  trusted        : $r.find('img[src*="from_trusted.gif"]').length    > 0,
};

results.push({ id, title, year, language, downloads, uploader, uploadDate, filename, features });
```

});

return results;
}

// ═══════════════════════════════════════════════════════════════════
//  SESSION WARM-UP
//  Visits the English homepage to collect real Cloudflare/session
//  cookies before the first actual search.
// ═══════════════════════════════════════════════════════════════════
let sessionReady     = false;
let sessionWarmingUp = false;

async function warmUpSession(attempt = 1) {
if (sessionWarmingUp) return;
sessionWarmingUp = true;
try {
console.log(`🔥 Warming up session (attempt ${attempt})…`);
const client = createClient({ “Sec-Fetch-Site”: “none”, “Sec-Fetch-User”: “?1” });
const res    = await client.get(“https://www.opensubtitles.org/en”);
extractCookies(res);

```
if (res.status === 200) {
  sessionReady = true;
  console.log(`✅ Session ready — ${cookieJar.size} cookies collected.`);
} else {
  throw new Error(`HTTP ${res.status}`);
}
```

} catch (err) {
console.warn(`⚠️  Warm-up attempt ${attempt} failed: ${err.message}`);
if (attempt < CFG.WARMUP_RETRIES) {
sessionWarmingUp = false;
await delay(CFG.WARMUP_RETRY_DELAY, CFG.WARMUP_RETRY_DELAY * 1.6);
return warmUpSession(attempt + 1);
}
console.warn(“⚠️  Warm-up gave up — will retry on next scheduled cycle.”);
} finally {
sessionWarmingUp = false;
}
}

// ═══════════════════════════════════════════════════════════════════
//  SEARCH  —  dual URL strategy + exponential backoff retry
// ═══════════════════════════════════════════════════════════════════
function buildSearchURLs(query, page) {
const enc    = encodeURIComponent(query);
const offset = (page - 1) * 40;
return [
// Primary: standard pretty URL
`https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${enc}/${page}`,
// Fallback: search2 with explicit offset + sort by downloads desc
`https://www.opensubtitles.org/en/search2/sublanguageid-all/moviename-${enc}/offset-${offset}/sort-7/asc-0`,
];
}

async function searchSubtitles(query, page = 1) {
const cacheKey = `s:${query}:${page}`;
const cached   = searchCache.get(cacheKey);
if (cached) return { …cached, fromCache: true };

const urls      = buildSearchURLs(query, page);
let   lastError = null;

for (let attempt = 0; attempt < CFG.SEARCH_RETRIES; attempt++) {
// Exponential back-off: ~1.1s, ~1.6s, ~2.5s, ~3.7s
const backoff = CFG.DELAY_MIN_MS * Math.pow(1.5, attempt);
await delay(backoff, backoff + 1400);

```
const url    = urls[attempt % urls.length];   // alternate strategies
const client = createClient({ Referer: "https://www.opensubtitles.org/en" });

let res;
try {
  res = await client.get(url);
  extractCookies(res);
} catch (err) {
  console.error(`[search] Network error (attempt ${attempt + 1}):`, err.message);
  lastError = mkErr("network_error", `Network failed: ${err.message}`);
  continue;
}

// Blocked — re-warm session and retry
if ([403, 429, 503].includes(res.status)) {
  console.warn(`[search] Status ${res.status} on attempt ${attempt + 1} — re-warming session…`);
  lastError = mkErr("blocked", `Remote returned HTTP ${res.status}`);
  await warmUpSession();
  continue;
}

if (res.status !== 200) {
  lastError = mkErr("search_failed", `Remote returned HTTP ${res.status}`);
  break;
}

// Homepage redirect detection (Dutch page, wrong locale, etc.)
if (typeof res.data === "string" && !res.data.includes("search_results")) {
  console.warn(`[search] Got homepage/redirect on attempt ${attempt + 1} — re-warming…`);
  lastError = mkErr("redirected", "OpenSubtitles redirected to homepage. Session refreshed.");
  await warmUpSession();
  continue;
}

const results = parseSearchPage(res.data);
if (results === null) {
  console.error(`[search] Parse failed (attempt ${attempt + 1}) — likely captcha/structure change.`);
  lastError = mkErr("parse_failed", "Could not parse results page — captcha or HTML structure changed.");
  continue;
}

results.sort((a, b) => b.downloads - a.downloads);
const payload = { query, page, total: results.length, fromCache: false, results };
searchCache.set(cacheKey, payload);
return payload;
```

}

throw lastError || mkErr(“search_failed”, “All search attempts exhausted.”);
}

// ═══════════════════════════════════════════════════════════════════
//  LANGUAGE FILTER
// ═══════════════════════════════════════════════════════════════════
function filterByLanguage(data, lang) {
if (!lang || lang === “all”) return data;
const filtered = data.results.filter(
(r) => r.language.toLowerCase() === lang.toLowerCase()
);
return { …data, language: lang, total: filtered.length, results: filtered };
}

// ═══════════════════════════════════════════════════════════════════
//  DOWNLOAD
// ═══════════════════════════════════════════════════════════════════
async function downloadSubtitle(id, hintFilename = null) {
const cacheKey = `dl:${id}`;
const cached   = dlCache.get(cacheKey);
if (cached) return cached;

const urls = [
`https://dl.opensubtitles.org/en/download/sub/${id}`,
`https://www.opensubtitles.org/en/subtitleserve/sub/${id}`,
];

for (const url of urls) {
await delay(CFG.DL_DELAY_MIN_MS, CFG.DL_DELAY_MAX_MS);
const client = createClient({
Referer        : `https://www.opensubtitles.org/en/subtitles/${id}`,
“Sec-Fetch-Site”: “same-origin”,
“Sec-Fetch-Mode”: “navigate”,
“Sec-Fetch-Dest”: “document”,
});

```
let res;
try {
  res = await client.get(url, { responseType: "arraybuffer" });
  extractCookies(res);
} catch (err) {
  console.error(`[download] Fetch error (${url}):`, err.message);
  continue;
}

if (res.status !== 200) { console.warn(`[download] HTTP ${res.status} from ${url}`); continue; }

const buffer = Buffer.from(res.data);
if (buffer.length < 16) { console.warn(`[download] Tiny/empty buffer from ${url}`); continue; }
if (isHtmlBody(buffer)) { console.warn(`[download] HTML page returned from ${url} — likely captcha`); continue; }

// Determine filename + extension
let ext  = "srt";
let name = hintFilename || null;

const cd    = res.headers["content-disposition"] || "";
const cdMatch = cd.match(/filename[^;=\n]*=(['"]?)([^\n'"]*)\1/i);
if (cdMatch?.[2]) name = path.basename(cdMatch[2]).replace(/[^\w.\-]/g, "_");
if (name) {
  const parts = name.split(".");
  if (parts.length > 1) ext = parts.pop().toLowerCase();
}
if (!name) name = `subtitle_${id}.${ext}`;

const result = { buffer, ext, filename: name, size: buffer.length };
dlCache.set(cacheKey, result);
return result;
```

}

throw mkErr(“download_failed”, “All download sources failed or returned HTML.”);
}

// ═══════════════════════════════════════════════════════════════════
//  INPUT VALIDATION
// ═══════════════════════════════════════════════════════════════════
function validateQuery(q) {
if (!q || typeof q !== “string”) return “Missing required parameter ‘q’”;
if (!q.trim())                    return “Query cannot be blank”;
if (q.trim().length > CFG.MAX_QUERY_LEN) return `Query too long (max ${CFG.MAX_QUERY_LEN} chars)`;
return null;
}

function validatePage(str) {
if (str === undefined || str === null) return 1;
const n = parseInt(str, 10);
if (isNaN(n) || n < 1 || n > CFG.MAX_PAGE) return null;
return n;
}

const validateId = (id) => typeof id === “string” && /^\d{1,12}$/.test(id.trim());

// ═══════════════════════════════════════════════════════════════════
//  BACKGROUND JOBS  (skipped on serverless platforms)
// ═══════════════════════════════════════════════════════════════════
if (!IS_SERVERLESS) {
// Keep free-tier hosts from sleeping
if (NEEDS_PING) {
setInterval(async () => {
try {
const r = await axios.get(`${BASE_URL}/health`, { timeout: 6000 });
console.log(`💓 Self-ping ${new Date().toISOString()} → ${r.status}`);
} catch (e) {
console.warn(`💔 Self-ping failed: ${e.message}`);
}
}, CFG.SELF_PING_MS);
}

// Periodic session refresh
setInterval(() => warmUpSession(), CFG.SESSION_REFRESH_MS);

// Memory watchdog
setInterval(() => {
const { heapUsed } = process.memoryUsage();
if (heapUsed > CFG.MEMORY_LIMIT * CFG.MEMORY_WARN_RATIO) {
console.warn(`⚠️  Heap ${fmtBytes(heapUsed)} exceeds threshold — flushing caches`);
searchCache.flushAll();
dlCache.flushAll();
if (typeof global.gc === “function”) { global.gc(); console.log(“🧹 GC triggered”); }
}
}, 5 * 60 * 1000);
}

// ═══════════════════════════════════════════════════════════════════
//  ROOT PAGE  (inline, no external file dependency)
// ═══════════════════════════════════════════════════════════════════
const ROOT_HTML = /* html */`<!DOCTYPE html>

<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VOID CINEMA — Subtitle Proxy API</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
:root {
  --bg:       #07090e;
  --surface:  #0c0f18;
  --surface2: #111520;
  --border:   #1a2035;
  --border2:  #232b42;
  --accent:   #e2ff47;
  --accent2:  #47f4c8;
  --accent3:  #f447a8;
  --muted:    #3d4d6a;
  --muted2:   #5a6e90;
  --text:     #b8c8e0;
  --white:    #e8eef8;
  --mono:     'Space Mono', monospace;
  --sans:     'Syne', sans-serif;
  --radius:   3px;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  background: var(--bg); color: var(--text);
  font-family: var(--sans); min-height: 100vh; overflow-x: hidden;
}

/* Grid overlay */
body::before {
content: ‘’; position: fixed; inset: 0; pointer-events: none; z-index: 0;
background-image:
linear-gradient(rgba(71,244,200,.025) 1px, transparent 1px),
linear-gradient(90deg, rgba(71,244,200,.025) 1px, transparent 1px);
background-size: 52px 52px;
}

/* Ambient glows */
.glow-top {
position: fixed; top: -300px; left: 50%; transform: translateX(-50%);
width: 1000px; height: 500px; pointer-events: none; z-index: 0;
background: radial-gradient(ellipse at 50% 0%, rgba(71,244,200,.055) 0%, transparent 65%);
}
.glow-br {
position: fixed; bottom: -200px; right: -100px;
width: 600px; height: 400px; pointer-events: none; z-index: 0;
background: radial-gradient(ellipse at 80% 100%, rgba(226,255,71,.04) 0%, transparent 70%);
}

main { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 64px 24px 100px; }

/* ── HEADER ── */
header { margin-bottom: 72px; }

.eyebrow {
font-family: var(–mono); font-size: .65rem; letter-spacing: .22em;
color: var(–accent2); text-transform: uppercase;
display: flex; align-items: center; gap: 14px; margin-bottom: 24px;
}
.eyebrow::before {
content: ‘’; flex-shrink: 0; width: 36px; height: 1px; background: var(–accent2);
}

.title-block { margin-bottom: 20px; }
h1 {
font-family: var(–sans); font-weight: 800;
font-size: clamp(2.6rem, 7vw, 4.4rem);
line-height: .95; letter-spacing: -.04em; color: var(–white);
}
h1 .dim   { color: var(–muted); }
h1 .hi    { color: var(–accent); }
h1 .hi2   { color: var(–accent2); }

.tagline {
font-family: var(–mono); font-size: .78rem; line-height: 1.8;
color: var(–muted2); max-width: 460px; margin-top: 16px;
}

/* ── BADGES ── */
.badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 64px; }
.badge {
font-family: var(–mono); font-size: .62rem; letter-spacing: .08em;
padding: 4px 12px; border-radius: var(–radius);
border: 1px solid var(–border2); color: var(–muted2);
display: flex; align-items: center; gap: 7px;
transition: border-color .25s, color .25s;
}
.badge:hover { border-color: var(–border2); color: var(–text); }
.badge.live {
border-color: rgba(71,244,200,.35); color: var(–accent2);
}
.badge.live::before {
content: ‘’; width: 5px; height: 5px; border-radius: 50%;
background: var(–accent2); box-shadow: 0 0 8px var(–accent2);
animation: blink 2s ease-in-out infinite;
}
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }

/* ── SECTION ── */
.section-title {
font-family: var(–mono); font-size: .6rem; letter-spacing: .25em;
color: var(–muted); text-transform: uppercase;
padding-bottom: 12px; margin-bottom: 20px;
border-bottom: 1px solid var(–border);
display: flex; justify-content: space-between; align-items: center;
}

/* ── ENDPOINT CARDS ── */
.endpoints { display: flex; flex-direction: column; gap: 1px; margin-bottom: 64px; }
.ep {
background: var(–surface); border: 1px solid var(–border);
padding: 22px 26px; transition: background .2s, border-color .2s;
position: relative; overflow: hidden;
}
.ep::before {
content: ‘’; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
background: transparent; transition: background .2s;
}
.ep:hover { background: var(–surface2); border-color: var(–border2); }
.ep:hover::before { background: var(–accent2); }

.ep-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.method {
font-family: var(–mono); font-size: .6rem; font-weight: 700;
letter-spacing: .12em; padding: 3px 9px;
background: rgba(226,255,71,.08); color: var(–accent);
border-radius: var(–radius); flex-shrink: 0;
}
.ep-url { font-family: var(–mono); font-size: .8rem; color: var(–white); word-break: break-all; }
.ep-url .p { color: var(–accent2); }
.ep-url .opt { color: var(–muted2); }

.ep-desc { font-size: .8rem; color: var(–muted2); line-height: 1.65; margin-bottom: 12px; }

.params { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.param-tag {
font-family: var(–mono); font-size: .6rem; padding: 2px 9px;
border: 1px solid var(–border); border-radius: var(–radius); color: var(–muted2);
}
.param-tag b { color: var(–text); }
.param-tag.req { border-color: rgba(226,255,71,.2); color: rgba(226,255,71,.7); }

.try-btn {
font-family: var(–mono); font-size: .6rem; color: var(–accent2); text-decoration: none;
display: inline-flex; align-items: center; gap: 5px; opacity: .65;
transition: opacity .2s, gap .2s;
letter-spacing: .08em;
}
.try-btn:hover { opacity: 1; gap: 9px; }
.try-btn::after { content: ‘→’; }

/* ── CODE BLOCK ── */
.code-section { margin-bottom: 64px; }
pre {
background: var(–surface); border: 1px solid var(–border);
padding: 28px; overflow-x: auto; border-radius: var(–radius);
font-family: var(–mono); font-size: .72rem; line-height: 1.9; color: var(–text);
}
.ck { color: var(–muted2); }
.cs { color: var(–accent2); }
.cn { color: var(–accent); }
.cb { color: #ff9f7f; }
.cm { color: var(–muted); font-style: italic; }

/* ── CREDITS ── */
.credits {
background: var(–surface); border: 1px solid var(–border);
padding: 28px 30px; margin-bottom: 64px; border-radius: var(–radius);
position: relative; overflow: hidden;
}
.credits::before {
content: ‘’; position: absolute; inset: 0;
background: linear-gradient(135deg, rgba(244,71,168,.04) 0%, transparent 60%);
pointer-events: none;
}
.credits-title {
font-family: var(–mono); font-size: .6rem; letter-spacing: .22em;
color: var(–accent3); text-transform: uppercase; margin-bottom: 18px;
display: flex; align-items: center; gap: 10px;
}
.credits-title::before { content: ‘’; width: 20px; height: 1px; background: var(–accent3); }
.credit-row {
display: flex; align-items: center; gap: 14px; padding: 10px 0;
border-bottom: 1px solid var(–border);
}
.credit-row:last-child { border-bottom: none; }
.credit-avatar {
width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;
display: flex; align-items: center; justify-content: center;
font-family: var(–mono); font-size: .72rem; font-weight: 700;
background: var(–surface2); border: 1px solid var(–border2);
}
.credit-avatar.munax { color: var(–accent3); border-color: rgba(244,71,168,.3); }
.credit-avatar.jerry { color: var(–accent2); border-color: rgba(71,244,200,.3); }
.credit-name { font-family: var(–sans); font-size: .9rem; font-weight: 700; color: var(–white); }
.credit-role { font-family: var(–mono); font-size: .62rem; color: var(–muted2); }
.credit-heart { margin-left: auto; font-size: 1rem; }

/* ── PLATFORMS ── */
.platforms { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 64px; }
.platform-tag {
font-family: var(–mono); font-size: .62rem; padding: 5px 14px;
border: 1px solid var(–border2); border-radius: var(–radius);
color: var(–muted2); letter-spacing: .06em;
display: flex; align-items: center; gap: 7px;
}
.platform-tag.active { border-color: rgba(226,255,71,.3); color: var(–accent); }

/* ── FOOTER ── */
footer {
border-top: 1px solid var(–border); padding-top: 28px;
display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;
}
footer span { font-family: var(–mono); font-size: .6rem; color: var(–muted); }
.dot { display: inline-block; width: 3px; height: 3px; border-radius: 50%; background: var(–muted); margin: 0 8px; vertical-align: middle; }

@media(max-width:600px) {
main { padding: 40px 16px 60px; }
h1 { font-size: 2.2rem; }
}
</style>

</head>
<body>
<div class="glow-top"></div>
<div class="glow-br"></div>
<main>

  <header>
    <div class="eyebrow">OpenSubtitles Proxy Infrastructure</div>
    <div class="title-block">
      <h1>
        <span class="dim">VOID</span><span class="hi">.</span><br>
        CINEMA<br>
        <span class="hi2">API</span>
      </h1>
    </div>
    <p class="tagline">
      Session-aware subtitle proxy — multi-platform, cached,<br>
      anti-block with retry backoff and cookie persistence.
    </p>
  </header>

  <div class="badges">
    <span class="badge live">Online</span>
    <span class="badge">5 min cache</span>
    <span class="badge">Rate limited</span>
    <span class="badge">CORS enabled</span>
    <span class="badge">Session warm-up</span>
    <span class="badge">Exponential retry</span>
    <span class="badge">Cookie jar</span>
    <span class="badge">TLS optimized</span>
  </div>

  <div class="section-title">
    <span>Endpoints</span>
    <span>v4.0 · Ultra Peak Edition</span>
  </div>

  <div class="endpoints">

```
<div class="ep">
  <div class="ep-head">
    <span class="method">GET</span>
    <span class="ep-url">/subtitle?action=search&amp;<span class="p">q</span>={query}<span class="opt">&amp;lang={lang}&amp;page={n}</span></span>
  </div>
  <p class="ep-desc">Search subtitles by movie or TV show name. Returns all results sorted by download count, highest first.</p>
  <div class="params">
    <span class="param-tag req"><b>q</b> — search query</span>
    <span class="param-tag"><b>lang</b> — en · ml · fr · de · es…</span>
    <span class="param-tag"><b>page</b> — 1 – 100</span>
  </div>
  <a class="try-btn" href="/subtitle?action=search&q=inception&lang=en">Try it</a>
</div>

<div class="ep">
  <div class="ep-head">
    <span class="method">GET</span>
    <span class="ep-url">/subtitle?action=download&amp;<span class="p">id</span>={id}<span class="opt">&amp;filename={name}</span></span>
  </div>
  <p class="ep-desc">Download a subtitle file by numeric ID from search results. Returns the raw subtitle file with correct headers.</p>
  <div class="params">
    <span class="param-tag req"><b>id</b> — numeric subtitle ID</span>
    <span class="param-tag"><b>filename</b> — custom filename hint</span>
  </div>
  <a class="try-btn" href="/subtitle?action=download&id=3962439">Try it</a>
</div>

<div class="ep">
  <div class="ep-head">
    <span class="method">GET</span>
    <span class="ep-url">/languages?<span class="p">q</span>={query}</span>
  </div>
  <p class="ep-desc">Get all available language codes for a given search query.</p>
  <div class="params">
    <span class="param-tag req"><b>q</b> — search query</span>
  </div>
  <a class="try-btn" href="/languages?q=inception">Try it</a>
</div>

<div class="ep">
  <div class="ep-head">
    <span class="method">GET</span>
    <span class="ep-url">/stats</span>
  </div>
  <p class="ep-desc">Server uptime, memory usage, cache statistics, platform info, and session state.</p>
  <a class="try-btn" href="/stats">Try it</a>
</div>

<div class="ep">
  <div class="ep-head">
    <span class="method">GET</span>
    <span class="ep-url">/health</span>
  </div>
  <p class="ep-desc">Lightweight health-check used by all deployment platforms.</p>
  <a class="try-btn" href="/health">Try it</a>
</div>
```

  </div>

  <div class="section-title"><span>Example Response</span></div>
  <div class="code-section">
    <pre><span class="ck">{</span>
  <span class="cs">"success"</span><span class="ck">:</span>  <span class="cn">true</span><span class="ck">,</span>
  <span class="cs">"data"</span><span class="ck">:</span> <span class="ck">{</span>
    <span class="cs">"query"</span><span class="ck">:</span>      <span class="cb">"inception"</span><span class="ck">,</span>
    <span class="cs">"page"</span><span class="ck">:</span>       <span class="cn">1</span><span class="ck">,</span>
    <span class="cs">"total"</span><span class="ck">:</span>      <span class="cn">40</span><span class="ck">,</span>
    <span class="cs">"fromCache"</span><span class="ck">:</span>  <span class="cn">false</span><span class="ck">,</span>
    <span class="cs">"results"</span><span class="ck">: [{</span>
      <span class="cs">"id"</span><span class="ck">:</span>           <span class="cb">"3962439"</span><span class="ck">,</span>
      <span class="cs">"title"</span><span class="ck">:</span>        <span class="cb">"Inception"</span><span class="ck">,</span>
      <span class="cs">"year"</span><span class="ck">:</span>         <span class="cb">"2010"</span><span class="ck">,</span>
      <span class="cs">"language"</span><span class="ck">:</span>     <span class="cb">"en"</span><span class="ck">,</span>
      <span class="cs">"downloads"</span><span class="ck">:</span>    <span class="cn">132434</span><span class="ck">,</span>
      <span class="cs">"uploader"</span><span class="ck">:</span>     <span class="cb">"kmmt123"</span><span class="ck">,</span>
      <span class="cs">"uploadDate"</span><span class="ck">:</span>   <span class="cb">"18/11/10"</span><span class="ck">,</span>
      <span class="cs">"filename"</span><span class="ck">:</span>     <span class="cb">"Inception.2010.1080p.BluRay.x264-FGT"</span><span class="ck">,</span>
      <span class="cs">"features"</span><span class="ck">: {</span>
        <span class="cs">"hd"</span><span class="ck">:</span>                <span class="cn">true</span><span class="ck">,</span>
        <span class="cs">"hearingImpaired"</span><span class="ck">:</span>   <span class="cn">false</span><span class="ck">,</span>
        <span class="cs">"trusted"</span><span class="ck">:</span>           <span class="cn">true</span>
      <span class="ck">}</span>
    <span class="ck">}]</span>
  <span class="ck">}</span>
<span class="ck">}</span></pre>
  </div>

  <div class="section-title"><span>Platform Support</span></div>
  <div class="platforms" id="platforms">
    <span class="platform-tag" id="pt-render">● Render</span>
    <span class="platform-tag" id="pt-koyeb">● Koyeb</span>
    <span class="platform-tag" id="pt-vercel">● Vercel</span>
    <span class="platform-tag" id="pt-railway">● Railway</span>
    <span class="platform-tag" id="pt-fly">● Fly.io</span>
    <span class="platform-tag" id="pt-docker">● Docker</span>
    <span class="platform-tag" id="pt-local">● Local</span>
  </div>
  <script>
    fetch('/health').then(r=>r.json()).then(d=>{
      const pt = d.platform;
      const el = document.getElementById('pt-' + pt);
      if(el) { el.classList.add('active'); el.textContent = '▶ ' + el.textContent.slice(2) + ' (active)'; }
    }).catch(()=>{});
  </script>

  <div class="section-title"><span>Credits</span></div>
  <div class="credits">
    <div class="credits-title">Built by</div>
    <div class="credit-row">
      <div class="credit-avatar munax">M</div>
      <div>
        <div class="credit-name">Munax</div>
        <div class="credit-role">Creator · Architect · Vision</div>
      </div>
      <span class="credit-heart">🩷</span>
    </div>
    <div class="credit-row">
      <div class="credit-avatar jerry">J</div>
      <div>
        <div class="credit-name">Jerry</div>
        <div class="credit-role">Co-developer · Codebase Collaborator</div>
      </div>
      <span class="credit-heart">🤝</span>
    </div>
  </div>

  <footer>
    <span>VOID CINEMA API<span class="dot"></span>Ultra Peak Edition<span class="dot"></span>v4.0</span>
    <span>Node.js · Express · Cheerio · 🩷 Munax &amp; Jerry</span>
  </footer>

</main>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════

// ── / ────────────────────────────────────────────────────────────
app.get(”/”, (_req, res) => {
res.setHeader(“Content-Type”, “text/html; charset=utf-8”);
res.setHeader(“Cache-Control”, “public, max-age=3600”);
res.send(ROOT_HTML);
});

// ── /languages ───────────────────────────────────────────────────
app.get(”/languages”, limiter, async (req, res) => {
const qErr = validateQuery(req.query.q);
if (qErr) return res.status(400).json({ success: false, error: qErr });

try {
const data      = await searchSubtitles(req.query.q.trim());
const languages = […new Set(data.results.map((r) => r.language))].sort();
return res.json({
success  : true,
query    : req.query.q.trim(),
fromCache: data.fromCache,
count    : languages.length,
languages,
});
} catch (e) {
console.error(”[/languages]”, e.message);
return res.status(500).json({ success: false, error: e.type || “internal”, message: e.message, debug: e.debug });
}
});

// ── /stats ───────────────────────────────────────────────────────
app.get(”/stats”, (_req, res) => {
const ss  = searchCache.getStats();
const ds  = dlCache.getStats();
const mem = process.memoryUsage();
return res.json({
success        : true,
uptime         : Math.floor(process.uptime()),
uptimeFormatted: fmtUptime(process.uptime()),
platform       : PLATFORM,
baseUrl        : BASE_URL,
sessionReady,
cookieCount    : cookieJar.size,
memory: {
rss      : fmtBytes(mem.rss),
heapUsed : fmtBytes(mem.heapUsed),
heapTotal: fmtBytes(mem.heapTotal),
},
cache: {
search  : { keys: searchCache.keys().length, hits: ss.hits, misses: ss.misses },
download: { keys: dlCache.keys().length,     hits: ds.hits, misses: ds.misses },
},
config: {
searchTTL   : CFG.CACHE_SEARCH_TTL,
dlTTL       : CFG.CACHE_DL_TTL,
rateMax     : CFG.RATE_MAX,
retries     : CFG.SEARCH_RETRIES,
proxyActive : !!SHARED_PROXY,
selfPing    : NEEDS_PING,
serverless  : IS_SERVERLESS,
},
credits    : { creator: “Munax 🩷”, collaborator: “Jerry 🤝” },
timestamp  : new Date().toISOString(),
});
});

// ── /subtitle ────────────────────────────────────────────────────
app.get(”/subtitle”, limiter, async (req, res) => {
const { action } = req.query;

try {
// ── SEARCH ─────────────────────────────────────────────────
if (action === “search”) {
const qErr = validateQuery(req.query.q);
if (qErr) return res.status(400).json({ success: false, error: qErr });

```
  const page = validatePage(req.query.page);
  if (req.query.page !== undefined && page === null) {
    return res.status(400).json({ success: false, error: "Page must be between 1 and 100." });
  }

  const raw    = await searchSubtitles(req.query.q.trim(), page || 1);
  const result = req.query.lang ? filterByLanguage(raw, req.query.lang.trim()) : raw;
  return res.json({ success: true, data: result });
}

// ── DOWNLOAD ───────────────────────────────────────────────
if (action === "download") {
  const { id, filename } = req.query;
  if (!validateId(id)) {
    return res.status(400).json({ success: false, error: "Invalid or missing 'id' — must be numeric." });
  }

  const file = await downloadSubtitle(id.trim(), filename || null);
  const mime = file.ext === "srt" ? "application/x-subrip"
             : file.ext === "sub" ? "text/plain"
             : file.ext === "ass" || file.ext === "ssa" ? "text/plain"
             : "application/octet-stream";

  res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
  res.setHeader("Content-Type",         mime);
  res.setHeader("Content-Length",       file.size);
  res.setHeader("X-File-Extension",     file.ext);
  res.setHeader("X-Subtitle-ID",        id.trim());
  return res.send(file.buffer);
}

// ── UNKNOWN ACTION ─────────────────────────────────────────
return res.status(400).json({
  success: false,
  error  : "Invalid or missing 'action'. Use 'search' or 'download'.",
  usage  : {
    search  : "/subtitle?action=search&q=inception&lang=en&page=1",
    download: "/subtitle?action=download&id=3962439",
  },
});
```

} catch (e) {
console.error(”[/subtitle]”, e.message, e.type || “”);
return res.status(500).json({
success: false,
error  : e.type   || “internal”,
message: e.message || “An unexpected error occurred.”,
debug  : e.debug  || null,
});
}
});

// ── /health ──────────────────────────────────────────────────────
app.get(”/health”, (_req, res) =>
res.status(200).json({
status      : “healthy”,
uptime      : Math.floor(process.uptime()),
platform    : PLATFORM,
sessionReady,
timestamp   : new Date().toISOString(),
})
);

app.get(”/favicon.ico”, (_req, res) => res.status(204).end());

// ── 404 ──────────────────────────────────────────────────────────
app.use((_req, res) =>
res.status(404).json({
success: false,
error  : “Endpoint not found.”,
hint   : “Visit / for full API documentation.”,
})
);

// ── Global error handler ─────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
console.error(”[Unhandled]”, err);
res.status(500).json({ success: false, error: “server_error”, message: “An unexpected error occurred.” });
});

// ═══════════════════════════════════════════════════════════════════
//  VERCEL EXPORT  (serverless function handler)
// ═══════════════════════════════════════════════════════════════════
module.exports = app;          // Required for Vercel

// ═══════════════════════════════════════════════════════════════════
//  START  (skipped when imported by Vercel serverless runtime)
// ═══════════════════════════════════════════════════════════════════
if (require.main === module) {
app.listen(PORT, async () => {
console.log(””);
console.log(“╔══════════════════════════════════════════════════════════╗”);
console.log(“║         VOID CINEMA — OpenSubtitles Proxy API            ║”);
console.log(“║         Ultra Peak Edition  ·  v4.0 Final                ║”);
console.log(“║         🩷 Munax  &  Jerry 🤝                            ║”);
console.log(“╠══════════════════════════════════════════════════════════╣”);
console.log(`║  Platform   : ${PLATFORM.padEnd(42)}║`);
console.log(`║  Port       : ${String(PORT).padEnd(42)}║`);
console.log(`║  Base URL   : ${BASE_URL.padEnd(42)}║`);
console.log(`║  Cache TTL  : search=${CFG.CACHE_SEARCH_TTL}s  download=${CFG.CACHE_DL_TTL}s${"".padEnd(20)}║`);
console.log(`║  Rate limit : ${CFG.RATE_MAX} req / 15 min per IP${"".padEnd(22)}║`);
console.log(`║  Retries    : ${CFG.SEARCH_RETRIES} with exponential backoff${"".padEnd(23)}║`);
console.log(`║  Self-ping  : ${NEEDS_PING ? "YES (free tier keepalive)" : "OFF"}${"".padEnd(NEEDS_PING ? 17 : 24)}║`);
console.log(`║  Proxy      : ${SHARED_PROXY ? "ACTIVE" : "off"}${"".padEnd(SHARED_PROXY ? 36 : 39)}║`);
console.log(“╚══════════════════════════════════════════════════════════╝”);
console.log(””);

```
// Warm up session immediately on boot
await warmUpSession();
```

});
}
