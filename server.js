const express   = require(“express”);
const axios     = require(“axios”);
const cheerio   = require(“cheerio”);
const NodeCache = require(“node-cache”);
const rateLimit = require(“express-rate-limit”);
const cors      = require(“cors”);
const https     = require(“https”);
const path      = require(“path”);

const app  = express();
const PORT = process.env.PORT || 3000;

// —————————————————––
// PLATFORM DETECTION
// —————————————————––
const PLATFORM = (function() {
if (process.env.RENDER === “true” || process.env.RENDER_EXTERNAL_URL) return “render”;
if (process.env.KOYEB_APP_NAME    || process.env.KOYEB)               return “koyeb”;
if (process.env.VERCEL            || process.env.VERCEL_URL)           return “vercel”;
if (process.env.RAILWAY_STATIC_URL|| process.env.RAILWAY_ENVIRONMENT)  return “railway”;
if (process.env.FLY_APP_NAME)                                          return “fly”;
return “local”;
}());

const BASE_URL = (function() {
if (PLATFORM === “render”)   return process.env.RENDER_EXTERNAL_URL   || (“http://localhost:” + PORT);
if (PLATFORM === “koyeb”)    return “https://” + (process.env.KOYEB_PUBLIC_DOMAIN || (process.env.KOYEB_APP_NAME || “app”) + “.koyeb.app”);
if (PLATFORM === “vercel”)   return process.env.VERCEL_URL ? (“https://” + process.env.VERCEL_URL) : (“http://localhost:” + PORT);
if (PLATFORM === “railway”)  return process.env.RAILWAY_STATIC_URL    || (“http://localhost:” + PORT);
if (PLATFORM === “fly”)      return “https://” + process.env.FLY_APP_NAME + “.fly.dev”;
return “http://localhost:” + PORT;
}());

const IS_SERVERLESS = PLATFORM === “vercel”;
const IS_PROD       = process.env.NODE_ENV === “production”;
const NEEDS_PING    = (PLATFORM === “render” || PLATFORM === “koyeb” || PLATFORM === “railway”);

app.set(“trust proxy”, IS_SERVERLESS ? false : 1);

// —————————————————––
// CONFIG
// —————————————————––
var CFG = {
CACHE_SEARCH_TTL   : parseInt(process.env.CACHE_TTL_SEARCH)    || 300,
CACHE_DL_TTL       : parseInt(process.env.CACHE_TTL_DL)        || 600,
RATE_WINDOW_MS     : 15 * 60 * 1000,
RATE_MAX           : parseInt(process.env.RATE_LIMIT_MAX)       || 100,
REQ_TIMEOUT        : parseInt(process.env.REQUEST_TIMEOUT_MS)   || 22000,
MAX_REDIRECTS      : 5,
SEARCH_RETRIES     : 4,
DELAY_MIN          : 1100,
DELAY_MAX          : 3600,
DL_DELAY_MIN       : 700,
DL_DELAY_MAX       : 2000,
MEMORY_LIMIT       : (parseInt(process.env.MEMORY_LIMIT_MB) || 512) * 1024 * 1024,
MEMORY_WARN        : 0.80,
SELF_PING_MS       : 9 * 60 * 1000,
SESSION_REFRESH_MS : 2 * 60 * 60 * 1000,
WARMUP_RETRIES     : 4,
WARMUP_DELAY       : 7000,
MAX_QUERY_LEN      : 200,
MAX_PAGE           : 100,
};

// —————————————————––
// CACHES
// —————————————————––
var searchCache = new NodeCache({ stdTTL: CFG.CACHE_SEARCH_TTL, checkperiod: 90,  useClones: false });
var dlCache     = new NodeCache({ stdTTL: CFG.CACHE_DL_TTL,     checkperiod: 120, useClones: false });

// —————————————————––
// MIDDLEWARE
// —————————————————––
app.use(cors({ origin: “*”, methods: [“GET”, “OPTIONS”] }));
app.use(express.json({ limit: “1mb” }));

app.use(function(_req, res, next) {
res.setHeader(“X-Content-Type-Options”, “nosniff”);
res.setHeader(“X-Frame-Options”, “DENY”);
res.setHeader(“X-Powered-By”, “VOID CINEMA API”);
next();
});

var limiter = rateLimit({
windowMs       : CFG.RATE_WINDOW_MS,
max            : CFG.RATE_MAX,
standardHeaders: true,
legacyHeaders  : false,
skip           : function() { return IS_SERVERLESS; },
message        : { success: false, error: “Rate limit exceeded. Try again in 15 minutes.” },
});

// —————————————————––
// BROWSER PROFILES
// —————————————————––
var PROFILES = [
{
“User-Agent”            : “Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36”,
“sec-ch-ua”             : ‘“Not(A:Brand”;v=“99”, “Google Chrome”;v=“133”, “Chromium”;v=“133”’,
“sec-ch-ua-mobile”      : “?0”,
“sec-ch-ua-platform”    : ‘“Windows”’,
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
{
“User-Agent”            : “Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36”,
“sec-ch-ua”             : ‘“Not(A:Brand”;v=“99”, “Google Chrome”;v=“133”, “Chromium”;v=“133”’,
“sec-ch-ua-mobile”      : “?0”,
“sec-ch-ua-platform”    : ‘“macOS”’,
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
];

var profileIdx = 0;
function nextProfile() {
return PROFILES[profileIdx++ % PROFILES.length];
}

// —————————————————––
// COOKIE JAR
// —————————————————––
var cookieJar = new Map([
[“lang”,     “en”],
[“oslocale”, “en”],
]);

function extractCookies(res) {
var setCookie = res && res.headers && res.headers[“set-cookie”];
if (!Array.isArray(setCookie)) return;
setCookie.forEach(function(raw) {
var pair  = raw.split(”;”)[0];
var eqIdx = pair.indexOf(”=”);
if (eqIdx < 1) return;
var key = pair.slice(0, eqIdx).trim();
var val = pair.slice(eqIdx + 1).trim();
if (key) cookieJar.set(key, val);
});
}

function cookieHeader() {
var parts = [];
cookieJar.forEach(function(val, key) { parts.push(key + “=” + val); });
return parts.join(”; “);
}

// —————————————————––
// TLS AGENT
// —————————————————––
var TLS_AGENT = new https.Agent({
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
].join(”:”),
});

// —————————————————––
// PROXY
// —————————————————––
var SHARED_PROXY = false;
if (process.env.PROXY_URL) {
try {
var pu = new URL(process.env.PROXY_URL);
SHARED_PROXY = { protocol: pu.protocol.replace(”:”, “”), host: pu.hostname, port: parseInt(pu.port, 10) };
if (pu.username) SHARED_PROXY.auth = { username: decodeURIComponent(pu.username), password: decodeURIComponent(pu.password) };
console.log(“Proxy active: “ + pu.hostname + “:” + pu.port);
} catch(e) {
console.warn(“Invalid PROXY_URL”);
}
}

// —————————————————––
// HTTP CLIENT
// —————————————————––
function createClient(extraHeaders) {
var headers = Object.assign({}, nextProfile(), { Cookie: cookieHeader() }, extraHeaders || {});
return axios.create({
timeout       : CFG.REQ_TIMEOUT,
maxRedirects  : CFG.MAX_REDIRECTS,
httpsAgent    : TLS_AGENT,
proxy         : SHARED_PROXY,
decompress    : true,
validateStatus: function() { return true; },
headers       : headers,
});
}

// —————————————————––
// UTILITIES
// —————————————————––
function mkErr(type, message, debug) {
var e  = new Error(message);
e.type = type;
e.debug = IS_PROD ? null : (debug || null);
return e;
}

function delay(min, max) {
var ms = Math.floor(Math.random() * ((max || CFG.DELAY_MAX) - (min || CFG.DELAY_MIN) + 1)) + (min || CFG.DELAY_MIN);
return new Promise(function(r) { setTimeout(r, ms); });
}

function fmtBytes(b) {
if (!b || b === 0) return “0 B”;
var u = [“B”,“KB”,“MB”,“GB”];
var i = Math.floor(Math.log(b) / Math.log(1024));
return (b / Math.pow(1024, i)).toFixed(2) + “ “ + u[i];
}

function fmtUptime(s) {
var h   = String(Math.floor(s / 3600)).padStart(2, “0”);
var m   = String(Math.floor((s % 3600) / 60)).padStart(2, “0”);
var sec = String(Math.floor(s % 60)).padStart(2, “0”);
return h + “:” + m + “:” + sec;
}

function isHtmlBody(buf) {
var sample = Buffer.isBuffer(buf) ? buf.subarray(0, 800).toString(“utf8”) : String(buf).slice(0, 800);
return /<(html|!doctype|body|head)\b/i.test(sample);
}

// —————————————————––
// PARSER
// —————————————————––
function parseSearchPage(html) {
if (typeof html !== “string” || !html) return null;
var $ = cheerio.load(html);
if ($(”#search_results”).length === 0) return null;

var results = [];
$(”#search_results tbody tr”).each(function(_, row) {
var $r = $(row);
if ($r.hasClass(“head”) || $r.attr(“style”) === “display:none” || !$r.attr(“onclick”)) return;

```
var onclick  = $r.attr("onclick") || "";
var rowId    = $r.attr("id")      || "";
var idMatch  = onclick.match(/servOC\((\d+)/) || rowId.match(/name(\d+)/);
if (!idMatch) return;
var id = idMatch[1];

var title   = $r.find("td:first-child strong a").first().text().trim();
if (!title) return;
var year    = null;
var ym      = title.match(/\((\d{4})\)$/);
if (ym) { year = ym[1]; title = title.replace(/\s*\(\d{4}\)$/, "").trim(); }

var language = "unknown";
var flagCls  = ($r.find(".flag").first().attr("class") || "");
var lm       = flagCls.match(/flag\s+([a-z]{2})/);
if (lm) language = lm[1];

var downloads = 0;
var dlLink    = $r.find("a[href*='subtitleserve']").first();
if (dlLink.length) downloads = parseInt(dlLink.text().replace(/[^\d]/g, ""), 10) || 0;

var uploader   = $r.find("td:last-child a").first().text().trim() || "anonymous";
var uploadDate = $r.find("time").first().text().trim() || null;

var filename   = null;
var spanTitle  = $r.find("span[title]").first().attr("title");
if (spanTitle && !/^\d+\s+votes?$/i.test(spanTitle)) filename = spanTitle;

var features = {
  hd             : $r.find("img[src*='hd.gif']").length             > 0,
  hearingImpaired: $r.find("img[src*='hearing_impaired.gif']").length > 0,
  trusted        : $r.find("img[src*='from_trusted.gif']").length    > 0,
};

results.push({ id: id, title: title, year: year, language: language, downloads: downloads, uploader: uploader, uploadDate: uploadDate, filename: filename, features: features });
```

});

return results;
}

// —————————————————––
// SESSION WARM-UP
// —————————————————––
var sessionReady     = false;
var sessionWarming   = false;

function warmUpSession(attempt) {
attempt = attempt || 1;
if (sessionWarming) return Promise.resolve();
sessionWarming = true;
console.log(“Warming up session (attempt “ + attempt + “)…”);

var client = createClient({ “Sec-Fetch-Site”: “none”, “Sec-Fetch-User”: “?1” });
return client.get(“https://www.opensubtitles.org/en”)
.then(function(res) {
extractCookies(res);
if (res.status === 200) {
sessionReady = true;
console.log(“Session ready. Cookies: “ + cookieJar.size);
} else {
throw new Error(“HTTP “ + res.status);
}
})
.catch(function(err) {
console.warn(“Warm-up attempt “ + attempt + “ failed: “ + err.message);
if (attempt < CFG.WARMUP_RETRIES) {
sessionWarming = false;
return delay(CFG.WARMUP_DELAY, CFG.WARMUP_DELAY * 1.5).then(function() {
return warmUpSession(attempt + 1);
});
}
console.warn(“Warm-up gave up.”);
})
.finally(function() {
sessionWarming = false;
});
}

// —————————————————––
// SEARCH
// —————————————————––
function buildSearchURLs(query, page) {
var enc    = encodeURIComponent(query);
var offset = (page - 1) * 40;
return [
“https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-” + enc + “/” + page,
“https://www.opensubtitles.org/en/search2/sublanguageid-all/moviename-” + enc + “/offset-” + offset + “/sort-7/asc-0”,
];
}

function searchSubtitles(query, page) {
page = page || 1;
var cacheKey = “s:” + query + “:” + page;
var cached   = searchCache.get(cacheKey);
if (cached) return Promise.resolve(Object.assign({}, cached, { fromCache: true }));

var urls      = buildSearchURLs(query, page);
var lastError = null;
var attempt   = 0;

function attempt_() {
if (attempt >= CFG.SEARCH_RETRIES) {
return Promise.reject(lastError || mkErr(“search_failed”, “All search attempts exhausted.”));
}
var backoff = CFG.DELAY_MIN * Math.pow(1.5, attempt);
var url     = urls[attempt % urls.length];
attempt++;

```
return delay(backoff, backoff + 1400)
  .then(function() {
    var client = createClient({ Referer: "https://www.opensubtitles.org/en" });
    return client.get(url);
  })
  .then(function(res) {
    extractCookies(res);

    if (res.status === 403 || res.status === 429 || res.status === 503) {
      console.warn("Status " + res.status + " on attempt " + attempt + " - re-warming...");
      lastError = mkErr("blocked", "Remote returned HTTP " + res.status);
      return warmUpSession().then(attempt_);
    }

    if (res.status !== 200) {
      lastError = mkErr("search_failed", "Remote returned HTTP " + res.status);
      return attempt_();
    }

    if (typeof res.data === "string" && res.data.indexOf("search_results") === -1) {
      console.warn("Got homepage redirect on attempt " + attempt + " - re-warming...");
      lastError = mkErr("redirected", "OpenSubtitles redirected to homepage.");
      return warmUpSession().then(attempt_);
    }

    var results = parseSearchPage(res.data);
    if (results === null) {
      console.error("Parse failed on attempt " + attempt);
      lastError = mkErr("parse_failed", "Could not parse results page.");
      return attempt_();
    }

    results.sort(function(a, b) { return b.downloads - a.downloads; });
    var payload = { query: query, page: page, total: results.length, fromCache: false, results: results };
    searchCache.set(cacheKey, payload);
    return payload;
  })
  .catch(function(err) {
    if (err.type) return Promise.reject(err);
    console.error("Network error attempt " + attempt + ": " + err.message);
    lastError = mkErr("network_error", "Network failed: " + err.message);
    return attempt_();
  });
```

}

return attempt_();
}

// —————————————————––
// FILTER
// —————————————————––
function filterByLanguage(data, lang) {
if (!lang || lang === “all”) return data;
var filtered = data.results.filter(function(r) {
return r.language.toLowerCase() === lang.toLowerCase();
});
return Object.assign({}, data, { language: lang, total: filtered.length, results: filtered });
}

// —————————————————––
// DOWNLOAD
// —————————————————––
function downloadSubtitle(id, hintFilename) {
var cacheKey = “dl:” + id;
var cached   = dlCache.get(cacheKey);
if (cached) return Promise.resolve(cached);

var urls = [
“https://dl.opensubtitles.org/en/download/sub/” + id,
“https://www.opensubtitles.org/en/subtitleserve/sub/” + id,
];

var idx = 0;
function tryNext() {
if (idx >= urls.length) return Promise.reject(mkErr(“download_failed”, “All download sources failed.”));
var url    = urls[idx++];
var client = createClient({
Referer         : “https://www.opensubtitles.org/en/subtitles/” + id,
“Sec-Fetch-Site”: “same-origin”,
“Sec-Fetch-Mode”: “navigate”,
“Sec-Fetch-Dest”: “document”,
});

```
return delay(CFG.DL_DELAY_MIN, CFG.DL_DELAY_MAX)
  .then(function() { return client.get(url, { responseType: "arraybuffer" }); })
  .then(function(res) {
    extractCookies(res);
    if (res.status !== 200) return tryNext();
    var buffer = Buffer.from(res.data);
    if (buffer.length < 16) return tryNext();
    if (isHtmlBody(buffer)) return tryNext();

    var ext  = "srt";
    var name = hintFilename || null;
    var cd   = res.headers["content-disposition"] || "";
    var cdm  = cd.match(/filename[^;=\n]*=(['"]?)([^\n'"]*)\1/i);
    if (cdm && cdm[2]) name = path.basename(cdm[2]).replace(/[^\w.\-]/g, "_");
    if (name) {
      var parts = name.split(".");
      if (parts.length > 1) ext = parts.pop().toLowerCase();
    }
    if (!name) name = "subtitle_" + id + "." + ext;

    var result = { buffer: buffer, ext: ext, filename: name, size: buffer.length };
    dlCache.set(cacheKey, result);
    return result;
  })
  .catch(function() { return tryNext(); });
```

}

return tryNext();
}

// —————————————————––
// VALIDATION
// —————————————————––
function validateQuery(q) {
if (!q || typeof q !== “string”)      return “Missing required parameter q”;
if (!q.trim())                         return “Query cannot be blank”;
if (q.trim().length > CFG.MAX_QUERY_LEN) return “Query too long (max “ + CFG.MAX_QUERY_LEN + “ chars)”;
return null;
}

function validatePage(str) {
if (str === undefined || str === null) return 1;
var n = parseInt(str, 10);
if (isNaN(n) || n < 1 || n > CFG.MAX_PAGE) return null;
return n;
}

function validateId(id) {
return typeof id === “string” && /^\d{1,12}$/.test(id.trim());
}

// —————————————————––
// BACKGROUND JOBS
// —————————————————––
if (!IS_SERVERLESS) {
if (NEEDS_PING) {
setInterval(function() {
axios.get(BASE_URL + “/health”, { timeout: 6000 })
.then(function(r) { console.log(“Self-ping “ + new Date().toISOString() + “ -> “ + r.status); })
.catch(function(e) { console.warn(“Self-ping failed: “ + e.message); });
}, CFG.SELF_PING_MS);
}

setInterval(function() { warmUpSession(); }, CFG.SESSION_REFRESH_MS);

setInterval(function() {
var heapUsed = process.memoryUsage().heapUsed;
if (heapUsed > CFG.MEMORY_LIMIT * CFG.MEMORY_WARN) {
console.warn(“Memory threshold exceeded - flushing caches”);
searchCache.flushAll();
dlCache.flushAll();
if (typeof global.gc === “function”) { global.gc(); }
}
}, 5 * 60 * 1000);
}

// —————————————————––
// ROOT PAGE
// —————————————————––
var ROOT_HTML = [
‘<!DOCTYPE html>’,
‘<html lang="en">’,
‘<head>’,
‘<meta charset="UTF-8">’,
‘<meta name="viewport" content="width=device-width,initial-scale=1">’,
‘<title>VOID CINEMA - Subtitle Proxy API</title>’,
‘<link rel="preconnect" href="https://fonts.googleapis.com">’,
‘<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">’,
‘<style>’,
‘:root{–bg:#07090e;–surface:#0c0f18;–surface2:#111520;–border:#1a2035;–border2:#232b42;–accent:#e2ff47;–accent2:#47f4c8;–accent3:#f447a8;–muted:#3d4d6a;–muted2:#5a6e90;–text:#b8c8e0;–white:#e8eef8;–mono:“Space Mono”,monospace;–sans:“Syne”,sans-serif;}’,
‘*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}’,
‘html{scroll-behavior:smooth}’,
‘body{background:var(–bg);color:var(–text);font-family:var(–sans);min-height:100vh;overflow-x:hidden}’,
‘body::before{content:””;position:fixed;inset:0;pointer-events:none;z-index:0;background-image:linear-gradient(rgba(71,244,200,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(71,244,200,.025) 1px,transparent 1px);background-size:52px 52px}’,
‘.glow{position:fixed;top:-300px;left:50%;transform:translateX(-50%);width:1000px;height:500px;pointer-events:none;z-index:0;background:radial-gradient(ellipse at 50% 0%,rgba(71,244,200,.055) 0%,transparent 65%)}’,
‘main{position:relative;z-index:1;max-width:880px;margin:0 auto;padding:64px 24px 100px}’,
‘header{margin-bottom:72px}’,
‘.eyebrow{font-family:var(–mono);font-size:.65rem;letter-spacing:.22em;color:var(–accent2);text-transform:uppercase;display:flex;align-items:center;gap:14px;margin-bottom:24px}’,
‘.eyebrow::before{content:””;flex-shrink:0;width:36px;height:1px;background:var(–accent2)}’,
‘h1{font-family:var(–sans);font-weight:800;font-size:clamp(2.6rem,7vw,4.4rem);line-height:.95;letter-spacing:-.04em;color:var(–white)}’,
‘h1 .dim{color:var(–muted)} h1 .hi{color:var(–accent)} h1 .hi2{color:var(–accent2)}’,
‘.tagline{font-family:var(–mono);font-size:.78rem;line-height:1.8;color:var(–muted2);max-width:460px;margin-top:16px}’,
‘.badges{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:64px}’,
‘.badge{font-family:var(–mono);font-size:.62rem;letter-spacing:.08em;padding:4px 12px;border-radius:3px;border:1px solid var(–border2);color:var(–muted2);display:flex;align-items:center;gap:7px}’,
‘.badge.live{border-color:rgba(71,244,200,.35);color:var(–accent2)}’,
‘.badge.live::before{content:””;width:5px;height:5px;border-radius:50%;background:var(–accent2);box-shadow:0 0 8px var(–accent2);animation:blink 2s ease-in-out infinite}’,
‘@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}’,
‘.section-title{font-family:var(–mono);font-size:.6rem;letter-spacing:.25em;color:var(–muted);text-transform:uppercase;padding-bottom:12px;margin-bottom:20px;border-bottom:1px solid var(–border)}’,
‘.endpoints{display:flex;flex-direction:column;gap:1px;margin-bottom:64px}’,
‘.ep{background:var(–surface);border:1px solid var(–border);padding:22px 26px;transition:background .2s,border-color .2s;position:relative;overflow:hidden}’,
‘.ep::before{content:””;position:absolute;left:0;top:0;bottom:0;width:2px;background:transparent;transition:background .2s}’,
‘.ep:hover{background:var(–surface2);border-color:var(–border2)} .ep:hover::before{background:var(–accent2)}’,
‘.ep-head{display:flex;align-items:baseline;gap:12px;margin-bottom:10px;flex-wrap:wrap}’,
‘.method{font-family:var(–mono);font-size:.6rem;font-weight:700;letter-spacing:.12em;padding:3px 9px;background:rgba(226,255,71,.08);color:var(–accent);border-radius:3px;flex-shrink:0}’,
‘.ep-url{font-family:var(–mono);font-size:.8rem;color:var(–white);word-break:break-all}’,
‘.ep-url .p{color:var(–accent2)} .ep-url .opt{color:var(–muted2)}’,
‘.ep-desc{font-size:.8rem;color:var(–muted2);line-height:1.65;margin-bottom:12px}’,
‘.params{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}’,
‘.pt{font-family:var(–mono);font-size:.6rem;padding:2px 9px;border:1px solid var(–border);border-radius:3px;color:var(–muted2)}’,
‘.pt b{color:var(–text)} .pt.req{border-color:rgba(226,255,71,.2);color:rgba(226,255,71,.7)}’,
‘.try{font-family:var(–mono);font-size:.6rem;color:var(–accent2);text-decoration:none;display:inline-flex;align-items:center;gap:5px;opacity:.65;transition:opacity .2s,gap .2s}’,
‘.try:hover{opacity:1;gap:9px} .try::after{content:”->”}’,
‘pre{background:var(–surface);border:1px solid var(–border);padding:28px;overflow-x:auto;border-radius:3px;font-family:var(–mono);font-size:.72rem;line-height:1.9;color:var(–text);margin-bottom:64px}’,
‘.ck{color:var(–muted2)} .cs{color:var(–accent2)} .cn{color:var(–accent)} .cb{color:#ff9f7f}’,
‘.credits{background:var(–surface);border:1px solid var(–border);padding:28px 30px;margin-bottom:64px;border-radius:3px}’,
‘.credits-title{font-family:var(–mono);font-size:.6rem;letter-spacing:.22em;color:var(–accent3);text-transform:uppercase;margin-bottom:18px;display:flex;align-items:center;gap:10px}’,
‘.credits-title::before{content:””;width:20px;height:1px;background:var(–accent3)}’,
‘.credit-row{display:flex;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid var(–border)}’,
‘.credit-row:last-child{border-bottom:none}’,
‘.credit-avatar{width:34px;height:34px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-family:var(–mono);font-size:.72rem;font-weight:700;background:var(–surface2);border:1px solid var(–border2)}’,
‘.credit-avatar.munax{color:var(–accent3);border-color:rgba(244,71,168,.3)}’,
‘.credit-avatar.jerry{color:var(–accent2);border-color:rgba(71,244,200,.3)}’,
‘.credit-avatar.sahid{color:#ffb347;border-color:rgba(255,179,71,.3)}’,
‘.credit-name{font-family:var(–sans);font-size:.9rem;font-weight:700;color:var(–white)}’,
‘.credit-role{font-family:var(–mono);font-size:.62rem;color:var(–muted2)}’,
‘.credit-heart{margin-left:auto;font-size:1rem}’,
‘footer{border-top:1px solid var(–border);padding-top:28px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}’,
‘footer span{font-family:var(–mono);font-size:.6rem;color:var(–muted)}’,
‘</style>’,
‘</head>’,
‘<body>’,
‘<div class="glow"></div>’,
‘<main>’,
‘<header>’,
‘<div class="eyebrow">OpenSubtitles Proxy Infrastructure</div>’,
‘<h1><span class="dim">VOID</span><span class="hi">.</span><br>CINEMA<br><span class="hi2">API</span></h1>’,
‘<p class="tagline">Session-aware subtitle proxy. Multi-platform, cached, anti-block with retry backoff.</p>’,
‘</header>’,
‘<div class="badges">’,
‘<span class="badge live">Online</span>’,
‘<span class="badge">5 min cache</span>’,
‘<span class="badge">Rate limited</span>’,
‘<span class="badge">CORS enabled</span>’,
‘<span class="badge">Session warm-up</span>’,
‘<span class="badge">Exponential retry</span>’,
‘<span class="badge">Cookie jar</span>’,
‘<span class="badge">TLS optimized</span>’,
‘</div>’,
‘<div class="section-title">Endpoints</div>’,
‘<div class="endpoints">’,
‘<div class="ep"><div class="ep-head"><span class="method">GET</span><span class="ep-url">/subtitle?action=search&<span class="p">q</span>={query}<span class="opt">&lang={lang}&page={n}</span></span></div><p class="ep-desc">Search subtitles by movie or TV show name. Sorted by downloads.</p><div class="params"><span class="pt req"><b>q</b> - search query</span><span class="pt"><b>lang</b> en / ml / fr …</span><span class="pt"><b>page</b> 1-100</span></div><a class="try" href="/subtitle?action=search&q=inception&lang=en">Try it</a></div>’,
‘<div class="ep"><div class="ep-head"><span class="method">GET</span><span class="ep-url">/subtitle?action=download&<span class="p">id</span>={id}</span></div><p class="ep-desc">Download a subtitle file by numeric ID from search results.</p><div class="params"><span class="pt req"><b>id</b> - numeric subtitle ID</span><span class="pt"><b>filename</b> - optional hint</span></div><a class="try" href="/subtitle?action=download&id=3962439">Try it</a></div>’,
‘<div class="ep"><div class="ep-head"><span class="method">GET</span><span class="ep-url">/languages?<span class="p">q</span>={query}</span></div><p class="ep-desc">Get all available language codes for a search query.</p><a class="try" href="/languages?q=inception">Try it</a></div>’,
‘<div class="ep"><div class="ep-head"><span class="method">GET</span><span class="ep-url">/stats</span></div><p class="ep-desc">Server uptime, memory, cache stats, and session state.</p><a class="try" href="/stats">Try it</a></div>’,
‘<div class="ep"><div class="ep-head"><span class="method">GET</span><span class="ep-url">/health</span></div><p class="ep-desc">Lightweight health check for deployment platforms.</p><a class="try" href="/health">Try it</a></div>’,
‘</div>’,
‘<div class="section-title">Example Response</div>’,
‘<pre><span class="ck">{</span>\n  <span class="cs">“success”</span><span class="ck">:</span> <span class="cn">true</span><span class="ck">,</span>\n  <span class="cs">“data”</span><span class="ck">:</span> <span class="ck">{</span>\n    <span class="cs">“query”</span><span class="ck">:</span>     <span class="cb">“inception”</span><span class="ck">,</span>\n    <span class="cs">“total”</span><span class="ck">:</span>     <span class="cn">40</span><span class="ck">,</span>\n    <span class="cs">“fromCache”</span><span class="ck">:</span> <span class="cn">false</span><span class="ck">,</span>\n    <span class="cs">“results”</span><span class="ck">: [{</span>\n      <span class="cs">“id”</span><span class="ck">:</span>        <span class="cb">“3962439”</span><span class="ck">,</span>\n      <span class="cs">“title”</span><span class="ck">:</span>     <span class="cb">“Inception”</span><span class="ck">,</span>\n      <span class="cs">“language”</span><span class="ck">:</span>  <span class="cb">“en”</span><span class="ck">,</span>\n      <span class="cs">“downloads”</span><span class="ck">:</span> <span class="cn">132434</span><span class="ck">,</span>\n      <span class="cs">“features”</span><span class="ck">: {</span> <span class="cs">“hd”</span><span class="ck">:</span> <span class="cn">true</span><span class="ck">,</span> <span class="cs">“trusted”</span><span class="ck">:</span> <span class="cn">true</span> <span class="ck">}</span>\n    <span class="ck">}]</span>\n  <span class="ck">}</span>\n<span class="ck">}</span></pre>’,
‘<div class="section-title">Built by</div>’,
‘<div class="credits">’,
‘<div class="credits-title">Credits</div>’,
‘<div class="credit-row"><div class="credit-avatar munax">M</div><div><div class="credit-name">Munax</div><div class="credit-role">Creator - Architect - Vision</div></div><span class="credit-heart">🡸</span></div>’,
‘<div class="credit-row"><div class="credit-avatar jerry">J</div><div><div class="credit-name">Jerry</div><div class="credit-role">Co-developer - Bug Fixer - Collaborator</div></div><span class="credit-heart">🤝</span></div>’,
‘<div class="credit-row"><div class="credit-avatar sahid">S</div><div><div class="credit-name">Sahid Ikka</div><div class="credit-role">Codebase Co-developer - Silent Force</div></div><span class="credit-heart">🤛🏻</span></div>’,
‘</div>’,
‘<footer><span>VOID CINEMA API - Ultra Peak Edition - v4.0</span><span>Node.js - Express - Cheerio</span></footer>’,
‘</main>’,
‘</body>’,
‘</html>’,
].join(”\n”);

// —————————————————––
// ROUTES
// —————————————————––
app.get(”/”, function(_req, res) {
res.setHeader(“Content-Type”, “text/html; charset=utf-8”);
res.setHeader(“Cache-Control”, “public, max-age=3600”);
res.send(ROOT_HTML);
});

app.get(”/languages”, limiter, function(req, res) {
var qErr = validateQuery(req.query.q);
if (qErr) return res.status(400).json({ success: false, error: qErr });

searchSubtitles(req.query.q.trim())
.then(function(data) {
var seen = {};
var languages = [];
data.results.forEach(function(r) { if (!seen[r.language]) { seen[r.language] = true; languages.push(r.language); } });
languages.sort();
res.json({ success: true, query: req.query.q.trim(), fromCache: data.fromCache, count: languages.length, languages: languages });
})
.catch(function(e) {
console.error(”[/languages]”, e.message);
res.status(500).json({ success: false, error: e.type || “internal”, message: e.message, debug: e.debug });
});
});

app.get(”/stats”, function(_req, res) {
var ss  = searchCache.getStats();
var ds  = dlCache.getStats();
var mem = process.memoryUsage();
res.json({
success        : true,
uptime         : Math.floor(process.uptime()),
uptimeFormatted: fmtUptime(process.uptime()),
platform       : PLATFORM,
baseUrl        : BASE_URL,
sessionReady   : sessionReady,
cookieCount    : cookieJar.size,
memory: { rss: fmtBytes(mem.rss), heapUsed: fmtBytes(mem.heapUsed), heapTotal: fmtBytes(mem.heapTotal) },
cache: {
search  : { keys: searchCache.keys().length, hits: ss.hits, misses: ss.misses },
download: { keys: dlCache.keys().length,     hits: ds.hits, misses: ds.misses },
},
config: { searchTTL: CFG.CACHE_SEARCH_TTL, dlTTL: CFG.CACHE_DL_TTL, rateMax: CFG.RATE_MAX, retries: CFG.SEARCH_RETRIES, proxyActive: !!SHARED_PROXY, selfPing: NEEDS_PING, serverless: IS_SERVERLESS },
credits  : { creator: “Munax”, collaborator: “Jerry”, codeDev: “Sahid Ikka” },
timestamp: new Date().toISOString(),
});
});

app.get(”/subtitle”, limiter, function(req, res) {
var action = req.query.action;

if (action === “search”) {
var qErr = validateQuery(req.query.q);
if (qErr) return res.status(400).json({ success: false, error: qErr });

```
var page = validatePage(req.query.page);
if (req.query.page !== undefined && page === null) {
  return res.status(400).json({ success: false, error: "Page must be between 1 and 100." });
}

searchSubtitles(req.query.q.trim(), page || 1)
  .then(function(raw) {
    var result = req.query.lang ? filterByLanguage(raw, req.query.lang.trim()) : raw;
    res.json({ success: true, data: result });
  })
  .catch(function(e) {
    console.error("[/subtitle search]", e.message);
    res.status(500).json({ success: false, error: e.type || "internal", message: e.message, debug: e.debug });
  });
return;
```

}

if (action === “download”) {
var id = req.query.id;
if (!validateId(id)) return res.status(400).json({ success: false, error: “Invalid or missing id - must be numeric.” });

```
downloadSubtitle(id.trim(), req.query.filename || null)
  .then(function(file) {
    var mime = file.ext === "srt" ? "application/x-subrip" : "application/octet-stream";
    res.setHeader("Content-Disposition", "attachment; filename=\"" + file.filename + "\"");
    res.setHeader("Content-Type",    mime);
    res.setHeader("Content-Length",  file.size);
    res.setHeader("X-File-Extension", file.ext);
    res.send(file.buffer);
  })
  .catch(function(e) {
    console.error("[/subtitle download]", e.message);
    res.status(500).json({ success: false, error: e.type || "internal", message: e.message, debug: e.debug });
  });
return;
```

}

res.status(400).json({
success: false,
error  : “Invalid or missing action. Use search or download.”,
usage  : { search: “/subtitle?action=search&q=inception&lang=en”, download: “/subtitle?action=download&id=3962439” },
});
});

app.get(”/health”, function(_req, res) {
res.status(200).json({ status: “healthy”, uptime: Math.floor(process.uptime()), platform: PLATFORM, sessionReady: sessionReady, timestamp: new Date().toISOString() });
});

app.get(”/favicon.ico”, function(_req, res) { res.status(204).end(); });

app.use(function(_req, res) {
res.status(404).json({ success: false, error: “Endpoint not found.”, hint: “Visit / for API documentation.” });
});

app.use(function(err, _req, res, _next) {
console.error(”[Unhandled]”, err);
res.status(500).json({ success: false, error: “server_error” });
});

// —————————————————––
// VERCEL EXPORT
// —————————————————––
module.exports = app;

// —————————————————––
// START
// —————————————————––
if (require.main === module) {
app.listen(PORT, function() {
console.log(”================================================”);
console.log(”  VOID CINEMA - OpenSubtitles Proxy API”);
console.log(”  Ultra Peak Edition  v4.0  by Munax + Jerry”);
console.log(”================================================”);
console.log(”  Platform  : “ + PLATFORM);
console.log(”  Port      : “ + PORT);
console.log(”  Self-ping : “ + (NEEDS_PING ? “YES” : “OFF”));
console.log(”  Proxy     : “ + (SHARED_PROXY ? “ACTIVE” : “off”));
console.log(”================================================”);
warmUpSession();
});
}
