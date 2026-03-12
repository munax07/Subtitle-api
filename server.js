// ============================================================================
// ULTRA PEAK SUBTITLE API BY MUNAx⚡💗 – v11.0 (2026 FINAL – with all fixes)
// ============================================================================
// Features:
// - Malayalam first, auto‑detection
// - ZIP extraction with size limit (prevents bomb attacks)
// =============================================================================
//  VOID CINEMA — OpenSubtitles Proxy API
//  Ultra Peak Edition v13.0
//  Architecture: munax 🩷
// =============================================================================

‘use strict’;

const express        = require(‘express’);
const axios          = require(‘axios’);
const cheerio        = require(‘cheerio’);
const NodeCache      = require(‘node-cache’);
const rateLimit      = require(‘express-rate-limit’);
const cors           = require(‘cors’);
const AdmZip         = require(‘adm-zip’);
const { HttpsProxyAgent } = require(‘https-proxy-agent’);
const zlib           = require(‘zlib’);
const path           = require(‘path’);
const https          = require(‘https’);
const { randomUUID } = require(‘crypto’);

const app  = express();
const PORT = process.env.PORT || 3000;

// =============================================================================
//  PLATFORM
// =============================================================================
const PLATFORM = (() => {
if (process.env.RENDER === ‘true’ || process.env.RENDER_EXTERNAL_URL) return ‘render’;
if (process.env.KOYEB_APP_NAME    || process.env.KOYEB)               return ‘koyeb’;
if (process.env.VERCEL            || process.env.VERCEL_URL)           return ‘vercel’;
if (process.env.RAILWAY_STATIC_URL|| process.env.RAILWAY_ENVIRONMENT)  return ‘railway’;
if (process.env.FLY_APP_NAME)                                          return ‘fly’;
return ‘local’;
})();

const BASE_URL = (() => {
if (PLATFORM === ‘render’)  return process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
if (PLATFORM === ‘koyeb’)   return ‘https://’ + (process.env.KOYEB_PUBLIC_DOMAIN || (process.env.KOYEB_APP_NAME || ‘app’) + ‘.koyeb.app’);
if (PLATFORM === ‘vercel’)  return process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`;
if (PLATFORM === ‘railway’) return process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`;
if (PLATFORM === ‘fly’)     return `https://${process.env.FLY_APP_NAME}.fly.dev`;
return `http://localhost:${PORT}`;
})();

const IS_SERVERLESS = PLATFORM === ‘vercel’;
const IS_PROD       = process.env.NODE_ENV === ‘production’;
const NEEDS_PING    = [‘render’, ‘koyeb’, ‘railway’].includes(PLATFORM);

app.set(‘trust proxy’, IS_SERVERLESS ? false : 1);

// =============================================================================
//  CONFIG
// =============================================================================
const CFG = {
CACHE_SEARCH_TTL : parseInt(process.env.CACHE_TTL_SEARCH) || 600,
CACHE_DL_TTL     : parseInt(process.env.CACHE_TTL_DL)     || 1800,
CACHE_META_TTL   : 3600,                    // 1hr — subtitle metadata
RATE_MAX         : parseInt(process.env.RATE_LIMIT_MAX) || 100,
RATE_WINDOW_MS   : 15 * 60 * 1000,
REQ_TIMEOUT      : parseInt(process.env.REQUEST_TIMEOUT_MS) || 20000,
MAX_RESULTS      : 40,
MAX_ZIP_SIZE     : 8 * 1024 * 1024,         // 8 MB ZIP bomb guard
MAX_QUERY_LEN    : 200,
SEARCH_RETRIES   : 3,
WARMUP_INTERVAL  : 2 * 60 * 60 * 1000,     // 2 hrs
PING_INTERVAL    : 9 * 60 * 1000,           // 9 min
MEMORY_LIMIT     : (parseInt(process.env.MEMORY_LIMIT_MB) || 512) * 1024 * 1024,
MEMORY_WARN      : 0.82,
};

// =============================================================================
//  LOGGER
// =============================================================================
const log = {
_fmt: (level, msg, meta = {}) => {
const base = { level, ts: new Date().toISOString(), msg };
return JSON.stringify(Object.keys(meta).length ? { …base, …meta } : base);
},
info:  (msg, meta) => console.log(log._fmt(‘info’,  msg, meta)),
warn:  (msg, meta) => console.warn(log._fmt(‘warn’,  msg, meta)),
error: (msg, meta) => console.error(log._fmt(‘error’, msg, meta)),
debug: (msg, meta) => { if (process.env.DEBUG) console.debug(log._fmt(‘debug’, msg, meta)); },
};

// =============================================================================
//  CACHES
//  searchCache  — full search payloads
//  dlCache      — downloaded file buffers
//  metaCache    — subtitle metadata keyed by ID (auto-title magic)
// =============================================================================
const searchCache = new NodeCache({ stdTTL: CFG.CACHE_SEARCH_TTL, checkperiod: 120, useClones: false });
const dlCache     = new NodeCache({ stdTTL: CFG.CACHE_DL_TTL,     checkperiod: 180, useClones: false });
const metaCache   = new NodeCache({ stdTTL: CFG.CACHE_META_TTL,   checkperiod: 300, useClones: false });

// In-flight request deduplication — prevents hammering OS when same search fires twice
const inFlight = new Map();

// =============================================================================
//  PROXY ROTATION
//  Primary  : PROXY_URL env var (your working Webshare proxy)
//  Backups  : BACKUP_PROXY_1 … BACKUP_PROXY_20 env vars
//
//  Koyeb env var format (HTTP):
//    BACKUP_PROXY_1 = http://user:pass@host:port
//  PureVPN example:
//    BACKUP_PROXY_1 = http://purevpn0s4333515:08Basket@prox-usla.pointtoserver.com:10799
//  IPVanish SOCKS5 example (requires socks-proxy-agent package):
//    BACKUP_PROXY_1 = socks5://user:pass@nyc.socks.ipvanish.com:1080
// =============================================================================

function buildProxyPool() {
const list = [];
if (process.env.PROXY_URL) list.push({ url: process.env.PROXY_URL, label: ‘primary’ });
for (let i = 1; i <= 20; i++) {
const v = process.env[`BACKUP_PROXY_${i}`];
if (v) list.push({ url: v, label: `backup_${i}` });
}
return list.map(p => {
try {
const agent = new HttpsProxyAgent(p.url);
const masked = p.url.replace(/:([^:@]{3})[^:@]*@/, ’:***@’);
return { …p, agent, masked };
} catch (e) {
log.warn(‘Invalid proxy URL — skipped’, { label: p.label, error: e.message });
return null;
}
}).filter(Boolean);
}

const PROXY_POOL  = buildProxyPool();
let   proxyIdx    = 0;   // current active proxy index
let   proxyFails  = 0;   // consecutive failures on current proxy

function getActiveProxy()  { return PROXY_POOL.length ? PROXY_POOL[proxyIdx % PROXY_POOL.length] : null; }

function rotateProxy(reason) {
if (PROXY_POOL.length <= 1) return;
const prev = getActiveProxy();
proxyIdx   = (proxyIdx + 1) % PROXY_POOL.length;
proxyFails = 0;
log.warn(‘Proxy rotated’, { from: prev.label, to: getActiveProxy().label, reason });
}

function onProxySuccess() { proxyFails = 0; }
function onProxyFailure(reason) {
proxyFails++;
if (proxyFails >= 2) rotateProxy(reason);
}

if (PROXY_POOL.length > 0) {
log.info(‘Proxy pool ready’, { count: PROXY_POOL.length, proxies: PROXY_POOL.map(p => p.label) });
} else {
log.warn(‘No proxies configured — direct connection only’);
}

// =============================================================================
//  TLS AGENT  (keep-alive, tuned ciphers)
// =============================================================================
const TLS_AGENT = new https.Agent({
keepAlive       : true,
keepAliveMsecs  : 30000,
maxSockets      : 24,
minVersion      : ‘TLSv1.2’,
honorCipherOrder: true,
ciphers: [
‘TLS_AES_128_GCM_SHA256’,
‘TLS_AES_256_GCM_SHA384’,
‘TLS_CHACHA20_POLY1305_SHA256’,
‘ECDHE-RSA-AES128-GCM-SHA256’,
‘ECDHE-RSA-AES256-GCM-SHA384’,
].join(’:’),
});

// =============================================================================
//  BROWSER PROFILES  (rotate to avoid fingerprinting)
// =============================================================================
const PROFILES = [
{
‘User-Agent’         : ‘Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36’,
‘sec-ch-ua’          : ‘“Not(A:Brand”;v=“99”, “Google Chrome”;v=“133”’,
‘sec-ch-ua-mobile’   : ‘?0’,
‘sec-ch-ua-platform’ : ‘“Windows”’,
},
{
‘User-Agent’         : ‘Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36’,
‘sec-ch-ua’          : ‘“Not(A:Brand”;v=“99”, “Google Chrome”;v=“133”’,
‘sec-ch-ua-mobile’   : ‘?0’,
‘sec-ch-ua-platform’ : ‘“macOS”’,
},
{
‘User-Agent’         : ‘Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0’,
‘Accept’             : ‘text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8’,
},
{
‘User-Agent’         : ‘Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36’,
‘sec-ch-ua’          : ‘“Not(A:Brand”;v=“99”, “Google Chrome”;v=“133”’,
‘sec-ch-ua-mobile’   : ‘?0’,
‘sec-ch-ua-platform’ : ‘“Linux”’,
},
];

const COMMON_HEADERS = {
‘Accept’                 : ‘text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8’,
‘Accept-Language’        : ‘en-US,en;q=0.9’,
‘Accept-Encoding’        : ‘gzip, deflate, br’,
‘Connection’             : ‘keep-alive’,
‘Upgrade-Insecure-Requests’: ‘1’,
‘Sec-Fetch-Dest’         : ‘document’,
‘Sec-Fetch-Mode’         : ‘navigate’,
‘Sec-Fetch-Site’         : ‘none’,
‘Sec-Fetch-User’         : ‘?1’,
};

let profileIdx = 0;
function nextProfile() { return PROFILES[profileIdx++ % PROFILES.length]; }

// =============================================================================
//  COOKIE JAR
// =============================================================================
const cookieJar = new Map([[‘lang’, ‘en’], [‘oslocale’, ‘en’]]);

function extractCookies(res) {
const sc = res?.headers?.[‘set-cookie’];
if (!Array.isArray(sc)) return;
sc.forEach(raw => {
const pair = raw.split(’;’)[0];
const eq   = pair.indexOf(’=’);
if (eq < 1) return;
cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
});
}

function cookieHeader() {
const parts = [];
cookieJar.forEach((v, k) => parts.push(`${k}=${v}`));
return parts.join(’; ’);
}

// =============================================================================
//  HTTP CLIENT FACTORY
// =============================================================================
function createClient(extra = {}) {
const headers = {
…COMMON_HEADERS,
…nextProfile(),
Cookie: cookieHeader(),
…extra,
};
const config = {
timeout       : CFG.REQ_TIMEOUT,
maxRedirects  : 5,
decompress    : true,
validateStatus: () => true,
headers,
};
const proxy = getActiveProxy();
if (proxy) {
config.httpsAgent = proxy.agent;
config.proxy      = false;
} else {
config.httpsAgent = TLS_AGENT;
}
return axios.create(config);
}

// Wrap axios calls to auto-rotate on 403/429/network failure
async function fetchWithRotation(fn) {
const MAX_ATTEMPTS = Math.max(1, PROXY_POOL.length) + 1;
let lastErr = null;
for (let att = 0; att < MAX_ATTEMPTS; att++) {
try {
const res = await fn();
if (res && (res.status === 403 || res.status === 429)) {
onProxyFailure(`HTTP ${res.status}`);
lastErr = new Error(`HTTP ${res.status}`);
await jitter(600, 1400);
continue;
}
onProxySuccess();
return res;
} catch (e) {
onProxyFailure(e.message);
lastErr = e;
await jitter(400, 1000);
}
}
throw lastErr || new Error(‘All proxy attempts failed’);
}

// =============================================================================
//  SESSION WARM-UP  — shared promise prevents duplicate warm-up calls
//                     ensureSession() queues requests until session is ready
// =============================================================================
let sessionReady   = false;
let _warmupPromise = null;

async function warmUpSession(attempt = 1) {
// Return same promise if already in progress — no duplicate fire
if (_warmupPromise) return _warmupPromise;

// Create and assign promise synchronously — callers awaiting will share it
const promise = (async () => {
log.info(‘Warming session…’, { attempt });
try {
const res = await createClient({ ‘Sec-Fetch-Site’: ‘none’ })
.get(‘https://www.opensubtitles.org/en’);
extractCookies(res);
if (res.status === 200) {
sessionReady = true;
log.info(‘Session ready’, { cookies: cookieJar.size });
} else {
throw new Error(`HTTP ${res.status}`);
}
} catch (e) {
log.warn(‘Warm-up failed’, { attempt, error: e.message });
if (attempt < 4) {
// Clear before recursive call so next call creates a fresh promise
if (_warmupPromise === promise) _warmupPromise = null;
await sleep(7000 * attempt);
return warmUpSession(attempt + 1);
}
// After 4 failures let requests through — better than hanging forever
log.warn(‘Warm-up gave up — allowing cold requests’);
sessionReady = true;
} finally {
// Only clear if we are still the active promise (not a recursive replacement)
if (_warmupPromise === promise) _warmupPromise = null;
}
})();

_warmupPromise = promise;
return _warmupPromise;
}

// Any function that needs cookies calls this first
async function ensureSession() {
if (sessionReady) return;
log.info(‘Request arrived before session ready — waiting for warm-up’);
await warmUpSession();
}

// =============================================================================
//  UTILITIES
// =============================================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function jitter(min = 400, max = 1200) {
return sleep(Math.floor(Math.random() * (max - min + 1)) + min);
}

function fmtBytes(b) {
if (!b) return ‘0 B’;
const u = [‘B’, ‘KB’, ‘MB’, ‘GB’];
const i = Math.floor(Math.log(b) / Math.log(1024));
return `${(b / Math.pow(1024, i)).toFixed(2)} ${u[i]}`;
}

function fmtUptime(s) {
return [
String(Math.floor(s / 3600)).padStart(2, ‘0’),
String(Math.floor((s % 3600) / 60)).padStart(2, ‘0’),
String(Math.floor(s % 60)).padStart(2, ‘0’),
].join(’:’);
}

function isHtmlBuffer(buf) {
const s = Buffer.isBuffer(buf) ? buf.subarray(0, 600).toString(‘utf8’) : String(buf).slice(0, 600);
return /<(html|!doctype|body)/i.test(s);
}

function mkErr(type, msg) {
const e = new Error(msg);
e.type  = type;
return e;
}

// =============================================================================
//  LANGUAGE HELPERS
// =============================================================================
const LANG_PRIORITY = [‘ml’, ‘en’];   // Malayalam first — Munax’s choice

function sortByLanguage(results, requested) {
if (requested && requested !== ‘all’) {
return results.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
}
const pMap = new Map(LANG_PRIORITY.map((l, i) => [l, i]));
return results.sort((a, b) => {
const ap = pMap.has(a.lang) ? pMap.get(a.lang) : LANG_PRIORITY.length;
const bp = pMap.has(b.lang) ? pMap.get(b.lang) : LANG_PRIORITY.length;
if (ap !== bp) return ap - bp;
return (b.downloads || 0) - (a.downloads || 0);
});
}

function detectMalayalam(q = ‘’) {
return /\bml\b|malayalam|mallu|മലയാളം/i.test(q);
}

// =============================================================================
//  MOVIE vs TV DETECTION
// =============================================================================
function detectType(title = ‘’) {
const t = title.replace(/\r?\n/g, ’ ’).replace(/\s+/g, ’ ’).trim();
const tvPatterns = [
/S\d{2}[.\s-]*E\d{2}/i,
/Season[.\s-]*\d+/i,
/Episode[.\s-]*\d+/i,
/\b\d+x\d+\b/i,
/Complete[\s.]Series/i,
];
for (const p of tvPatterns) if (p.test(t)) return ‘series’;
if (/((19|20)\d{2})/.test(t)) return ‘movie’;
if (/1080p|720p|2160p|4K|BluRay|WEBRip|BRRip|DVDRip/i.test(t)) return ‘movie’;
return ‘unknown’;
}

// =============================================================================
//  FILENAME GENERATOR
//  Priority: XML subfilename > Content-Disposition > ZIP entry > constructed
// =============================================================================
function generateFilename(id, meta, cdHeader = ‘’, zipEntry = null) {
const toSafe = s => s.replace(/[^a-z0-9.-*()]/gi, ’*’).replace(/*+/g, ’*’).replace(/^*|*$/g, ‘’);

// 1. XML subfilename (most accurate — actual release name)
if (meta?.subfilename) {
const f = meta.subfilename.trim();
if (f && f.length > 4) {
const ext = path.extname(f).toLowerCase();
if ([’.srt’, ‘.ass’, ‘.ssa’, ‘.sub’, ‘.smi’].includes(ext)) return toSafe(f);
return toSafe(f) + ‘.srt’;
}
}

// 2. Content-Disposition from download response
if (cdHeader) {
const m = cdHeader.match(/filename[^;=\n]*=([’”]?)([^\n’”]*)\1/i);
if (m && m[2]) {
let n = m[2].trim();
if (n.endsWith(’.gz’)) n = n.slice(0, -3);
if (!/.(srt|ass|ssa|sub|smi|txt)$/i.test(n)) n += ‘.srt’;
return toSafe(path.basename(n));
}
}

// 3. ZIP extracted entry name
if (zipEntry) return toSafe(path.basename(zipEntry));

// 4. Construct from metadata
if (meta) {
const parts = [(meta.title || ‘subtitle’).replace(/[^a-z0-9\s]/gi, ‘’).replace(/\s+/g, ‘*’).trim()];
if (meta.year) parts.push(meta.year);
if (meta.lang) parts.push(meta.lang);
return parts.join(’*’) + ‘.srt’;
}

return `subtitle_${id}.srt`;
}

// =============================================================================
//  ZIP EXTRACTION
//  Picks best subtitle file — prefers language match, then largest file
// =============================================================================
function extractFromZip(buffer, preferLang = null) {
const SUB_EXTS = /.(srt|ass|ssa|sub|smi|txt)$/i;
const zip      = new AdmZip(buffer);
const entries  = zip.getEntries().filter(e => !e.isDirectory && SUB_EXTS.test(e.entryName));

if (entries.length === 0) return null;

// ZIP bomb guard
for (const e of entries) {
if (e.header.size > CFG.MAX_ZIP_SIZE) throw new Error(`ZIP entry too large: ${e.header.size} bytes`);
}

// Prefer .srt files, then largest, then language hint in name
const srtEntries = entries.filter(e => /.srt$/i.test(e.entryName));
const pool       = srtEntries.length ? srtEntries : entries;

let best = pool[0];

if (preferLang) {
const langMatch = pool.find(e => e.entryName.toLowerCase().includes(preferLang.toLowerCase()));
if (langMatch) best = langMatch;
}

// If multiple, pick largest (usually best quality)
if (pool.length > 1 && !preferLang) {
best = pool.reduce((a, b) => b.header.size > a.header.size ? b : a);
}

return { buffer: best.getData(), name: best.entryName };
}

// =============================================================================
//  SIMPLEXML SEARCH  (primary — fast, structured, no HTML parsing needed)
// =============================================================================
function parseSimpleXML(xmlData) {
const $ = cheerio.load(xmlData, { xmlMode: true });
const results = [];

$(‘subtitle’).each((_, el) => {
const $el = $(el);
const rawTitle   = ($el.find(‘moviename’).text() || $el.find(‘releasename’).text() || ‘’).replace(/\s+/g, ’ ’).trim();
const subfile    = $el.find(‘subfilename’).text().trim();
const lang       = $el.find(‘iso639’).text().trim();
const id         = $el.find(‘idsubtitle’).text().trim();
const downloads  = parseInt($el.find(‘subdownloads’).text(), 10) || 0;
const uploader   = $el.find(‘userusername’).text().trim() || ‘anonymous’;
const addDate    = $el.find(‘subadddate’).text().trim() || null;
const subRating  = parseFloat($el.find(‘subrating’).text()) || null;

```
if (!id || !rawTitle) return;

const yearMatch = rawTitle.match(/\(((19|20)\d{2})\)/);
const year      = yearMatch ? yearMatch[1] : null;
const title     = rawTitle.replace(/\s*\((19|20)\d{2}\)$/, '').trim();
const type      = detectType(subfile || rawTitle);

const features = {
  hd             : $el.find('subhd').text() === '1',
  hearingImpaired: $el.find('subhearing_impaired').text() === '1',
  trusted        : $el.find('subtrusted').text() === '1',
};

results.push({ id, title, year, lang, downloads, uploader, addDate, subfilename: subfile, type, features, rating: subRating });
```

});

return results;
}

async function searchXML(query, lang = null, type = null) {
const ckey = `xml:${query}:${lang || 'all'}:${type || 'all'}`;

// Deduplication — if same search is already in-flight, wait for it
if (inFlight.has(ckey)) {
log.debug(‘Deduplicating in-flight search’, { query });
return inFlight.get(ckey);
}

const cached = searchCache.get(ckey);
if (cached) return { …cached, fromCache: true };

const promise = (async () => {
const url = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${encodeURIComponent(query)}/simplexml`;
let lastErr = null;

```
for (let att = 0; att < CFG.SEARCH_RETRIES; att++) {
  await jitter(300 + att * 500, 900 + att * 800);
  try {
    await ensureSession();
    const res = await fetchWithRotation(() =>
      createClient({ 'Accept': 'application/xml,text/xml,*/*' }).get(url)
    );
    extractCookies(res);

    if (res.status === 403 || res.status === 429) {
      log.warn('Rate-limited by OS', { status: res.status, attempt: att + 1 });
      lastErr = mkErr('blocked', `HTTP ${res.status}`);
      await warmUpSession();
      continue;
    }

    if (res.status !== 200) {
      lastErr = mkErr('search_failed', `HTTP ${res.status}`);
      continue;
    }

    let results = parseSimpleXML(res.data);
    if (results.length === 0 && typeof res.data === 'string' && !res.data.includes('<subtitle>')) {
      lastErr = mkErr('no_results', 'No subtitle XML returned');
      continue;
    }

    // Store metadata for every result → enables auto-title on download
    results.forEach(r => {
      if (r.id) {
        metaCache.set(`meta:${r.id}`, {
          title      : r.title,
          year       : r.year,
          lang       : r.lang,
          subfilename: r.subfilename,
          type       : r.type,
        });
      }
    });

    // Apply filters
    if (type && type !== 'all')  results = results.filter(r => r.type === type);
    if (lang && lang !== 'all')  results = results.filter(r => r.lang.toLowerCase() === lang.toLowerCase());

    results = sortByLanguage(results, lang);
    results = results.slice(0, CFG.MAX_RESULTS);

    const payload = { query, total: results.length, fromCache: false, results };
    searchCache.set(ckey, payload);
    return payload;

  } catch (e) {
    if (e.type) throw e;
    lastErr = mkErr('network_error', e.message);
    log.warn('Search attempt failed', { attempt: att + 1, error: e.message });
  }
}

throw lastErr || mkErr('search_failed', 'All attempts exhausted');
```

})();

inFlight.set(ckey, promise);
promise.finally(() => inFlight.delete(ckey));
return promise;
}

// =============================================================================
//  DOWNLOAD
//  1. Official API (if credentials set)
//  2. Direct dl.opensubtitles.org + session cookies
//  3. Alternative subtitleserve URL
// =============================================================================

// Official API session
const OS = {
apiKey  : process.env.OS_API_KEY   || ‘’,
username: process.env.OS_USERNAME  || ‘’,
password: process.env.OS_PASSWORD  || ‘’,
token   : null,
expiry  : 0,
dlUsed  : 0,
dlMax   : 100,
};

async function osLogin() {
if (!OS.apiKey || !OS.username || !OS.password) return false;
if (OS.token && Date.now() < OS.expiry) return true;

try {
const res = await axios.post(
‘https://api.opensubtitles.com/api/v1/login’,
{ username: OS.username, password: OS.password },
{
headers: {
‘Api-Key’     : OS.apiKey,
‘Content-Type’: ‘application/json’,
‘User-Agent’  : ‘VoidCinemaAPI v13.0’,
},
timeout: 12000,
}
);
if (res.status === 200 && res.data?.token) {
OS.token  = res.data.token;
OS.expiry = Date.now() + 23 * 60 * 60 * 1000;
OS.dlMax  = res.data.user?.allowed_downloads || 100;
log.info(‘OS API login OK’, { downloadsAllowed: OS.dlMax });
return true;
}
log.warn(‘OS API login failed’, { status: res.status });
return false;
} catch (e) {
log.warn(‘OS API login error’, { error: e.message });
return false;
}
}

async function osApiDownload(id, meta) {
if (!await osLogin()) return null;
try {
// Step 1: Get download link
const dlRes = await axios.post(
‘https://api.opensubtitles.com/api/v1/download’,
{ file_id: parseInt(id, 10) },
{
headers: {
‘Api-Key’      : OS.apiKey,
‘Authorization’: `Bearer ${OS.token}`,
‘Content-Type’ : ‘application/json’,
‘User-Agent’   : ‘VoidCinemaAPI v13.0’,
},
timeout: 15000,
}
);

```
if (dlRes.status === 401) { OS.token = null; return null; }
if (dlRes.status !== 200 || !dlRes.data?.link) return null;

OS.dlUsed = dlRes.data.requests || OS.dlUsed;
OS.dlMax  = dlRes.data.allowed  || OS.dlMax;

// Step 2: Fetch the file
const fileRes = await axios.get(dlRes.data.link, {
  responseType  : 'arraybuffer',
  timeout       : CFG.REQ_TIMEOUT,
  validateStatus: () => true,
});
if (fileRes.status !== 200) return null;

const buf      = Buffer.from(fileRes.data);
// Use official API filename first — it is the most accurate (exact release name)
const apiMeta  = dlRes.data.file_name
  ? { ...meta, subfilename: dlRes.data.file_name }
  : meta;
const filename = generateFilename(id, apiMeta, '', null);
const ext      = path.extname(filename).replace('.', '').toLowerCase() || 'srt';

log.info('OS API download OK', { id, filename, size: fmtBytes(buf.length), quota: `${OS.dlUsed}/${OS.dlMax}` });
return { buffer: buf, filename, ext, size: buf.length, source: 'official_api' };
```

} catch (e) {
log.warn(‘OS API download error’, { id, error: e.message });
return null;
}
}

async function scraperDownload(id, meta) {
const urls = [
`https://dl.opensubtitles.org/en/download/sub/${id}`,
`https://www.opensubtitles.org/en/subtitleserve/sub/${id}`,
];

for (let ui = 0; ui < urls.length; ui++) {
const url = urls[ui];
await jitter(500 + ui * 400, 1400 + ui * 600);   // longer backoff per retry
try {
await ensureSession();
const res = await fetchWithRotation(() =>
createClient({
Referer          : `https://www.opensubtitles.org/en/subtitles/${id}`,
‘Sec-Fetch-Site’ : ‘same-origin’,
‘Sec-Fetch-Mode’ : ‘navigate’,
‘Sec-Fetch-Dest’ : ‘document’,
}).get(url, { responseType: ‘arraybuffer’ })
);

```
  extractCookies(res);
  if (res.status !== 200) continue;

  let buf = Buffer.from(res.data);
  if (buf.length < 20) continue;

  // Gunzip if needed
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try { buf = zlib.gunzipSync(buf); } catch { continue; }
  }

  if (isHtmlBuffer(buf)) continue;

  const cd = res.headers['content-disposition'] || '';

  // ZIP handling
  const isZip = buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
  let zipEntry = null;

  if (isZip) {
    try {
      const extracted = extractFromZip(buf, meta?.lang);
      if (extracted) {
        buf      = extracted.buffer;
        zipEntry = extracted.name;
        log.info('ZIP extracted', { entry: zipEntry, size: fmtBytes(buf.length) });
      }
    } catch (e) {
      log.warn('ZIP extraction failed', { error: e.message });
      continue;
    }
  }

  const filename = generateFilename(id, meta, cd, zipEntry);
  const ext      = path.extname(filename).replace('.', '').toLowerCase() || 'srt';

  log.info('Scraper download OK', { id, url, size: fmtBytes(buf.length) });
  return { buffer: buf, filename, ext, size: buf.length, source: 'scraper' };

} catch (e) {
  log.warn('Download URL failed', { url, error: e.message });
}
```

}
return null;
}

async function downloadSubtitle(id, overrideTitle = null) {
const ckey  = `dl:${id}`;
const cached = dlCache.get(ckey);
if (cached) return { …cached, fromCache: true };

// Get metadata — this is the auto-title magic
let meta = metaCache.get(`meta:${id}`) || null;
if (overrideTitle) {
meta = { …meta, title: overrideTitle };
}

// Try official API first (reliable, no blocks)
if (OS.apiKey && OS.username && OS.password) {
const apiResult = await osApiDownload(id, meta);
if (apiResult) {
dlCache.set(ckey, apiResult);
return apiResult;
}
log.info(‘API failed, falling back to scraper’, { id });
}

// Scraper fallback
const result = await scraperDownload(id, meta);
if (result) {
dlCache.set(ckey, result);
return result;
}

throw mkErr(‘download_failed’, ‘All download sources exhausted. If this persists, set OS_API_KEY + OS_USERNAME + OS_PASSWORD env vars.’);
}

// =============================================================================
//  MIDDLEWARE
// =============================================================================
// Compress all text/json responses — saves bandwidth on subtitle searches
try {
const compression = require(‘compression’);
app.use(compression({ level: 6, threshold: 1024 }));
log.info(‘Compression middleware active’);
} catch {
log.warn(‘compression package not installed — skipping (npm install compression)’);
}

app.use(cors({ origin: ‘*’, methods: [‘GET’, ‘OPTIONS’] }));
app.use(express.json({ limit: ‘512kb’ }));

// Security headers
app.use((req, res, next) => {
res.setHeader(‘X-Content-Type-Options’, ‘nosniff’);
res.setHeader(‘X-Frame-Options’, ‘DENY’);
res.setHeader(‘X-Powered-By’, ‘VOID CINEMA API’);
res.setHeader(‘Cache-Control’, ‘no-store’);
next();
});

// Request ID + Response Time
app.use((req, res, next) => {
req.rid    = req.headers[‘x-request-id’] || randomUUID();
req._start = Date.now();
res.setHeader(‘X-Request-ID’, req.rid);
res.on(‘finish’, () => {
res.setHeader(‘X-Response-Time’, `${Date.now() - req._start}ms`);
});
next();
});

// Rate limiter — FIXED: uses IP, not requestId
const limiter = rateLimit({
windowMs       : CFG.RATE_WINDOW_MS,
max            : CFG.RATE_MAX,
standardHeaders: true,
legacyHeaders  : false,
skip           : () => IS_SERVERLESS,
keyGenerator   : req => req.ip,
handler        : (req, res) => {
res.setHeader(‘Retry-After’, Math.ceil(CFG.RATE_WINDOW_MS / 1000));
res.status(429).json({ success: false, error: ‘Rate limit exceeded.’, retryAfterSeconds: Math.ceil(CFG.RATE_WINDOW_MS / 1000) });
},
});

// =============================================================================
//  VALIDATION
// =============================================================================
function validateQ(q) {
if (!q || typeof q !== ‘string’) return ‘Missing required parameter: q’;
if (!q.trim()) return ‘Query cannot be blank’;
if (q.trim().length > CFG.MAX_QUERY_LEN) return `Query too long (max ${CFG.MAX_QUERY_LEN} chars)`;
return null;
}

function validateId(id) {
return typeof id === ‘string’ && /^\d{1,12}$/.test(id.trim());
}

// =============================================================================
//  ROUTES
// =============================================================================

// —– SEARCH —–
app.get(’/search’, limiter, async (req, res) => {
const t0  = Date.now();
let { q, lang, type } = req.query;

const qErr = validateQ(q);
if (qErr) return res.status(400).json({ success: false, error: qErr });

// Auto-detect Malayalam
if (!lang && detectMalayalam(q)) {
lang = ‘ml’;
log.info(‘Auto-detected Malayalam’, { query: q, rid: req.rid });
}

try {
const data = await searchXML(q.trim(), lang || null, type || null);
// ETag — clients can use If-None-Match to skip re-downloading identical results
const etag = `"${Buffer.from(JSON.stringify({ q: q.trim(), lang, type, total: data.total })).toString('base64').slice(0, 24)}"`;
if (req.headers[‘if-none-match’] === etag) {
log.info(‘Search 304’, { query: q, rid: req.rid, ms: Date.now() - t0 });
return res.status(304).end();
}
res.setHeader(‘ETag’, etag);
log.info(‘Search OK’, { query: q, count: data.total, lang, cached: data.fromCache, ms: Date.now() - t0, rid: req.rid });
res.json({ success: true, …data });
} catch (e) {
log.error(‘Search error’, { error: e.message, type: e.type, rid: req.rid, ms: Date.now() - t0 });
res.status(500).json({ success: false, error: e.type || ‘internal’, message: e.message });
}
});

// —– DOWNLOAD —–
app.get(’/download’, limiter, async (req, res) => {
const t0  = Date.now();
let { id, title } = req.query;

if (!validateId(id)) {
return res.status(400).json({ success: false, error: ‘Invalid or missing id — must be numeric.’ });
}

// Sanitize user-provided title
if (title) {
title = path.basename(title)
.replace(/[^a-z0-9\s-*.()]/gi, ‘’)
.replace(/\s+/g, ’*’)
.substring(0, 120)
.trim();
}

try {
const file = await downloadSubtitle(id.trim(), title || null);
const mime = file.ext === ‘srt’ ? ‘application/x-subrip’ : ‘application/octet-stream’;

```
res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
res.setHeader('Content-Type', mime);
res.setHeader('Content-Length', file.size);
res.setHeader('X-Download-Source', file.source || 'cache');

log.info('Download OK', { id, filename: file.filename, size: fmtBytes(file.size), source: file.source, ms: Date.now() - t0, rid: req.rid });
res.send(file.buffer);
```

} catch (e) {
log.error(‘Download error’, { id, error: e.message, ms: Date.now() - t0, rid: req.rid });
res.status(500).json({ success: false, error: e.type || ‘internal’, message: e.message });
}
});

// —– LANGUAGES —–
app.get(’/languages’, limiter, async (req, res) => {
const qErr = validateQ(req.query.q);
if (qErr) return res.status(400).json({ success: false, error: qErr });

try {
const data  = await searchXML(req.query.q.trim());
const langs = […new Set(data.results.map(r => r.lang))].sort();
res.json({ success: true, query: req.query.q.trim(), fromCache: data.fromCache, count: langs.length, languages: langs });
} catch (e) {
res.status(500).json({ success: false, error: e.type || ‘internal’, message: e.message });
}
});

// —– STATS —–
app.get(’/stats’, (req, res) => {
const mem = process.memoryUsage();
const ss  = searchCache.getStats();
const ds  = dlCache.getStats();
const ms  = metaCache.getStats();

res.json({
success        : true,
uptime         : Math.floor(process.uptime()),
uptimeFormatted: fmtUptime(process.uptime()),
platform       : PLATFORM,
sessionReady   : sessionReady,
cookieCount    : cookieJar.size,
officialApi: {
configured : !!(OS.apiKey && OS.username),
loggedIn   : !!(OS.token && Date.now() < OS.expiry),
quota      : OS.apiKey ? `${OS.dlUsed}/${OS.dlMax}` : ‘N/A’,
},
proxy: PROXY_POOL.length > 0 ? { count: PROXY_POOL.length, active: getActiveProxy()?.label || ‘none’ } : ‘off’,
memory: {
rss      : fmtBytes(mem.rss),
heapUsed : fmtBytes(mem.heapUsed),
heapTotal: fmtBytes(mem.heapTotal),
},
cache: {
search  : { keys: searchCache.keys().length, hits: ss.hits, misses: ss.misses },
download: { keys: dlCache.keys().length,     hits: ds.hits, misses: ds.misses },
meta    : { keys: metaCache.keys().length,   hits: ms.hits, misses: ms.misses },
},
config: {
searchTTL : CFG.CACHE_SEARCH_TTL,
dlTTL     : CFG.CACHE_DL_TTL,
rateMax   : CFG.RATE_MAX,
retries   : CFG.SEARCH_RETRIES,
selfPing  : NEEDS_PING,
serverless: IS_SERVERLESS,
},
credits  : { architect: ‘munax’ },
timestamp: new Date().toISOString(),
});
});

// —– HEALTH —–
// NOTE: Does NOT hit OpenSubtitles on every call — safe for 30s pings
app.get(’/health’, (req, res) => {
const healthy = sessionReady;
res.status(healthy ? 200 : 503).json({
status   : healthy ? ‘healthy’ : ‘warming’,
uptime   : Math.floor(process.uptime()),
platform : PLATFORM,
session  : sessionReady,
timestamp: new Date().toISOString(),
});
});

// —– ROOT — VOID CINEMA DASHBOARD —–
const ROOT_HTML = `<!DOCTYPE html>

<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VOID CINEMA — Subtitle API</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#07090e;--s0:#0b0d14;--s1:#0f1220;--b0:#161c2e;--b1:#1f2840;
  --a:#e2ff47;--a2:#47f4c8;--a3:#f447a8;--a4:#ff9f47;
  --m:#3a4a68;--m2:#566080;--t:#aabace;--w:#dde8f5;
  --font-mono:"Space Mono",monospace;--font-sans:"Syne",sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{
  background:var(--bg);color:var(--t);
  font-family:var(--font-sans);min-height:100vh;overflow-x:hidden;
  -webkit-font-smoothing:antialiased;
}
/* Grid background */
body::before{
  content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
  background-image:
    linear-gradient(rgba(71,244,200,.018) 1px,transparent 1px),
    linear-gradient(90deg,rgba(71,244,200,.018) 1px,transparent 1px);
  background-size:56px 56px;
}
/* Glow orbs */
.orb{position:fixed;pointer-events:none;z-index:0;border-radius:50%;filter:blur(80px);opacity:.35;}
.orb-1{width:600px;height:600px;top:-200px;left:-100px;background:radial-gradient(circle,rgba(71,244,200,.12),transparent 70%);}
.orb-2{width:500px;height:500px;bottom:-150px;right:-100px;background:radial-gradient(circle,rgba(226,255,71,.08),transparent 70%);}
.orb-3{width:400px;height:400px;top:40%;left:60%;background:radial-gradient(circle,rgba(244,71,168,.06),transparent 70%);}

main{position:relative;z-index:1;max-width:900px;margin:0 auto;padding:72px 24px 120px;}

/* Header */
header{margin-bottom:80px;}
.kicker{
font-family:var(–font-mono);font-size:.6rem;letter-spacing:.3em;
color:var(–a2);text-transform:uppercase;
display:flex;align-items:center;gap:12px;margin-bottom:28px;
}
.kicker::before{content:””;width:40px;height:1px;background:var(–a2);flex-shrink:0;}
h1{
font-size:clamp(3rem,9vw,5.8rem);font-weight:800;
line-height:.9;letter-spacing:-.05em;color:var(–w);
margin-bottom:20px;
}
h1 em{font-style:normal;color:var(–a2);}
h1 .dot{color:var(–a);}
.sub{
font-family:var(–font-mono);font-size:.78rem;line-height:1.9;
color:var(–m2);max-width:420px;
}

/* Badges */
.badges{display:flex;flex-wrap:wrap;gap:8px;margin:36px 0 80px;}
.badge{
font-family:var(–font-mono);font-size:.58rem;letter-spacing:.1em;
padding:5px 13px;border-radius:3px;border:1px solid var(–b1);
color:var(–m2);display:flex;align-items:center;gap:8px;
text-transform:uppercase;
}
.badge.live{border-color:rgba(71,244,200,.4);color:var(–a2);}
.badge.live::before{
content:””;width:5px;height:5px;border-radius:50%;
background:var(–a2);box-shadow:0 0 10px var(–a2);
animation:pulse 2s ease-in-out infinite;flex-shrink:0;
}
.badge.api{border-color:rgba(226,255,71,.3);color:var(–a);}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.4;transform:scale(.8);}}

/* Live stats panel */
.panel{
background:var(–s0);border:1px solid var(–b0);
padding:28px 32px;margin-bottom:72px;border-radius:2px;
position:relative;overflow:hidden;
}
.panel::before{content:””;position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(–a2),transparent);}
.panel-title{
font-family:var(–font-mono);font-size:.58rem;letter-spacing:.3em;
color:var(–m);text-transform:uppercase;margin-bottom:24px;
}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:24px;}
.stat{}
.stat-val{font-family:var(–font-mono);font-size:1.5rem;font-weight:700;color:var(–a2);letter-spacing:-.03em;}
.stat-label{font-family:var(–font-mono);font-size:.58rem;color:var(–m);text-transform:uppercase;letter-spacing:.15em;margin-top:4px;}

/* Section title */
.sl{
font-family:var(–font-mono);font-size:.58rem;letter-spacing:.3em;
color:var(–m);text-transform:uppercase;
padding-bottom:14px;margin-bottom:24px;border-bottom:1px solid var(–b0);
}

/* Endpoints */
.eps{display:flex;flex-direction:column;gap:1px;margin-bottom:80px;}
.ep{
background:var(–s0);border:1px solid var(–b0);
padding:24px 28px;position:relative;overflow:hidden;
transition:background .2s,border-color .2s;cursor:default;
}
.ep::before{
content:””;position:absolute;left:0;top:0;bottom:0;width:2px;
background:transparent;transition:background .25s;
}
.ep:hover{background:var(–s1);border-color:var(–b1);}
.ep:hover::before{background:var(–a2);}
.ep-head{display:flex;align-items:baseline;gap:12px;margin-bottom:10px;flex-wrap:wrap;}
.method{
font-family:var(–font-mono);font-size:.58rem;font-weight:700;
letter-spacing:.12em;padding:3px 10px;
background:rgba(226,255,71,.07);color:var(–a);
border-radius:2px;flex-shrink:0;text-transform:uppercase;
}
.ep-url{font-family:var(–font-mono);font-size:.78rem;color:var(–w);word-break:break-all;line-height:1.5;}
.ep-url .p{color:var(–a2);}
.ep-url .o{color:var(–m2);}
.ep-desc{font-size:.78rem;color:var(–m2);line-height:1.7;margin-bottom:14px;}
.params{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;}
.param{
font-family:var(–font-mono);font-size:.58rem;
padding:3px 10px;border:1px solid var(–b1);
border-radius:2px;color:var(–m2);
}
.param b{color:var(–t);}
.param.req{border-color:rgba(226,255,71,.25);color:rgba(226,255,71,.8);}
.try{
font-family:var(–font-mono);font-size:.58rem;color:var(–a2);
text-decoration:none;display:inline-flex;align-items:center;gap:6px;
opacity:.6;transition:opacity .2s,gap .2s;
}
.try:hover{opacity:1;gap:10px;}
.try::after{content:”->”;}

/* Code block */
pre{
background:var(–s0);border:1px solid var(–b0);
padding:32px;overflow-x:auto;border-radius:2px;
font-family:var(–font-mono);font-size:.7rem;line-height:2;
color:var(–t);margin-bottom:80px;position:relative;
}
pre::before{
content:“JSON”;position:absolute;top:16px;right:20px;
font-size:.55rem;letter-spacing:.2em;color:var(–m);
}
.ck{color:var(–m2)}.cs{color:var(–a2)}.cv{color:var(–a)}.cb{color:var(–a4)}.cm{color:#7bb3ff}

/* Feature callout */
.callout{
background:var(–s0);border:1px solid rgba(71,244,200,.15);
padding:24px 28px;margin-bottom:80px;border-radius:2px;
}
.callout-title{
font-family:var(–font-mono);font-size:.6rem;letter-spacing:.25em;
color:var(–a2);text-transform:uppercase;margin-bottom:14px;
}
.callout p{font-family:var(–font-mono);font-size:.7rem;line-height:1.9;color:var(–m2);}
.callout b{color:var(–a);}

/* Credits */
.credits{background:var(–s0);border:1px solid var(–b0);padding:32px;margin-bottom:80px;border-radius:2px;}
.credits-head{
font-family:var(–font-mono);font-size:.58rem;letter-spacing:.3em;
color:var(–a3);text-transform:uppercase;
margin-bottom:24px;display:flex;align-items:center;gap:12px;
}
.credits-head::before{content:””;width:20px;height:1px;background:var(–a3);}
.credit{display:flex;align-items:center;gap:16px;padding:12px 0;border-bottom:1px solid var(–b0);}
.credit:last-child{border-bottom:none;padding-bottom:0;}
.avatar{
width:36px;height:36px;border-radius:50%;flex-shrink:0;
display:flex;align-items:center;justify-content:center;
font-family:var(–font-mono);font-size:.7rem;font-weight:700;
background:var(–s1);border:1px solid var(–b1);
}
.avatar.m{color:var(–a3);border-color:rgba(244,71,168,.35);}
.cname{font-weight:700;font-size:.9rem;color:var(–w);}
.crole{font-family:var(–font-mono);font-size:.6rem;color:var(–m2);margin-top:2px;}
.cheart{margin-left:auto;font-size:1.1rem;}

/* Footer */
footer{
border-top:1px solid var(–b0);padding-top:32px;
display:flex;justify-content:space-between;align-items:center;
flex-wrap:wrap;gap:12px;
}
footer span{font-family:var(–font-mono);font-size:.58rem;color:var(–m);letter-spacing:.1em;}
</style>

</head>
<body>
<div class="orb orb-1"></div>
<div class="orb orb-2"></div>
<div class="orb orb-3"></div>
<main>
  <header>
    <div class="kicker">OpenSubtitles Proxy Infrastructure</div>
    <h1>VOID<span class="dot">.</span><br><em>CINEMA</em></h1>
    <p class="sub">Unlimited search. Smart downloads. Auto-title. Malayalam-first. Built different.</p>
  </header>

  <div class="badges">
    <span class="badge live">Online</span>
    <span class="badge api">simpleXML + Session</span>
    <span class="badge">Auto-title</span>
    <span class="badge">ZIP extraction</span>
    <span class="badge">Malayalam first</span>
    <span class="badge">Exponential retry</span>
    <span class="badge">Meta cache</span>
    <span class="badge">Rate limited</span>
    <span class="badge">CORS open</span>
  </div>

  <div class="panel">
    <div class="panel-title">Live Status</div>
    <div class="stats-grid" id="sg">
      <div class="stat"><div class="stat-val">—</div><div class="stat-label">Uptime</div></div>
      <div class="stat"><div class="stat-val">—</div><div class="stat-label">Cookies</div></div>
      <div class="stat"><div class="stat-val">—</div><div class="stat-label">Search cache</div></div>
      <div class="stat"><div class="stat-val">—</div><div class="stat-label">Meta cache</div></div>
      <div class="stat"><div class="stat-val">—</div><div class="stat-label">Heap used</div></div>
      <div class="stat"><div class="stat-val">—</div><div class="stat-label">API quota</div></div>
    </div>
  </div>

  <div class="sl">Architecture</div>
  <div class="callout" style="margin-bottom:80px">
    <div class="callout-title">How it works</div>
    <p><b>SEARCH</b> — OpenSubtitles simpleXML endpoint. Unlimited, no login needed. Results stored in meta cache keyed by subtitle ID.</p>
    <p><b>DOWNLOAD</b> — Looks up cached metadata to auto-generate perfect filenames. Tries official REST API first (if configured), falls back to session-authenticated scraper. ZIP files are extracted automatically.</p>
    <p><b>AUTO-TITLE</b> — No need to pass &amp;title=. After any search, metadata is stored. Download just needs the ID.</p>
  </div>

  <div class="sl">Endpoints</div>
  <div class="eps">
    <div class="ep">
      <div class="ep-head"><span class="method">GET</span><span class="ep-url">/search?<span class="p">q</span>={query}<span class="o">&amp;lang={lang}&amp;type={movie|series}</span></span></div>
      <p class="ep-desc">Search subtitles. Malayalam auto-detected. Sorted ml → en → others by download count.</p>
      <div class="params"><span class="param req"><b>q</b> required</span><span class="param"><b>lang</b> ml/en/fr...</span><span class="param"><b>type</b> movie/series</span></div>
      <a class="try" href="/search?q=inception&lang=en">Try it</a>
    </div>
    <div class="ep">
      <div class="ep-head"><span class="method">GET</span><span class="ep-url">/download?<span class="p">id</span>={id}<span class="o">&amp;title={override}</span></span></div>
      <p class="ep-desc">Download subtitle. Auto-names from search metadata — no &amp;title= needed if you searched first. ZIP auto-extracted.</p>
      <div class="params"><span class="param req"><b>id</b> required</span><span class="param"><b>title</b> optional override</span></div>
      <a class="try" href="/download?id=3962439">Try it</a>
    </div>
    <div class="ep">
      <div class="ep-head"><span class="method">GET</span><span class="ep-url">/languages?<span class="p">q</span>={query}</span></div>
      <p class="ep-desc">All available language codes for a search query.</p>
      <a class="try" href="/languages?q=inception">Try it</a>
    </div>
    <div class="ep">
      <div class="ep-head"><span class="method">GET</span><span class="ep-url">/stats</span></div>
      <p class="ep-desc">Full server stats — uptime, caches, memory, API quota, session state.</p>
      <a class="try" href="/stats">Try it</a>
    </div>
    <div class="ep">
      <div class="ep-head"><span class="method">GET</span><span class="ep-url">/health</span></div>
      <p class="ep-desc">Health check. 200 when session ready, 503 when warming up.</p>
      <a class="try" href="/health">Try it</a>
    </div>
  </div>

  <div class="sl">Example Response</div>
  <pre><span class="ck">{</span>
  <span class="cs">"success"</span><span class="ck">:</span> <span class="cv">true</span><span class="ck">,</span>
  <span class="cs">"total"</span><span class="ck">:</span>   <span class="cv">40</span><span class="ck">,</span>
  <span class="cs">"results"</span><span class="ck">: [{</span>
    <span class="cs">"id"</span><span class="ck">:</span>          <span class="cb">"3962439"</span><span class="ck">,</span>
    <span class="cs">"title"</span><span class="ck">:</span>       <span class="cb">"Inception"</span><span class="ck">,</span>
    <span class="cs">"year"</span><span class="ck">:</span>        <span class="cb">"2010"</span><span class="ck">,</span>
    <span class="cs">"lang"</span><span class="ck">:</span>        <span class="cb">"en"</span><span class="ck">,</span>
    <span class="cs">"downloads"</span><span class="ck">:</span>  <span class="cv">132462</span><span class="ck">,</span>
    <span class="cs">"subfilename"</span><span class="ck">:</span><span class="cb">"Inception.2010.1080p.BluRay.srt"</span><span class="ck">,</span>
    <span class="cs">"type"</span><span class="ck">:</span>        <span class="cb">"movie"</span><span class="ck">,</span>
    <span class="cs">"features"</span><span class="ck">: {</span><span class="cs">"hd"</span><span class="ck">:</span><span class="cv">true</span><span class="ck">,</span><span class="cs">"trusted"</span><span class="ck">:</span><span class="cv">false</span><span class="ck">}</span>
  <span class="ck">}]</span>
<span class="ck">}</span></pre>

  <div class="sl">Built by</div>
  <div class="credits">
    <div class="credits-head">Credits</div>
    <div class="credit">
      <div class="avatar m">M</div>
      <div><div class="cname">munax</div><div class="crole">Creator — Architect — Vision</div></div>
      <span class="cheart">🩷</span>
    </div>
  </div>

  <footer>
    <span>VOID CINEMA API — ULTRA PEAK v13.0</span>
    <span>munax — 2026</span>
  </footer>
</main>

<script>
async function tick() {
  try {
    const d = await fetch('/stats').then(r => r.json());
    if (!d.success) return;
    const sg = document.getElementById('sg');
    const vals = [
      d.uptimeFormatted,
      d.cookieCount,
      d.cache.search.keys,
      d.cache.meta.keys,
      d.memory.heapUsed,
      d.officialApi.quota,
    ];
    const labels = ['Uptime','Cookies','Search cache','Meta cache','Heap used','API quota'];
    sg.innerHTML = vals.map((v, i) =>
      '<div class="stat"><div class="stat-val">' + v + '</div><div class="stat-label">' + labels[i] + '</div></div>'
    ).join('');
  } catch {}
}
tick();
setInterval(tick, 8000);
</script>

</body>
</html>`;

app.get(’/’, (req, res) => {
res.setHeader(‘Content-Type’, ‘text/html; charset=utf-8’);
res.setHeader(‘Cache-Control’, ‘public, max-age=3600’);
res.send(ROOT_HTML);
});

app.get(’/favicon.ico’, (req, res) => res.status(204).end());

// 404
app.use((req, res) => {
res.status(404).json({ success: false, error: ‘Endpoint not found. Visit / for docs.’ });
});

// Error handler
app.use((err, req, res, next) => {
log.error(‘Unhandled error’, { error: err.message, stack: IS_PROD ? undefined : err.stack });
res.status(500).json({ success: false, error: ‘server_error’ });
});

// =============================================================================
//  BACKGROUND JOBS
// =============================================================================
function startJobs() {
if (IS_SERVERLESS) return;

// Session refresh
setInterval(() => warmUpSession(), CFG.WARMUP_INTERVAL);

// Self-ping (keeps free tier alive)
if (NEEDS_PING) {
setInterval(() => {
axios.get(`${BASE_URL}/health`, { timeout: 6000 })
.then(r => log.info(‘Self-ping’, { status: r.status }))
.catch(e => log.warn(‘Self-ping failed’, { error: e.message }));
}, CFG.PING_INTERVAL);
}

// Official API token refresh
if (OS.apiKey) {
setInterval(() => { OS.token = null; osLogin(); }, 22 * 60 * 60 * 1000);
}

// Memory watchdog
setInterval(() => {
const used = process.memoryUsage().heapUsed;
if (used > CFG.MEMORY_LIMIT * CFG.MEMORY_WARN) {
log.warn(‘Memory threshold — flushing caches’, { heap: fmtBytes(used) });
searchCache.flushAll();
dlCache.flushAll();
metaCache.flushAll();
if (typeof global.gc === ‘function’) global.gc();
}
}, 5 * 60 * 1000);
}

// =============================================================================
//  GRACEFUL SHUTDOWN
// =============================================================================
let httpServer;

async function shutdown(sig) {
log.info(`${sig} received — shutting down gracefully`);
httpServer.close(() => {
log.info(‘HTTP server closed’);
process.exit(0);
});
setTimeout(() => {
log.error(‘Forced shutdown after timeout’);
process.exit(1);
}, 12000);
}

process.on(‘SIGTERM’, () => shutdown(‘SIGTERM’));
process.on(‘SIGINT’,  () => shutdown(‘SIGINT’));

// Safety net — log and survive unexpected errors instead of silent crash
process.on(‘uncaughtException’, (err) => {
log.error(‘uncaughtException — process continuing’, { error: err.message, stack: err.stack });
});

process.on(‘unhandledRejection’, (reason, promise) => {
const msg = reason instanceof Error ? reason.message : String(reason);
log.error(‘unhandledRejection’, { reason: msg });
});

// =============================================================================
//  STARTUP
// =============================================================================
module.exports = app; // Vercel

async function startup() {
log.info(‘VOID CINEMA — Ultra Peak v13.0 — starting’);
log.info(‘Platform’, { platform: PLATFORM, port: PORT, proxies: PROXY_POOL.length, officialApi: !!(OS.apiKey && OS.username) });

await warmUpSession();
if (OS.apiKey && OS.username && OS.password) await osLogin();
startJobs();

httpServer = app.listen(PORT, ‘0.0.0.0’, () => {
log.info(‘Server ready’, { url: BASE_URL });
log.info(`Try: ${BASE_URL}/search?q=inception&lang=en`);
});
}

if (require.main === module) {
startup().catch(e => {
log.error(‘Fatal startup error’, { error: e.message });
process.exit(1);
});
}
