'use strict';

// =============================================================================
//  VOID CINEMA  FINAL BOSS
//  Architecture: munax
//
//  SEARCH — 4 sources, first success wins:
//    S0  api.opensubtitles.com  official REST  NO proxy needed  MOST RELIABLE
//    S1  opensubtitles.org simpleXML           proxy rotation
//    S2  rest.opensubtitles.org old REST       different CF path, no auth
//    S3  sub.wyzie.io                          zero CF, direct JSON
//
//    Smart retry: if all 4 sources return 0 results,
//    auto-appends year variants ("Vikram" -> "Vikram 2022" etc.)
//
//  DOWNLOAD — 3 methods, first success wins:
//    M0  Official API download link   (when S0 used)
//    M1  Wyzie direct .url field      (when S3 used)
//    M2  dl.opensubtitles.org         proxy rotation (env + direct + free)
//    M3  subtitleserve fallback        proxy rotation
//
//  ENV VARS:
//    OS_API_KEY       opensubtitles.com/en/consumers  (or use default)
//    OS_USERNAME      opensubtitles account username
//    OS_PASSWORD      opensubtitles account password
//    WYZIE_KEY        sub.wyzie.io/redeem  (free, instant)
//    OMDB_API_KEY     omdbapi.com  (free)
//    TMDB_API_KEY     themoviedb.org  (free)
//    PROXY_URL        primary proxy
//    BACKUP_PROXY_1   up to BACKUP_PROXY_20
// =============================================================================

const express             = require('express');
const axios               = require('axios');
const cheerio             = require('cheerio');
const NodeCache           = require('node-cache');
const rateLimit           = require('express-rate-limit');
const cors                = require('cors');
const compression         = require('compression');
const AdmZip              = require('adm-zip');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const zlib                = require('zlib');
const https               = require('https');
const path                = require('path');
const { randomUUID }      = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// =============================================================================
//  PLATFORM
// =============================================================================
const PLATFORM = (() => {
if (process.env.RENDER === 'true' || process.env.RENDER_EXTERNAL_URL) return 'render';
if (process.env.KOYEB_APP_NAME    || process.env.KOYEB)               return 'koyeb';
if (process.env.VERCEL            || process.env.VERCEL_URL)           return 'vercel';
if (process.env.RAILWAY_STATIC_URL|| process.env.RAILWAY_ENVIRONMENT)  return 'railway';
if (process.env.FLY_APP_NAME)                                          return 'fly';
return 'local';
})();

const BASE_URL = (() => {
if (PLATFORM === 'render')  return process.env.RENDER_EXTERNAL_URL  || ('http://localhost:' + PORT);
if (PLATFORM === 'koyeb')   return 'https://' + (process.env.KOYEB_PUBLIC_DOMAIN || ((process.env.KOYEB_APP_NAME || 'app') + '.koyeb.app'));
if (PLATFORM === 'vercel')  return process.env.VERCEL_URL ? ('https://' + process.env.VERCEL_URL) : ('http://localhost:' + PORT);
if (PLATFORM === 'railway') return process.env.RAILWAY_STATIC_URL   || ('http://localhost:' + PORT);
if (PLATFORM === 'fly')     return 'https://' + process.env.FLY_APP_NAME + '.fly.dev';
return 'http://localhost:' + PORT;
})();

const IS_SERVERLESS = PLATFORM === 'vercel';
app.set('trust proxy', IS_SERVERLESS ? false : 1);

// =============================================================================
//  CONFIG
// =============================================================================
const CFG = {
CACHE_SEARCH_TTL : parseInt(process.env.CACHE_TTL_SEARCH)   || 600,
CACHE_DL_TTL     : parseInt(process.env.CACHE_TTL_DL)       || 1800,
CACHE_META_TTL   : 3600,
CACHE_IMDB_TTL   : 7 * 24 * 3600,
RATE_MAX         : parseInt(process.env.RATE_LIMIT_MAX)     || 100,
RATE_WINDOW_MS   : 15 * 60 * 1000,
REQ_TIMEOUT      : parseInt(process.env.REQUEST_TIMEOUT_MS) || 22000,
MAX_RESULTS      : 40,
MAX_ZIP_SIZE     : 10 * 1024 * 1024,
WARMUP_INTERVAL  : 90 * 60 * 1000,
PING_INTERVAL    : 9  * 60 * 1000,
MEMORY_LIMIT     : (parseInt(process.env.MEMORY_LIMIT_MB) || 512) * 1024 * 1024,
MEMORY_WARN      : 0.80,
// Official OS API — defaults from friend's working account, override via env
OS_API_KEY  : process.env.OS_API_KEY   || '',
OS_USERNAME : process.env.OS_USERNAME  || '',
OS_PASSWORD : process.env.OS_PASSWORD  || '',
OS_UA       : process.env.OS_USER_AGENT || 'VoidCinema/1.0',
// Optional backup sources
WYZIE_KEY   : process.env.WYZIE_KEY    || '',
OMDB_KEY    : process.env.OMDB_API_KEY || '',
TMDB_KEY    : process.env.TMDB_API_KEY || '',
};

// =============================================================================
//  LOGGER
// =============================================================================
const log = {
_o: (lvl, msg, meta) => {
const o = { level: lvl, timestamp: new Date().toISOString(), msg };
if (meta && Object.keys(meta).length) Object.assign(o, meta);
return JSON.stringify(o);
},
info  : (msg, m) => console.log(log._o('info',  msg, m)),
warn  : (msg, m) => console.warn(log._o('warn',  msg, m)),
error : (msg, m) => console.error(log._o('error', msg, m)),
debug : (msg, m) => { if (process.env.DEBUG) console.debug(log._o('debug', msg, m)); },
};

// =============================================================================
//  GLOBAL HANDLERS (after log so they can use it)
// =============================================================================
process.on('uncaughtException',  err    => log.error('Uncaught exception',  { error: err.message }));
process.on('unhandledRejection', reason => log.error('Unhandled rejection', { reason: String(reason && reason.message ? reason.message : reason) }));

// =============================================================================
//  CACHES
// =============================================================================
const searchCache = new NodeCache({ stdTTL: CFG.CACHE_SEARCH_TTL, checkperiod: 120, useClones: false, maxKeys: 2000 });
const dlCache     = new NodeCache({ stdTTL: CFG.CACHE_DL_TTL,     checkperiod: 180, useClones: false, maxKeys: 500  });
const metaCache   = new NodeCache({ stdTTL: CFG.CACHE_META_TTL,   checkperiod: 300, useClones: false, maxKeys: 5000 });
const imdbCache   = new NodeCache({ stdTTL: CFG.CACHE_IMDB_TTL,   checkperiod: 600, useClones: false });
const inFlight    = new Map();

// =============================================================================
//  OFFICIAL OS API TOKEN
// =============================================================================
let osToken       = '';
let osTokenExpiry = 0;
let osQuotaUsed   = 0;
let osQuotaMax    = 100;

async function getOsToken() {
if (osToken && Date.now() < osTokenExpiry) return osToken;
try {
const res = await axios.post(
'https://api.opensubtitles.com/api/v1/login',
{ username: CFG.OS_USERNAME, password: CFG.OS_PASSWORD },
{ headers: { 'Api-Key': CFG.OS_API_KEY, 'User-Agent': CFG.OS_UA, 'Content-Type': 'application/json' }, timeout: 12000 }
);
if (res.data && res.data.token) {
osToken       = res.data.token;
osTokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
osQuotaUsed   = 0;
osQuotaMax    = (res.data.user && res.data.user.allowed_downloads) ? res.data.user.allowed_downloads : 100;
log.info('OS API token OK', { quota: osQuotaMax });
return osToken;
}
throw new Error('No token in response');
} catch (e) {
log.warn('OS API login failed', { error: e.message });
osToken = '';
return '';
}
}

// =============================================================================
//  PROXY POOL
// =============================================================================
function buildProxyPool() {
const list = [];
if (process.env.PROXY_URL) list.push({ url: process.env.PROXY_URL, label: 'primary' });
for (let i = 1; i <= 20; i++) {
const v = process.env['BACKUP_PROXY_' + i];
if (v) list.push({ url: v, label: 'backup_' + i });
}
return list.map(p => {
try {
const agent = p.url.startsWith('socks') ? new SocksProxyAgent(p.url) : new HttpsProxyAgent(p.url);
return { label: p.label, agent, masked: p.url.replace(/:([^:@]{3})[^:@]*@/, ':***@') };
} catch (e) { log.warn('Invalid proxy skipped', { label: p.label, error: e.message }); return null; }
}).filter(Boolean);
}

let PROXY_POOL  = buildProxyPool();
let proxyIdx    = 0;
let proxyFails  = 0;

function getProxy()   { return PROXY_POOL.length ? PROXY_POOL[proxyIdx % PROXY_POOL.length] : null; }
function proxyOK()    { proxyFails = 0; }
function proxyFail(r) {
proxyFails++;
if (proxyFails >= 2 && PROXY_POOL.length > 1) {
const prev = getProxy();
proxyIdx   = (proxyIdx + 1) % PROXY_POOL.length;
proxyFails = 0;
log.warn('Proxy rotated', { from: prev.label, to: getProxy().label, reason: r });
}
}

// =============================================================================
//  FREE PROXY FALLBACK
// =============================================================================
let freeProxies        = [];
let workingFreeProxies = [];
let freeProxyFetched   = 0;

async function fetchFreeProxies(force) {
const now = Date.now();
if (!force && freeProxies.length && (now - freeProxyFetched) < 30 * 60 * 1000) return;
try {
const r = await axios.get('https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt', { timeout: 10000 });
freeProxies = [...new Set(
r.data.split('\n').map(l => l.trim().replace(/\r$/, '')).filter(l => l && l.includes(':') && !l.startsWith('#'))
)].slice(0, 200);
freeProxyFetched = now;
log.info('Free proxies loaded', { count: freeProxies.length });
} catch (e) { log.warn('Free proxy fetch failed', { error: e.message }); }
}

async function getWorkingFreeProxy() {
if (workingFreeProxies.length) return workingFreeProxies[Math.floor(Math.random() * workingFreeProxies.length)];
const candidates = [...freeProxies].sort(() => 0.5 - Math.random()).slice(0, 8);
// Test concurrently instead of sequentially — much faster
const results = await Promise.allSettled(candidates.map(async p => {
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 5000);
try {
const agent = new HttpsProxyAgent('http://' + p);
const res   = await axios.get('https://www.opensubtitles.org/en', {
httpsAgent: agent, signal: controller.signal,
timeout: 5000, headers: { 'User-Agent': nextUA() }
});
return res.status === 200 ? p : null;
} catch { return null; }
finally { clearTimeout(timer); }
}));
const working = results
.filter(r => r.status === 'fulfilled' && r.value)
.map(r => r.value);
if (working.length) {
workingFreeProxies = working.slice(0, 10);
return workingFreeProxies[0];
}
return null;
}

// =============================================================================
//  TLS + USER AGENTS
// =============================================================================
const TLS = new https.Agent({
keepAlive: true, keepAliveMsecs: 30000, maxSockets: 20, minVersion: 'TLSv1.2',
honorCipherOrder: true,
ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384',
});

const UA = [
'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0',
'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
];
let uaIdx = 0;
const nextUA = () => UA[uaIdx++ % UA.length];

const BASE_HDR = {
'Accept'                    : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
'Accept-Language'           : 'en-US,en;q=0.9',
'Accept-Encoding'           : 'gzip, deflate, br',
'Connection'                : 'keep-alive',
'Upgrade-Insecure-Requests' : '1',
'Sec-Fetch-Dest'            : 'document',
'Sec-Fetch-Mode'            : 'navigate',
'Sec-Fetch-Site'            : 'none',
'Sec-Fetch-User'            : '?1',
};

// =============================================================================
//  COOKIE JAR + SESSION
// =============================================================================
const cookieJar = new Map([['lang', 'en'], ['oslocale', 'en']]);

function getCookieStr() {
const c = []; cookieJar.forEach((v, k) => c.push(k + '=' + v)); return c.join('; ');
}
function extractCookies(res) {
const sc = res && res.headers && res.headers['set-cookie'];
if (!Array.isArray(sc)) return;
sc.forEach(raw => {
const pair = raw.split(';')[0]; const eq = pair.indexOf('=');
if (eq > 0) cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
});
}

let sessionReady   = false;
let _warmupPromise = null;

async function warmup() {
if (_warmupPromise) return _warmupPromise;
const p = (async () => {
log.info('Session warmup…');
try {
const res = await axios.get('https://www.opensubtitles.org/en', {
httpsAgent: TLS, timeout: 12000, maxRedirects: 3,
headers: Object.assign({}, BASE_HDR, { 'User-Agent': nextUA() }),
validateStatus: () => true,
});
extractCookies(res);
sessionReady = res.status === 200;
log.info(sessionReady ? 'Session ready' : 'Session degraded', { status: res.status });
} catch (e) {
log.warn('Warmup failed, continuing', { error: e.message });
sessionReady = false;
} finally {
if (_warmupPromise === p) _warmupPromise = null;
}
})();
_warmupPromise = p;
return p;
}

// =============================================================================
//  HELPERS
// =============================================================================
const LANG_PRIORITY = ['ml', 'en', 'hi', 'ta', 'te', 'fr', 'es', 'de', 'ja', 'ko', 'zh'];

function sortResults(results, preferLang) {
const pMap = new Map(LANG_PRIORITY.map((l, i) => [l, i]));
if (preferLang && !pMap.has(preferLang)) pMap.set(preferLang, -1);
return results.sort((a, b) => {
const ap = pMap.has(a.lang) ? pMap.get(a.lang) : LANG_PRIORITY.length;
const bp = pMap.has(b.lang) ? pMap.get(b.lang) : LANG_PRIORITY.length;
if (ap !== bp) return ap - bp;
return (b.downloads || 0) - (a.downloads || 0);
});
}

function dedup(arr) {
const seen = new Set();
return arr.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
}

function detectML(q)  { return /\bml\b|malayalam|mallu|mala/i.test(q || ''); }

function safeName(s) {
return (s || '')
.replace(/[^a-z0-9.-]/gi, '*')
.replace(/\*+/g, '*')
.replace(/^\*|\*$/g, '');
}

function bestFilename(id, meta, cd, zipEntry, titleOverride) {
// Priority 1: explicit title override (from &title= param or encoded in URL)
if (titleOverride && titleOverride.trim().length > 1) {
const t = safeName(titleOverride.trim());
return /\.(srt|ass|ssa|sub|smi)$/i.test(t) ? t : t + '.srt';
}
// Priority 2: subfilename from meta cache (real release filename e.g. Fight.Club.1999.BluRay.srt)
if (meta && meta.subfilename && meta.subfilename.trim().length > 4) {
const f = safeName(meta.subfilename.trim());
return /\.(srt|ass|ssa|sub|smi)$/i.test(f) ? f : f + '.srt';
}
// Priority 3: Content-Disposition header from server
if (cd) {
const m = cd.match(/filename[^;=\n]*=([\'"]?)([^\n\'"]*)\1/i);
if (m && m[2]) {
let n = m[2].trim();
if (n.endsWith('.gz')) n = n.slice(0, -3);
if (!/\.(srt|ass|ssa|sub|smi)$/i.test(n)) n += '.srt';
return safeName(path.basename(n));
}
}
// Priority 4: ZIP entry name (contains real release info)
if (zipEntry) return safeName(path.basename(zipEntry));
// Priority 5: construct from meta title + year + lang
if (meta && meta.title) {
const parts = [safeName(meta.title)];
if (meta.year)  parts.push(meta.year);
if (meta.lang && meta.lang !== 'en') parts.push(meta.lang);
return parts.filter(Boolean).join('*') + '.srt';
}
return 'subtitle*' + id + '.srt';
}

function isHtml(buf) {
return /<(html|!doctype|body)/i.test(Buffer.isBuffer(buf) ? buf.subarray(0, 300).toString() : String(buf).slice(0, 300));
}

function extractZip(buf, lang) {
const zip     = new AdmZip(buf);
const entries = zip.getEntries().filter(e => !e.isDirectory && /\.(srt|ass|ssa|sub|smi)$/i.test(e.entryName));
if (!entries.length) return null;
entries.forEach(e => { if (e.header.size > CFG.MAX_ZIP_SIZE) throw new Error('ZIP entry too large'); });
const srt  = entries.filter(e => /\.srt$/i.test(e.entryName));
const pool = srt.length ? srt : entries;
let   best = pool.length > 1 ? pool.reduce((a, b) => b.header.size > a.header.size ? b : a) : pool[0];
if (lang) { const lm = pool.find(e => e.entryName.toLowerCase().includes(lang)); if (lm) best = lm; }
return { buffer: best.getData(), name: best.entryName };
}

function normalizeResult(r) {
const feat = Object.assign({ hd: false, trusted: false, hearing_impaired: false }, r.features || {});
const obj = {
id       : String(r.id || ''),
title    : r.title || '',
year     : r.year  || null,
lang     : (r.lang || 'en').toLowerCase(),
language : r.langName || r.lang || '',
downloads: r.downloads || 0,
filename : r.subfilename || '',
type     : r.type   || 'movie',
source   : r.source || 'unknown',
hd       : feat.hd       || false,
trusted  : feat.trusted  || false,
hi       : feat.hearing_impaired || false,
};
// Only include non-empty optional fields
if (r.release && r.release.trim()) obj.release = r.release.trim();
if (r.directUrl) obj.directUrl = r.directUrl;
return obj;
}

// =============================================================================
//  SOURCE 0 — OFFICIAL OS REST API  (most reliable, no CF, 100/day)
// =============================================================================
async function searchOfficial(query, lang) {
const token = await getOsToken();
if (!token) throw new Error('No OS API token');

const params = { query, per_page: 60 };
if (lang && lang !== 'all') params.languages = lang;

const res = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
params,
headers: {
'Api-Key'       : CFG.OS_API_KEY,
'Authorization' : 'Bearer ' + token,
'User-Agent'    : CFG.OS_UA,
'Content-Type'  : 'application/json',
},
timeout: 15000,
validateStatus: () => true,
});

if (res.status === 401) { osToken = ''; throw new Error('OS token expired'); }
if (res.status === 429) throw new Error('OS API rate limited');
if (res.status !== 200) throw new Error('OS API HTTP ' + res.status);

const items = (res.data && res.data.data) || [];

const results = items.map(item => {
const attrs = item.attributes || {};
const files = (attrs.files || [])[0] || {};
const id    = String(files.file_id || item.id || '');
if (!id) return null;
const slang = (attrs.language || lang || 'en').toLowerCase();
const fd    = attrs.feature_details || {};
const meta  = {
title      : attrs.movie_name || fd.movie_name || '',
year       : fd.year ? String(fd.year) : null,
lang       : slang,
subfilename: files.file_name || '',
};
metaCache.set(id, meta);
return normalizeResult({
id,
title       : meta.title,
year        : meta.year,
lang        : slang,
langName    : attrs.language || slang,
downloads   : attrs.download_count || 0,
subfilename : meta.subfilename,
type        : fd.feature_type === 'Episode' ? 'series' : 'movie',
source      : 'official',
features    : { hd: attrs.hd || false, trusted: attrs.from_trusted || false, hearing_impaired: attrs.hearing_impaired || false },
});
}).filter(Boolean);

log.info('S0 (official) OK', { count: results.length, query });
return results;
}

// =============================================================================
//  SOURCE 1 — simpleXML SCRAPING  (proxy rotation)
// =============================================================================
async function searchSimpleXML(query) {
const url = 'https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-' + encodeURIComponent(query) + '/simplexml';

const tryReq = async (agent) => {
const res = await axios.get(url, {
httpsAgent    : agent,
timeout       : CFG.REQ_TIMEOUT,
headers       : Object.assign({}, BASE_HDR, { 'User-Agent': nextUA(), 'Cookie': getCookieStr() }),
maxRedirects  : 3,
validateStatus: () => true,
});
extractCookies(res);
return res;
};

let res = null;

if (PROXY_POOL.length) {
for (let i = 0; i < Math.min(2, PROXY_POOL.length); i++) {
try { res = await tryReq(getProxy().agent); if (res.status === 200) { proxyOK(); break; } proxyFail('HTTP ' + res.status); res = null; }
catch (e) { proxyFail(e.message); res = null; }
}
}
if (!res || res.status !== 200) { try { res = await tryReq(TLS); } catch { res = null; } }
if (!res || res.status !== 200) {
const fp = await getWorkingFreeProxy();
if (fp) {
try { res = await tryReq(new HttpsProxyAgent('http://' + fp)); }
catch { workingFreeProxies = workingFreeProxies.filter(p => p !== fp); res = null; }
}
}

if (!res || res.status !== 200) throw new Error('simpleXML HTTP ' + (res ? res.status : 'no response'));

const $ = cheerio.load(res.data, { xmlMode: true });
const results = [];
$('subtitle').each((_, el) => {
const $e = $(el);
const rawTitle = ($e.find('moviename').text() || $e.find('releasename').text() || '').replace(/\s+/g, ' ').trim();
const id       = $e.find('idsubtitle').text().trim();
const subfile  = $e.find('subfilename').text().trim();
const slang    = $e.find('iso639').text().trim();
if (!id || !rawTitle) return;
const yearMatch = rawTitle.match(/(((19|20)\d{2}))/);
const year  = yearMatch ? yearMatch[1] : null;
const title = rawTitle.replace(/\s*((19|20)\d{2})$/, '').trim();
metaCache.set(id, { title, year, lang: slang, subfilename: subfile });
results.push(normalizeResult({
id, title, year,
lang        : slang,
langName    : $e.find('language').text().trim(),
downloads   : parseInt($e.find('subdownloads').text(), 10) || 0,
subfilename : subfile,
type        : $e.find('moviekind').text() === 'episode' ? 'series' : 'movie',
source      : 'opensubtitles',
features    : { hd: $e.find('subhd').text() === '1', trusted: $e.find('subtrusted').text() === '1', hearing_impaired: $e.find('subhearingimpaired').text() === '1' },
}));
});

log.info('S1 (simpleXML) OK', { count: results.length, query });
return results;
}

// =============================================================================
//  SOURCE 2 — rest.opensubtitles.org  (different domain, different CF rules)
// =============================================================================
async function searchOldRest(query, lang) {
const langCode = (lang && lang !== 'all') ? lang : 'all';
const url      = 'https://rest.opensubtitles.org/search/sublanguageid-' + langCode + '/query-' + encodeURIComponent(query);
const headers  = { 'User-Agent': 'TemporaryUserAgent', 'X-User-Agent': 'TemporaryUserAgent', 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' };

let res = null;
try { res = await axios.get(url, { headers, httpsAgent: TLS, timeout: 15000, maxRedirects: 3, validateStatus: () => true }); } catch { res = null; }

if ((!res || res.status !== 200) && PROXY_POOL.length) {
try { res = await axios.get(url, { headers, httpsAgent: getProxy().agent, timeout: 15000, maxRedirects: 3, validateStatus: () => true }); if (res && res.status === 200) proxyOK(); }
catch { res = null; }
}

if (!res || res.status !== 200 || !Array.isArray(res.data)) throw new Error('OldREST HTTP ' + (res ? res.status : 'no response'));

const results = res.data.map(item => {
const id = item.IDSubtitleFile || item.IDSubtitle || '';
if (!id) return null;
const slang = (item.SubLanguageID || 'en').toLowerCase();
metaCache.set(id, { title: item.MovieName || query, year: item.MovieYear || null, lang: slang, subfilename: item.SubFileName || '' });
return normalizeResult({
id,
title       : item.MovieName || query,
year        : item.MovieYear || null,
lang        : slang,
langName    : item.LanguageName || slang,
downloads   : parseInt(item.SubDownloadsCnt || '0', 10) || 0,
subfilename : item.SubFileName || '',
type        : item.MovieKind === 'episode' ? 'series' : 'movie',
source      : 'opensubtitles-rest',
features    : { hd: item.SubHD === '1', trusted: item.SubFromTrusted === '1', hearing_impaired: item.SubHearingImpaired === '1' },
});
}).filter(Boolean);

log.info('S2 (OldREST) OK', { count: results.length, query });
return results;
}

// =============================================================================
//  SOURCE 3 — WYZIE SUBS  (zero CF, direct download URLs)
// =============================================================================
async function getImdbId(title, year) {
const key    = 'imdb:' + title.toLowerCase() + (year ? ':' + year : '');
const cached = imdbCache.get(key);
if (cached) return cached;

// OMDB
try {
const params = { t: title, type: 'movie', r: 'json' };
if (year) params.y = year;
if (CFG.OMDB_KEY) params.apikey = CFG.OMDB_KEY;
const res = await axios.get('https://www.omdbapi.com/', { params, timeout: 8000 });
if (res.data && res.data.Response === 'True' && res.data.imdbID) {
imdbCache.set(key, res.data.imdbID); return res.data.imdbID;
}
} catch (e) { log.debug('OMDB failed', { error: e.message }); }

// TMDB fallback
if (CFG.TMDB_KEY) {
try {
const res = await axios.get('https://api.themoviedb.org/3/search/movie', {
params: { api_key: CFG.TMDB_KEY, query: title, year: year || undefined }, timeout: 8000,
});
const r0 = res.data && res.data.results && res.data.results[0];
if (r0 && r0.id) {
const ext = await axios.get('https://api.themoviedb.org/3/movie/' + r0.id + '/external_ids', { params: { api_key: CFG.TMDB_KEY }, timeout: 8000 });
if (ext.data && ext.data.imdb_id) { imdbCache.set(key, ext.data.imdb_id); return ext.data.imdb_id; }
}
} catch (e) { log.debug('TMDB failed', { error: e.message }); }
}

return null;
}

async function searchWyzie(query, lang) {
if (!CFG.WYZIE_KEY) throw new Error('WYZIE_KEY not configured');
const imdbId = await getImdbId(query);
if (!imdbId) throw new Error('Could not resolve IMDB ID for Wyzie: ' + query);

const params = { id: imdbId, source: 'all', format: 'srt,ass,sub', key: CFG.WYZIE_KEY };
if (lang && lang !== 'all') params.language = lang;

const res = await axios.get('https://sub.wyzie.io/search', {
params, timeout: 15000,
headers: { 'User-Agent': nextUA(), 'Accept': 'application/json' },
validateStatus: () => true,
});

if (res.status === 401) throw new Error('Wyzie invalid key');
if (res.status === 429) throw new Error('Wyzie rate limited');
if (res.status !== 200) throw new Error('Wyzie HTTP ' + res.status);

const data = Array.isArray(res.data) ? res.data : [];
const results = data.map(item => {
const id = String(item.id || '');
if (!id || !item.url) return null;
const slang = (item.language || 'en').toLowerCase().slice(0, 2);
metaCache.set(id, { title: item.media || query, lang: slang, subfilename: item.fileName || '', directUrl: item.url });
return normalizeResult({
id,
title       : item.media || query,
lang        : slang,
langName    : item.display || slang,
downloads   : item.downloadCount || 0,
subfilename : item.fileName || '',
release     : item.release || '',
type        : 'movie',
source      : 'wyzie',
directUrl   : item.url,
features    : { hearing_impaired: item.isHearingImpaired || false },
});
}).filter(Boolean);

log.info('S3 (Wyzie) OK', { count: results.length, query, imdbId });
return results;
}

// =============================================================================
//  UNIFIED SEARCH — 4 sources + smart year-variant retry
// =============================================================================
async function unifiedSearch(query, lang, type) {
const ck     = 'search:' + query + ':' + (lang || 'all') + ':' + (type || 'all');
const cached = searchCache.get(ck);
if (cached) return Object.assign({}, cached, { fromCache: true });
if (inFlight.has(ck)) return inFlight.get(ck);

const promise = (async () => {
// Year variants: try original first, then append recent years
const yr = new Date().getFullYear();
const variants = [query];
if (!/\b(19|20)\d{2}\b/.test(query)) {
variants.push(query + ' ' + (yr - 1), query + ' ' + yr, query + ' ' + (yr - 2));
}

let results = [], source = '';
const errors = [];

outer: for (const variant of variants) {
  // S0: Official API
  try {
    results = await searchOfficial(variant, lang);
    if (results.length) { source = 'official'; break outer; }
  } catch (e) { errors.push('S0:' + e.message); }

  // S1: simpleXML
  try {
    results = await searchSimpleXML(variant);
    if (results.length) { source = 'opensubtitles'; break outer; }
  } catch (e) { errors.push('S1:' + e.message); }

  // S2: Old REST
  try {
    results = await searchOldRest(variant, lang);
    if (results.length) { source = 'opensubtitles-rest'; break outer; }
  } catch (e) { errors.push('S2:' + e.message); }

  // S3: Wyzie
  try {
    results = await searchWyzie(variant, lang);
    if (results.length) { source = 'wyzie'; break outer; }
  } catch (e) { errors.push('S3:' + e.message); }
}

if (!results.length) throw new Error('All 4 sources exhausted: ' + errors.slice(0, 4).join(' | '));

if (lang && lang !== 'all') results = results.filter(r => r.lang === lang.toLowerCase());
if (type && type !== 'all') results = results.filter(r => r.type === type);

results = sortResults(dedup(results), lang || 'ml').slice(0, CFG.MAX_RESULTS);

const payload = { query, lang, total: results.length, source, fromCache: false, results };
searchCache.set(ck, payload);
log.info('Search done', { query, total: results.length, source });
return payload;
})();

inFlight.set(ck, promise);
promise.finally(() => inFlight.delete(ck));
return promise;
}

// =============================================================================
//  DOWNLOAD — 4 methods
// =============================================================================
async function downloadSub(id, titleOverride) {
const ck     = 'dl:' + id;
const cached = dlCache.get(ck);
if (cached) return cached;

const meta = metaCache.get(id) || null;

// M0: Official API download
if (osToken || (await getOsToken())) {
if (osQuotaUsed < osQuotaMax) {
try {
const dlRes = await axios.post('https://api.opensubtitles.com/api/v1/download',
{ file_id: parseInt(id, 10) },
{ headers: { 'Api-Key': CFG.OS_API_KEY, 'Authorization': 'Bearer ' + osToken, 'User-Agent': CFG.OS_UA, 'Content-Type': 'application/json' }, timeout: 15000 }
);
if (dlRes.data && dlRes.data.link) {
osQuotaUsed++;
const fileRes = await axios.get(dlRes.data.link, { responseType: 'arraybuffer', timeout: 20000, headers: { 'User-Agent': nextUA() } });
let buf = Buffer.from(fileRes.data);
if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = zlib.gunzipSync(buf); } catch {} }
if (!isHtml(buf) && buf.length > 50) {
const fn = bestFilename(id, meta, '', null, titleOverride || (dlRes.data.file_name ? safeName(dlRes.data.file_name) : ''));
const result = { buffer: buf, filename: fn };
dlCache.set(ck, result);
log.info('Download M0 (official)', { id, filename: fn, quota: osQuotaUsed + '/' + osQuotaMax });
return result;
}
}
} catch (e) { log.warn('M0 official DL failed', { error: e.message }); }
}
}

// M1: Wyzie direct URL
const directUrl = meta && meta.directUrl ? meta.directUrl : null;
if (directUrl) {
try {
const res = await axios.get(directUrl, { responseType: 'arraybuffer', timeout: 20000, headers: { 'User-Agent': nextUA() }, validateStatus: () => true });
if (res.status === 200) {
let buf = Buffer.from(res.data);
if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = zlib.gunzipSync(buf); } catch {} }
if (!isHtml(buf) && buf.length > 50) {
const fn = bestFilename(id, meta, '', null, titleOverride);
const result = { buffer: buf, filename: fn };
dlCache.set(ck, result);
log.info('Download M1 (wyzie direct)', { id, filename: fn });
return result;
}
}
} catch (e) { log.warn('M1 wyzie DL failed', { error: e.message }); }
}

// M2 + M3: scraper with proxy rotation
const dlUrls = [
'https://dl.opensubtitles.org/en/download/sub/' + id,
'https://www.opensubtitles.org/en/subtitleserve/sub/' + id,
];

for (const url of dlUrls) {
const agents = [];
const proxy  = getProxy();
if (proxy) agents.push({ agent: proxy.agent, label: proxy.label, proxy: null });
agents.push({ agent: TLS, label: 'direct', proxy: null });
if (workingFreeProxies.length) {
const fp = workingFreeProxies[0];
try { agents.push({ agent: new HttpsProxyAgent('http://' + fp), label: 'free', proxy: fp }); } catch {}
}

for (const { agent, label, proxy } of agents) {
  try {
    const res = await axios.get(url, {
      httpsAgent   : agent,
      responseType : 'arraybuffer',
      timeout      : 20000,
      headers      : Object.assign({}, BASE_HDR, { 'User-Agent': nextUA(), 'Referer': 'https://www.opensubtitles.org/en/subtitles/' + id, 'Cookie': getCookieStr() }),
      maxRedirects : 5,
      validateStatus: () => true,
    });
    extractCookies(res);
    if (res.status !== 200) continue;
    let buf = Buffer.from(res.data);
    if (buf.length < 20) continue;
    if (buf.length > CFG.MAX_ZIP_SIZE) { log.warn('File too large, skipping', { bytes: buf.length }); continue; }
    if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = zlib.gunzipSync(buf); } catch { continue; } }
    if (isHtml(buf)) continue;
    const cd     = (res.headers && res.headers['content-disposition']) || '';
    let zipEntry = null;
    if (buf[0] === 0x50 && buf[1] === 0x4B) {
      try { const ex = extractZip(buf, meta && meta.lang); if (ex) { buf = ex.buffer; zipEntry = ex.name; } }
      catch (e) { log.warn('ZIP failed', { error: e.message }); continue; }
    }
    const fn = bestFilename(id, meta, cd, zipEntry, titleOverride);
    const result = { buffer: buf, filename: fn };
    dlCache.set(ck, result);
    if (label !== 'direct') proxyOK();
    log.info('Download M2/M3 (scraper)', { id, filename: fn, via: label });
    return result;
  } catch (e) {
    if (label !== 'direct') proxyFail(e.message);
    // Remove dead free proxy immediately
    if (label === 'free' && proxy) {
      workingFreeProxies = workingFreeProxies.filter(p => p !== proxy);
    }
  }
}
}

throw new Error('All download methods failed for id=' + id);
}

// =============================================================================
//  MIDDLEWARE
// =============================================================================
app.use(compression());
app.use(cors({ origin: '*', methods: ['GET', 'OPTIONS'] }));
app.use(express.json({ limit: '512kb' }));

app.use((req, res, next) => {
res.setHeader('X-Content-Type-Options', 'nosniff');
res.setHeader('X-Frame-Options', 'DENY');
res.setHeader('X-Powered-By', 'VOID CINEMA');
next();
});

// X-Response-Time — intercept res.end, safe, no ERR_HTTP_HEADERS_SENT
app.use((req, res, next) => {
req.rid    = req.headers['x-request-id'] || randomUUID();
req._start = Date.now();
res.setHeader('X-Request-ID', req.rid);
const orig = res.end.bind(res);
res.end = function(chunk, encoding, cb) {
if (!res.headersSent) { try { res.setHeader('X-Response-Time', (Date.now() - req._start) + 'ms'); } catch (e) {} }
return orig(chunk, encoding, cb);
};
next();
});

const limiter = rateLimit({
windowMs: CFG.RATE_WINDOW_MS, max: CFG.RATE_MAX,
standardHeaders: true, legacyHeaders: false,
keyGenerator: req => req.rid || req.ip,
handler: (req, res) => {
res.setHeader('Retry-After', Math.ceil(CFG.RATE_WINDOW_MS / 1000));
res.status(429).json({ ok: false, error: 'Rate limit exceeded.', retryAfterSeconds: Math.ceil(CFG.RATE_WINDOW_MS / 1000) });
},
});

// =============================================================================
//  ROUTES
// =============================================================================
app.get('/search', limiter, async (req, res) => {
let { q, lang, type } = req.query;
if (!q) return res.status(400).json({ ok: false, error: 'Missing q' });
q = q.trim().slice(0, 200);
if (!lang && detectML(q)) lang = 'ml';
try {
const t0   = Date.now();
const data = await unifiedSearch(q, lang || null, type || null);
const ms   = Date.now() - req._start;

// Attach download path to each result
const results = data.results.map(r => {
  const out = Object.assign({}, r);
  // Encode title into URL so filename is always correct even if metaCache expires
  const slug = [
    (r.title || '').replace(/[^a-z0-9]/gi, '_').replace(/_+/g,'_').replace(/^_|_$/,''),
    r.year || '',
    r.lang || '',
  ].filter(Boolean).join('_');
  out.download = '/download?id=' + r.id + (slug ? '&title=' + encodeURIComponent(slug) : '');
  return out;
});

const payload = {
  ok     : true,
  query  : { text: q, lang: lang || null, type: type || null },
  meta   : { total: data.total, source: data.source, cached: !!data.fromCache, ms },
  results,
};

const etag = '"' + Buffer.from(q + (lang || '') + data.total).toString('base64').slice(0, 20) + '"';
if (req.headers['if-none-match'] === etag) return res.status(304).end();
res.setHeader('ETag', etag);
return res.json(payload);

} catch (e) {
log.error('Search error', { error: e.message, q, rid: req.rid });
return res.status(500).json({ ok: false, error: 'Search failed.', detail: e.message });
}
});

app.get('/download', limiter, async (req, res) => {
const { id, title } = req.query;
if (!id || !/^\d{1,20}$/.test(id.trim())) return res.status(400).json({ ok: false, error: 'Invalid or missing id' });
try {
const result = await downloadSub(id.trim(), title || null);
res.setHeader('Content-Type', 'text/plain; charset=utf-8');
res.setHeader('Content-Disposition', 'attachment; filename="' + result.filename + '"');
res.setHeader('Content-Length', result.buffer.length);
return res.send(result.buffer);
} catch (e) {
log.error('Download error', { error: e.message, id, rid: req.rid });
return res.status(500).json({ ok: false, error: 'Download failed.', detail: e.message });
}
});

app.get('/languages', limiter, async (req, res) => {
const { q } = req.query;
if (!q) return res.status(400).json({ ok: false, error: 'Missing q' });
try {
const data  = await unifiedSearch(q.trim(), null, null);
const langs = [...new Set(data.results.map(r => r.lang))].sort();
return res.json({ ok: true, query: q, total: langs.length, languages: langs });
} catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/stats', (req, res) => {
const mem = process.memoryUsage();
const up  = process.uptime();
const fmt = n => String(Math.floor(n)).padStart(2, '0');
return res.json({
ok              : true,
version         : 'FINAL BOSS',
platform        : PLATFORM,
uptime          : up,
uptimeFormatted : fmt(up / 3600) + ':' + fmt((up % 3600) / 60) + ':' + fmt(up % 60),
sessionReady,
cookieCount     : cookieJar.size,
sources         : {
s0 : 'official api.opensubtitles.com (quota: ' + osQuotaUsed + '/' + osQuotaMax + ')',
s1 : 'opensubtitles simpleXML (main scraper)',
s2 : 'rest.opensubtitles.org (old REST)',
s3 : CFG.WYZIE_KEY ? 'wyzie subs (ready)' : 'wyzie subs (add WYZIE_KEY)',
},
proxies         : { env: PROXY_POOL.length, freeTotal: freeProxies.length, freeWorking: workingFreeProxies.length },
memory          : { rss: (mem.rss / 1024 / 1024).toFixed(2) + ' MB', heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(2) + ' MB' },
cache           : {
search   : { keys: searchCache.getStats().keys, hits: searchCache.getStats().hits },
download : { keys: dlCache.getStats().keys },
meta     : { keys: metaCache.getStats().keys },
},
});
});

app.get('/health', async (req, res) => {
let osReachable = false;
try { await axios.head('https://www.opensubtitles.org', { timeout: 5000 }); osReachable = true; } catch {}
const ok = !!osToken || osReachable || !!CFG.WYZIE_KEY;
return res.status(ok ? 200 : 503).json({
ok        : ok,
status    : ok ? 'healthy' : 'degraded',
session   : sessionReady,
reachable : osReachable,
sources   : { official: !!osToken, wyzie: !!CFG.WYZIE_KEY, proxies: PROXY_POOL.length },
timestamp : new Date().toISOString(),
});
});

app.get('/ping',  (req, res) => res.send('pong'));

app.get('/debug', (req, res) => res.json({
platform: PLATFORM, baseUrl: BASE_URL,
proxyCount: PROXY_POOL.length, freeProxies: freeProxies.length,
sessionReady, officialApi: !!osToken,
osQuota: osQuotaUsed + '/' + osQuotaMax,
wyzie: !!CFG.WYZIE_KEY,
uptime: process.uptime(),
}));

app.get('/subtitle', (req, res) => {
const { action, id, title } = req.query;
if (action === 'search') { const rest = Object.assign({}, req.query); delete rest.action; return res.redirect(302, '/search?' + new URLSearchParams(rest).toString()); }
if (action === 'download') return res.redirect(302, '/download?id=' + id + (title ? '&title=' + encodeURIComponent(title) : ''));
return res.status(400).json({ ok: false, error: 'Invalid action' });
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VOID CINEMA — ULTRA PEAK PRO MAX</title>
    <!-- Premium Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,300;0,6..96,400;1,6..96,300;1,6..96,400&family=Fragment+Mono:ital@0;1&display=swap" rel="stylesheet">
    <style>
        /* ----- RESET ----- */
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        /* ----- THEME VARIABLES (DARK DEFAULT) ----- */
        [data-theme="dark"] {
            --bg: #0a0c10;
            --s0: #0f1218;
            --s1: #151a22;
            --line: #1f2830;
            --dim: #2a3440;
            --muted: #4a5560;
            --body: #e0e0e0;        /* brighter for readability */
            --text: #f0f0f0;
            --white: #ffffff;
            --gold: #b8965a;
            --gold2: #d4aa72;
            --teal: #00e5ff;
            --nav-bg: rgba(10,12,16,0.95);
            --out-bg: #0b0e12;
            --card-bg: #11161c;
            --glow: rgba(184,150,90,0.3);
        }
        [data-theme="light"] {
            --bg: #f5f2ed;
            --s0: #efebe4;
            --s1: #e8e3db;
            --line: #d8d2c8;
            --dim: #bfb8ac;
            --muted: #9a9288;
            --body: #2e2a26;        /* darker for contrast */
            --text: #1a1612;
            --white: #1a1612;
            --gold: #8a6a2e;
            --gold2: #b08840;
            --teal: #00778a;
            --nav-bg: rgba(245,242,237,0.95);
            --out-bg: #e8e3db;
            --card-bg: #efebe4;
            --glow: rgba(138,106,46,0.2);
        }

        html { scroll-behavior: smooth; }

        body {
            font-family: 'Bodoni Moda', Georgia, serif;
            background: var(--bg);
            color: var(--body);
            overflow-x: hidden;
            -webkit-font-smoothing: antialiased;
            cursor: none; /* custom cursor */
            transition: background 0.7s ease, color 0.7s ease;
        }

        /* ----- GRAIN OVERLAY ----- */
        body::before {
            content: '';
            position: fixed;
            inset: 0;
            pointer-events: none;
            z-index: 300;
            background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E");
            background-size: 200px;
            opacity: 0.04;
            mix-blend-mode: overlay;
        }

        /* ----- CUSTOM CURSOR ----- */
        #cd {
            position: fixed;
            width: 6px; height: 6px;
            background: var(--gold);
            border-radius: 50%;
            pointer-events: none;
            z-index: 9999;
            transform: translate(-50%, -50%);
            transition: background 0.3s;
        }
        #cr {
            position: fixed;
            width: 32px; height: 32px;
            border: 1px solid rgba(184,150,90,0.3);
            border-radius: 50%;
            pointer-events: none;
            z-index: 9998;
            transform: translate(-50%, -50%);
            transition: left 0.18s cubic-bezier(0.25,0.46,0.45,0.94),
                        top 0.18s cubic-bezier(0.25,0.46,0.45,0.94),
                        width 0.4s, height 0.4s, border-color 0.4s;
        }
        #cr.h {
            width: 52px; height: 52px;
            border-color: rgba(184,150,90,0.55);
        }

        /* ----- NAVIGATION ----- */
        nav {
            position: fixed;
            top: 0; left: 0; right: 0;
            z-index: 100;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 4rem;
            height: 68px;
            border-bottom: 1px solid var(--line);
            background: var(--nav-bg);
            backdrop-filter: blur(20px);
            transition: background 0.7s, border-color 0.7s;
        }
        .nl {
            font-family: 'Bodoni Moda', Georgia, serif;
            font-style: italic;
            font-weight: 300;
            font-size: 1.1rem;
            letter-spacing: 0.2em;
            color: var(--white);
            text-transform: uppercase;
        }
        .nl b {
            font-style: normal;
            font-weight: 300;
            color: var(--gold);
        }
        .nlinks {
            display: flex;
            gap: 3rem;
            list-style: none;
        }
        .nlinks a {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.56rem;
            letter-spacing: 0.25em;
            text-transform: uppercase;
            color: var(--muted);
            text-decoration: none;
            transition: color 0.4s;
        }
        .nlinks a:hover { color: var(--white); }

        .nav-right {
            display: flex;
            align-items: center;
            gap: 1.5rem;
        }

        /* status line */
        .nstat {
            display: flex;
            align-items: center;
            gap: 0.7rem;
            font-family: 'Fragment Mono', monospace;
            font-size: 0.54rem;
            letter-spacing: 0.2em;
            text-transform: uppercase;
        }
        .nline {
            width: 16px;
            height: 1px;
            background: var(--muted);
            transition: background 0.8s;
        }
        .nline.on { background: var(--gold); }
        .ntxt { color: var(--muted); transition: color 0.8s; }
        .ntxt.on { color: var(--gold); }

        /* theme toggle */
        .toggle-wrap {
            display: flex;
            align-items: center;
            gap: 0.8rem;
            cursor: none;
        }
        .toggle-lbl {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.5rem;
            letter-spacing: 0.2em;
            text-transform: uppercase;
            color: var(--muted);
            user-select: none;
        }
        .toggle {
            position: relative;
            width: 40px;
            height: 22px;
            cursor: none;
        }
        .toggle input { opacity: 0; width: 0; height: 0; }
        .toggle-track {
            position: absolute;
            inset: 0;
            background: var(--dim);
            border: 1px solid var(--muted);
            border-radius: 11px;
            transition: background 0.5s, border-color 0.5s;
        }
        [data-theme="light"] .toggle-track {
            background: var(--gold);
            border-color: var(--gold);
        }
        .toggle-thumb {
            position: absolute;
            top: 3px;
            left: 3px;
            width: 14px;
            height: 14px;
            background: var(--gold2);
            border-radius: 50%;
            transition: transform 0.45s, background 0.5s;
        }
        [data-theme="light"] .toggle-thumb {
            transform: translateX(18px);
            background: #fff;
        }
        .toggle-icon {
            position: absolute;
            font-size: 8px;
            top: 50%;
            transform: translateY(-50%);
            pointer-events: none;
            user-select: none;
            transition: opacity 0.4s;
        }
        .icon-moon { right: 6px; opacity: 1; }
        .icon-sun  { left: 6px; opacity: 0; }
        [data-theme="light"] .icon-moon { opacity: 0; }
        [data-theme="light"] .icon-sun  { opacity: 1; }

        /* ----- MAIN CONTAINER ----- */
        .page {
            max-width: 1380px;
            margin: 0 auto;
            padding: 0 4rem;
            position: relative;
            z-index: 1;
        }

        /* reveal animation */
        .r {
            opacity: 0;
            transform: translateY(22px);
            transition: opacity 0.9s cubic-bezier(0.25,0.46,0.45,0.94),
                        transform 0.9s cubic-bezier(0.25,0.46,0.45,0.94);
        }
        .r.v { opacity: 1; transform: none; }

        /* ----- HERO ----- */
        .hero {
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            justify-content: flex-end;
            padding: 68px 0 5.5rem;
            border-bottom: 1px solid var(--line);
        }
        .h-eye {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.54rem;
            letter-spacing: 0.4em;
            text-transform: uppercase;
            color: var(--muted);
            display: flex;
            align-items: center;
            gap: 1.2rem;
            margin-bottom: 2.5rem;
        }
        .h-eye::before {
            content: '';
            width: 22px;
            height: 1px;
            background: var(--gold);
        }
        .h-title {
            font-family: 'Bodoni Moda', Georgia, serif;
            font-weight: 300;
            font-style: italic;
            font-size: clamp(6rem, 14vw, 13rem);
            line-height: 0.84;
            letter-spacing: -0.01em;
            color: var(--white);
            margin-bottom: 4.5rem;
        }
        .h-title .sup {
            display: block;
            font-size: 0.32em;
            font-style: normal;
            letter-spacing: 0.38em;
            text-transform: uppercase;
            color: var(--muted);
            margin-bottom: 0.5em;
        }
        .h-title .g { color: var(--gold2); }

        .h-bottom {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 1px;
            background: var(--line);
            border: 1px solid var(--line);
        }
        .hm {
            background: var(--bg);
            padding: 2rem 1.8rem;
        }
        .hm-val {
            font-family: 'Bodoni Moda', Georgia, serif;
            font-style: italic;
            font-weight: 300;
            font-size: 3.2rem;
            line-height: 1;
            color: var(--white);
            display: block;
            margin-bottom: 0.5rem;
        }
        .hm-lbl {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.5rem;
            letter-spacing: 0.28em;
            text-transform: uppercase;
            color: var(--muted);
        }

        /* ----- DIVIDER ----- */
        .sdiv {
            display: flex;
            align-items: center;
            gap: 1.5rem;
            padding: 5rem 0 3.5rem;
        }
        .sdiv-lbl {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.52rem;
            letter-spacing: 0.4em;
            text-transform: uppercase;
            color: var(--muted);
            white-space: nowrap;
            flex-shrink: 0;
        }
        .sdiv-line {
            flex: 1;
            height: 1px;
            background: var(--line);
        }
        .sdiv-num {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.5rem;
            color: var(--dim);
            flex-shrink: 0;
        }

        /* ----- MONITOR GRID (BENTO) ----- */
        .mon-grid {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 1px;
            background: var(--line);
            border: 1px solid var(--line);
            margin-bottom: 1px;
        }
        .mc {
            background: var(--card-bg);
            padding: 2.5rem 1.8rem;
            position: relative;
            overflow: hidden;
            transition: background 0.5s;
        }
        .mc:hover { background: var(--s0); }
        .mc::after {
            content: '';
            position: absolute;
            bottom: 0; left: 0; right: 0;
            height: 1px;
            background: var(--gold);
            opacity: 0;
            transition: opacity 0.5s;
        }
        .mc:hover::after { opacity: 1; }
        .mc-val {
            font-family: 'Bodoni Moda', Georgia, serif;
            font-style: italic;
            font-weight: 300;
            font-size: 4rem;
            line-height: 1;
            color: var(--white);
            display: block;
            margin-bottom: 0.6rem;
            transition: color 0.5s;
            text-shadow: 0 0 8px var(--glow);
        }
        .mc:hover .mc-val { color: var(--gold2); }
        .mc-lbl {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.5rem;
            letter-spacing: 0.28em;
            text-transform: uppercase;
            color: var(--muted);
        }

        /* quota bar */
        .mon-quota {
            background: var(--bg);
            border: 1px solid var(--line);
            border-top: none;
            padding: 1.8rem 2.2rem;
            margin-bottom: 1px;
        }
        .quota-head {
            display: flex;
            justify-content: space-between;
            margin-bottom: 1rem;
        }
        .quota-lbl {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.5rem;
            letter-spacing: 0.3em;
            text-transform: uppercase;
            color: var(--muted);
        }
        .quota-val {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.54rem;
            color: var(--body);
        }
        .qtrack {
            width: 100%;
            height: 1px;
            background: var(--dim);
        }
        .qfill {
            height: 100%;
            background: var(--gold);
            box-shadow: 0 0 8px var(--glow);
            transition: width 2s;
        }

        /* session status */
        .mon-sess {
            background: var(--bg);
            border: 1px solid var(--line);
            border-top: none;
            padding: 1.4rem 2.2rem;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .sb {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.54rem;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            padding: 0.35rem 1rem;
            border: 1px solid var(--muted);
            color: var(--muted);
            transition: all 0.6s;
        }
        .sb.ok  { border-color: var(--gold); color: var(--gold); }
        .sb.bad { border-color: #c06060; color: #c06060; }
        .sp {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.52rem;
            color: var(--body);
        }

        /* API description */
        .api-desc {
            background: var(--s0);
            border: 1px solid var(--line);
            padding: 2rem 2.5rem;
            margin-bottom: 1px;
        }
        .api-desc-title {
            font-family: 'Bodoni Moda', Georgia, serif;
            font-style: italic;
            font-weight: 300;
            font-size: 1.4rem;
            color: var(--white);
            margin-bottom: 0.8rem;
        }
        .api-desc-body {
            font-family: 'Bodoni Moda', Georgia, serif;
            font-weight: 300;
            font-size: 0.9rem;
            line-height: 1.8;
            color: var(--body);
            margin-bottom: 1.2rem;
        }
        .api-examples {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1px;
            background: var(--line);
            border: 1px solid var(--line);
            margin-bottom: 1rem;
        }
        .api-ex {
            background: var(--bg);
            padding: 1rem 1.4rem;
        }
        .api-ex-lbl {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.48rem;
            letter-spacing: 0.3em;
            text-transform: uppercase;
            color: var(--muted);
            margin-bottom: 0.5rem;
        }
        .api-ex-val {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.65rem;
            color: var(--text);
        }
        .api-note {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.54rem;
            color: var(--body);
            line-height: 1.8;
        }
        .api-note span { color: var(--gold); }

        /* workspace (endpoint list + console) */
        .work {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1px;
            background: var(--line);
            border: 1px solid var(--line);
        }
        .ep-panel, .con-panel {
            background: var(--bg);
            padding: 2.5rem;
        }

        .ep-hdr {
            display: grid;
            grid-template-columns: 70px 1fr 100px;
            padding: 0.8rem 0 0.8rem 0.5rem;
            border-bottom: 1px solid var(--line);
            margin-bottom: 0.5rem;
        }
        .ep-hdr span {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.48rem;
            letter-spacing: 0.35em;
            text-transform: uppercase;
            color: var(--dim);
        }
        .ep-hdr span:last-child { text-align: right; }

        .epr {
            display: grid;
            grid-template-columns: 70px 1fr 100px;
            align-items: center;
            padding: 1.25rem 0.5rem;
            border-bottom: 1px solid var(--line);
            cursor: none;
            position: relative;
            overflow: hidden;
            transition: background 0.4s;
        }
        .epr:last-child { border-bottom: none; }
        .epr:hover { background: var(--s0); }
        .epr::before {
            content: '';
            position: absolute;
            left: 0; top: 0; bottom: 0;
            width: 1px;
            background: var(--gold);
            opacity: 0;
            transition: opacity 0.4s;
        }
        .epr:hover::before { opacity: 1; }
        .em {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.5rem;
            letter-spacing: 0.1em;
            color: var(--gold);
            padding-left: 0.5rem;
        }
        .ep {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.68rem;
            color: var(--text);
        }
        .ep .p { color: var(--white); }
        .ep .q { color: var(--muted); }
        .ea {
            text-align: right;
            font-family: 'Fragment Mono', monospace;
            font-size: 0.48rem;
            letter-spacing: 0.28em;
            text-transform: uppercase;
            color: var(--dim);
            transition: color 0.4s;
        }
        .epr:hover .ea { color: var(--gold); }

        .con-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 1.8rem;
            padding-bottom: 1.4rem;
            border-bottom: 1px solid var(--line);
        }
        .con-lbl {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.52rem;
            letter-spacing: 0.3em;
            text-transform: uppercase;
            color: var(--muted);
        }
        .con-time {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.52rem;
            color: var(--dim);
        }
        .con-row {
            display: flex;
            gap: 1px;
            margin-bottom: 1.4rem;
        }
        .con-input {
            flex: 1;
            background: var(--s0);
            border: 1px solid var(--line);
            border-right: none;
            color: var(--white);
            font-family: 'Fragment Mono', monospace;
            font-size: 0.66rem;
            padding: 0.8rem 1.1rem;
            outline: none;
        }
        .con-input:focus { border-color: var(--gold); }
        .con-btn {
            background: var(--gold);
            color: var(--bg);
            border: none;
            font-family: 'Fragment Mono', monospace;
            font-size: 0.5rem;
            font-weight: 500;
            letter-spacing: 0.28em;
            text-transform: uppercase;
            padding: 0 1.5rem;
            cursor: none;
            transition: background 0.35s;
        }
        .con-btn:hover { background: var(--gold2); }
        .con-out {
            background: var(--out-bg);
            border: 1px solid var(--line);
            padding: 1.3rem;
            height: 360px;
            overflow-y: auto;
            position: relative;
        }
        .con-out::-webkit-scrollbar { width: 1px; }
        .con-out::-webkit-scrollbar-thumb { background: var(--dim); }
        .con-pre {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.62rem;
            line-height: 2;
            color: var(--body);
            white-space: pre-wrap;
            word-break: break-all;
        }
        .otag {
            position: absolute;
            top: 0.8rem;
            right: 0.8rem;
            font-family: 'Fragment Mono', monospace;
            font-size: 0.48rem;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: var(--dim);
        }
        .otag.ok { color: var(--gold); }
        .otag.er { color: #c06060; }

        /* contact grid */
        .ct-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1px;
            background: var(--line);
            border: 1px solid var(--line);
        }
        .ct-l, .ct-r {
            background: var(--bg);
            padding: 4rem;
        }
        .ct-over {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.52rem;
            letter-spacing: 0.4em;
            text-transform: uppercase;
            color: var(--gold);
            display: flex;
            align-items: center;
            gap: 1rem;
            margin-bottom: 2rem;
        }
        .ct-over::before {
            content: '';
            width: 18px;
            height: 1px;
            background: var(--gold);
        }
        .ct-title {
            font-family: 'Bodoni Moda', Georgia, serif;
            font-weight: 300;
            font-style: italic;
            font-size: clamp(3.5rem, 7vw, 6rem);
            line-height: 0.86;
            letter-spacing: -0.01em;
            color: var(--white);
            margin-bottom: 2rem;
        }
        .ct-title .a { color: var(--gold2); }
        .ct-body {
            font-family: 'Bodoni Moda', Georgia, serif;
            font-weight: 300;
            font-size: 1.05rem;
            line-height: 1.85;
            color: var(--body);
            max-width: 360px;
            margin-bottom: 2.5rem;
        }
        .ig {
            display: flex;
            align-items: center;
            gap: 1.5rem;
            padding: 1.4rem 1.8rem;
            border: 1px solid var(--line);
            text-decoration: none;
            background: var(--s0);
            transition: border-color 0.5s, padding-left 0.4s, background 0.7s;
        }
        .ig:hover {
            border-color: var(--gold);
            padding-left: 2.2rem;
            background: var(--bg);
        }
        .ig-ic {
            width: 38px;
            height: 38px;
            border: 1px solid var(--muted);
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--muted);
            flex-shrink: 0;
            transition: border-color 0.5s, color 0.5s;
        }
        .ig:hover .ig-ic {
            border-color: var(--gold);
            color: var(--gold);
        }
        .ig-handle {
            font-family: 'Bodoni Moda', Georgia, serif;
            font-style: italic;
            font-weight: 300;
            font-size: 1.35rem;
            color: var(--white);
        }
        .ig-sub {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.48rem;
            letter-spacing: 0.22em;
            text-transform: uppercase;
            color: var(--muted);
            margin-top: 0.2rem;
        }
        .ig-ar {
            margin-left: auto;
            color: var(--dim);
            transition: color 0.4s, transform 0.4s;
        }
        .ig:hover .ig-ar {
            color: var(--gold);
            transform: translateX(5px);
        }

        .spec-row {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            padding: 1rem 0;
            border-bottom: 1px solid var(--line);
        }
        .spec-row:first-child { border-top: 1px solid var(--line); }
        .sk {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.52rem;
            letter-spacing: 0.22em;
            text-transform: uppercase;
            color: var(--muted);
        }
        .sv {
            font-family: 'Bodoni Moda', Georgia, serif;
            font-size: 1rem;
            font-style: italic;
            font-weight: 300;
            color: var(--text);
        }
        .sv.go { color: var(--gold2); }

        .vstamp {
            display: inline-flex;
            align-items: center;
            gap: 1rem;
            font-family: 'Fragment Mono', monospace;
            font-size: 0.52rem;
            letter-spacing: 0.25em;
            text-transform: uppercase;
            color: var(--muted);
            padding: 0.9rem 1.4rem;
            border: 1px solid var(--line);
            margin-top: 1.8rem;
        }
        .vstamp span { color: var(--gold); }

        footer {
            padding: 2.5rem 0;
            margin-top: 1px;
            border-top: 1px solid var(--line);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .fsig {
            font-family: 'Bodoni Moda', Georgia, serif;
            font-style: italic;
            font-weight: 300;
            font-size: 1.5rem;
            letter-spacing: 0.08em;
            color: var(--dim);
        }
        .fcopy {
            font-family: 'Fragment Mono', monospace;
            font-size: 0.48rem;
            letter-spacing: 0.28em;
            text-transform: uppercase;
            color: var(--dim);
        }

        /* responsive */
        @media (max-width: 900px) {
            .page { padding: 0 1.4rem; }
            nav { padding: 0 1.4rem; }
            .nlinks { display: none; }
            .h-title { font-size: 5.5rem; }
            .h-bottom { grid-template-columns: 1fr 1fr; }
            .mon-grid { grid-template-columns: repeat(3, 1fr); }
            .work { grid-template-columns: 1fr; }
            .ct-grid { grid-template-columns: 1fr; }
            .epr { grid-template-columns: 60px 1fr; }
            .ea { display: none; }
            .ep-hdr { grid-template-columns: 60px 1fr; }
            .ep-hdr span:last-child { display: none; }
        }
    </style>
</head>
<body>
    <div id="cd"></div>
    <div id="cr"></div>

    <nav>
        <div class="nl">void<b>.</b>cinema</div>
        <ul class="nlinks">
            <li><a href="#monitor">Monitor</a></li>
            <li><a href="#api">Interface</a></li>
            <li><a href="#contact">Contact</a></li>
            <li><a href="https://github.com/munax07/Opensub-Api" target="_blank">Source</a></li>
        </ul>
        <div class="nav-right">
            <div class="nstat">
                <div class="nline" id="nl2"></div>
                <span class="ntxt" id="nt">Connecting</span>
            </div>
            <label class="toggle-wrap" title="Toggle theme">
                <span class="toggle-lbl" id="theme-lbl">Dark</span>
                <div class="toggle" onclick="toggleTheme()">
                    <div class="toggle-track">
                        <span class="toggle-icon icon-moon">☽</span>
                        <span class="toggle-icon icon-sun">☀</span>
                        <div class="toggle-thumb"></div>
                    </div>
                </div>
            </label>
        </div>
    </nav>

    <div class="page">
        <!-- HERO -->
        <section class="hero">
            <div class="h-eye r">OpenSubtitles Proxy Infrastructure &mdash; FINAL</div>
            <h1 class="h-title r" style="transition-delay:0.1s">
                <span class="sup">Void</span> Cin<span class="g">e</span>ma
            </h1>
            <div class="h-bottom r" style="transition-delay:0.22s">
                <div class="hm"><span class="hm-val" id="hm1">--</span><span class="hm-lbl">Hours Live</span></div>
                <div class="hm" style="border-left:1px solid var(--line)"><span class="hm-val" id="hm2">--</span><span class="hm-lbl">Cached</span></div>
                <div class="hm" style="border-left:1px solid var(--line)"><span class="hm-val" id="hm3">--</span><span class="hm-lbl">Heap MB</span></div>
                <div class="hm" style="border-left:1px solid var(--line)"><span class="hm-val" id="hm4">--</span><span class="hm-lbl">Proxies</span></div>
            </div>
        </section>

        <!-- MONITOR -->
        <section id="monitor">
            <div class="sdiv r"><div class="sdiv-lbl">System Monitor</div><div class="sdiv-line"></div><div class="sdiv-num">01</div></div>
            <div class="mon-grid r" style="transition-delay:0.08s">
                <div class="mc"><span class="mc-val" id="m1">--</span><span class="mc-lbl">Uptime hrs</span></div>
                <div class="mc"><span class="mc-val" id="m2">--</span><span class="mc-lbl">Search Cache</span></div>
                <div class="mc"><span class="mc-val" id="m3">--</span><span class="mc-lbl">Meta Cache</span></div>
                <div class="mc"><span class="mc-val" id="m4">--</span><span class="mc-lbl">DL Buffer</span></div>
                <div class="mc"><span class="mc-val" id="m5" style="font-size:2.4rem">--</span><span class="mc-lbl">Heap Used</span></div>
            </div>
            <div class="mon-quota r" style="transition-delay:0.14s">
                <div class="quota-head">
                    <span class="quota-lbl">Official API Quota</span>
                    <span class="quota-val" id="mq">No credentials</span>
                </div>
                <div class="qtrack"><div class="qfill" id="mqb" style="width:0%"></div></div>
            </div>
            <div class="mon-sess r" style="transition-delay:0.2s">
                <span class="sb" id="ms">Checking session...</span>
                <span class="sp" id="mp">proxy: --</span>
            </div>
        </section>

        <!-- API INTERFACE -->
        <section id="api">
            <div class="sdiv r"><div class="sdiv-lbl">API Interface</div><div class="sdiv-line"></div><div class="sdiv-num">02</div></div>
            <div class="api-desc r" style="transition-delay:0.04s">
                <div class="api-desc-title">What is this?</div>
                <div class="api-desc-body">
                    VOID CINEMA is a free OpenSubtitles proxy API. Search any movie or series by title and download the subtitle file directly. Malayalam is always sorted first. Supports English, Tamil, Hindi and all major languages.
                </div>
                <div class="api-examples">
                    <div class="api-ex"><div class="api-ex-lbl">Search a movie</div><div class="api-ex-val">/search?q=Inception</div></div>
                    <div class="api-ex"><div class="api-ex-lbl">Malayalam subtitles</div><div class="api-ex-val">/search?q=Vikram&lang=ml</div></div>
                    <div class="api-ex"><div class="api-ex-lbl">Download subtitle</div><div class="api-ex-val">/download?id={id}</div></div>
                    <div class="api-ex"><div class="api-ex-lbl">Filter by type</div><div class="api-ex-val">/search?q=Breaking+Bad&type=series</div></div>
                </div>
                <div class="api-note">
                    Response includes a <span>download</span> field on each result. File always named correctly: <span>Fight.Club.1999.BluRay.srt</span>
                </div>
            </div>

            <div class="work r" style="transition-delay:0.1s">
                <div class="ep-panel">
                    <div class="ep-hdr"><span>Method</span><span>Endpoint</span><span>Action</span></div>
                    <div class="epr" onclick="sp('/search?q=Inception')"><span class="em">GET</span><span class="ep">/<span class="p">search</span><span class="q">?q=Inception</span></span><span class="ea">Test →</span></div>
                    <div class="epr" onclick="sp('/search?q=Vikram&lang=ml&type=movie')"><span class="em">GET</span><span class="ep">/<span class="p">search</span><span class="q">?q=Vikram&lang=ml</span></span><span class="ea">Test →</span></div>
                    <div class="epr" onclick="sp('/search?q=fight+club&lang=en')"><span class="em">GET</span><span class="ep">/<span class="p">search</span><span class="q">?q=fight+club&lang=en</span></span><span class="ea">Test →</span></div>
                    <div class="epr" onclick="sp('/languages?q=Inception')"><span class="em">GET</span><span class="ep">/<span class="p">languages</span><span class="q">?q=Inception</span></span><span class="ea">Test →</span></div>
                    <div class="epr" onclick="sp('/download?id=3962439')"><span class="em">GET</span><span class="ep">/<span class="p">download</span><span class="q">?id=3962439</span></span><span class="ea">Test →</span></div>
                    <div class="epr" onclick="sp('/stats')"><span class="em">GET</span><span class="ep">/<span class="p">stats</span></span><span class="ea">Test →</span></div>
                    <div class="epr" onclick="sp('/health')"><span class="em">GET</span><span class="ep">/<span class="p">health</span></span><span class="ea">Test →</span></div>
                </div>
                <div class="con-panel">
                    <div class="con-head">
                        <span class="con-lbl">Execution Console</span>
                        <span class="con-time" id="ct">--:--:--</span>
                    </div>
                    <div class="con-row">
                        <input class="con-input" id="ci" value="/search?q=Inception" spellcheck="false" autocomplete="off">
                        <button class="con-btn" id="cb" onclick="run()">Execute</button>
                    </div>
                    <div class="con-out">
                        <span class="otag" id="cs">standby</span>
                        <pre class="con-pre" id="co">// Select an endpoint or type a path.
// Hit Execute to call your API.</pre>
                    </div>
                </div>
            </div>
        </section>

        <!-- CONTACT -->
        <section id="contact">
            <div class="sdiv r"><div class="sdiv-lbl">Contact</div><div class="sdiv-line"></div><div class="sdiv-num">03</div></div>
            <div class="ct-grid r" style="transition-delay:0.08s">
                <div class="ct-l">
                    <div class="ct-over">Access & Inquiry</div>
                    <h2 class="ct-title">Stay<br>in<br><span class="a">touch.</span></h2>
                    <p class="ct-body">Open for collaboration, integration support, and custom developer inquiries. Guaranteed response via Instagram.</p>
                    <a href="https://instagram.com/munavi.r_" target="_blank" class="ig">
                        <div class="ig-ic">
                            <svg width="17" height="17" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
                        </div>
                        <div><div class="ig-handle">munavi.r_</div><div class="ig-sub">Instagram</div></div>
                        <div class="ig-ar">→</div>
                    </a>
                </div>
                <div class="ct-r">
                    <div class="spec-row"><span class="sk">Architecture</span><span class="sv go">munax</span></div>
                    <div class="spec-row"><span class="sk">Build</span><span class="sv">Ultra Peak FINAL</span></div>
                    <div class="spec-row"><span class="sk">Search</span><span class="sv">4-Source Fallback Chain</span></div>
                    <div class="spec-row"><span class="sk">Download</span><span class="sv">Official API + 3 Backups</span></div>
                    <div class="spec-row"><span class="sk">Language Priority</span><span class="sv go">Malayalam first</span></div>
                    <div class="spec-row"><span class="sk">Auto-title</span><span class="sv">Release metadata cache</span></div>
                    <div class="spec-row"><span class="sk">Proxy Pool</span><span class="sv">Rotation — up to 20</span></div>
                    <div class="spec-row"><span class="sk">Platform</span><span class="sv">Koyeb — auto-ping</span></div>
                    <div class="vstamp">Stable Release <span>FINAL</span></div>
                </div>
            </div>
        </section>

        <footer class="r">
            <div class="fsig">munax</div>
            <div style="text-align:right">
                <div class="fcopy">Void Cinema — 2026</div>
                <div class="fcopy" style="margin-top:.4rem;color:var(--gold);">architecture by munax</div>
            </div>
        </footer>
    </div>

    <script>
        // --- BASE URL (auto-detect)
        const BASE = window.location.origin;

        // --- Theme toggle
        function toggleTheme() {
            const html = document.documentElement;
            const isDark = html.getAttribute('data-theme') === 'dark';
            html.setAttribute('data-theme', isDark ? 'light' : 'dark');
            document.getElementById('theme-lbl').textContent = isDark ? 'Light' : 'Dark';
            localStorage.setItem('void-theme', isDark ? 'light' : 'dark');
        }
        // restore saved theme
        const saved = localStorage.getItem('void-theme');
        if (saved) {
            document.documentElement.setAttribute('data-theme', saved);
            document.getElementById('theme-lbl').textContent = saved === 'light' ? 'Light' : 'Dark';
        }

        // --- Custom cursor
        const cd = document.getElementById('cd');
        const cr = document.getElementById('cr');
        document.addEventListener('mousemove', e => {
            cd.style.left = e.clientX + 'px';
            cd.style.top = e.clientY + 'px';
            cr.style.left = e.clientX + 'px';
            cr.style.top = e.clientY + 'px';
        });
        document.querySelectorAll('a, button, .epr, input, .toggle-wrap').forEach(el => {
            el.addEventListener('mouseenter', () => cr.classList.add('h'));
            el.addEventListener('mouseleave', () => cr.classList.remove('h'));
        });

        // --- Reveal animation
        const observer = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (entry.isIntersecting) entry.target.classList.add('v');
            });
        }, { threshold: 0.1, rootMargin: '0px 0px -20px 0px' });
        document.querySelectorAll('.r').forEach(el => observer.observe(el));
        // fallback: reveal all after timeout
        setTimeout(() => {
            document.querySelectorAll('.r:not(.v)').forEach(el => el.classList.add('v'));
        }, 800);

        // --- Live clock
        setInterval(() => {
            const now = new Date();
            document.getElementById('ct').innerText = now.toTimeString().slice(0, 8);
        }, 1000);

        // --- Smooth number animation
        function animateValue(el, target, duration = 1200) {
            if (!el) return;
            const start = performance.now();
            const from = parseInt(el.textContent) || 0;
            function step(now) {
                const progress = Math.min((now - start) / duration, 1);
                const eased = 1 - Math.pow(1 - progress, 3);
                const value = Math.round(from + (target - from) * eased);
                el.textContent = value;
                if (progress < 1) requestAnimationFrame(step);
            }
            requestAnimationFrame(step);
        }

        // --- Fetch stats and update UI
        async function refreshStats() {
            try {
                const res = await fetch(BASE + '/stats');
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const d = await res.json();
                if (!d.ok) throw new Error('API error');

                const hrs = Math.floor((d.uptime || 0) / 3600);
                const heap = parseFloat((d.memory?.heapUsed || '0').replace(/[^0-9.]/g, ''));
                const sc = d.cache?.search?.keys || 0;
                const mc = d.cache?.meta?.keys || 0;
                const dl = d.cache?.download?.keys || 0;
                const pc = d.proxies ? (d.proxies.env + '+' + d.proxies.free.working) : '--';

                animateValue(document.getElementById('hm1'), hrs);
                animateValue(document.getElementById('hm2'), sc + mc);
                animateValue(document.getElementById('hm3'), Math.round(heap));
                document.getElementById('hm4').textContent = pc;

                animateValue(document.getElementById('m1'), hrs);
                animateValue(document.getElementById('m2'), sc);
                animateValue(document.getElementById('m3'), mc);
                animateValue(document.getElementById('m4'), dl);
                document.getElementById('m5').textContent = d.memory?.heapUsed || '--';

                const quota = d.officialApi?.quota;
                document.getElementById('mq').textContent = (quota && quota !== 'N/A') ? quota : 'No credentials';
                if (quota && quota !== 'N/A') {
                    const [used, max] = quota.split('/').map(Number);
                    if (max) document.getElementById('mqb').style.width = Math.round((used / max) * 100) + '%';
                }

                const ready = d.sessionReady;
                const sb = document.getElementById('ms');
                sb.textContent = ready ? 'Session Ready' : 'Warming Up';
                sb.className = 'sb ' + (ready ? 'ok' : 'bad');

                const pi = d.proxies ? (d.proxies.env + ' env + ' + d.proxies.free.working + ' free') : 'direct';
                document.getElementById('mp').textContent = 'proxy: ' + pi;

                document.getElementById('nl2').classList.toggle('on', ready);
                document.getElementById('nt').textContent = ready ? 'System Ready' : 'Warming';
                document.getElementById('nt').classList.toggle('on', ready);
            } catch (e) {
                if (window.location.hostname === 'localhost') console.error(e);
                // silent fail – keep old values
            }
        }
        refreshStats();
        setInterval(refreshStats, 10000);

        // --- Console helpers
        function sp(path) {
            const input = document.getElementById('ci');
            input.value = path;
            input.focus();
            input.style.borderColor = 'var(--gold)';
            setTimeout(() => input.style.borderColor = '', 700);
            input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        async function run() {
            const btn = document.getElementById('cb');
            const out = document.getElementById('co');
            const statusTag = document.getElementById('cs');
            const path = document.getElementById('ci').value.trim();
            if (!path) return;

            btn.textContent = '...';
            out.style.color = 'var(--body)';
            out.textContent = '// Connecting...\n// ' + BASE + path;
            statusTag.textContent = 'running';
            statusTag.className = 'otag';

            try {
                const start = performance.now();
                const res = await fetch(BASE + (path.startsWith('/') ? '' : '/') + path);
                const ms = Math.round(performance.now() - start);

                if (path.includes('/download')) {
                    out.style.color = 'var(--text)';
                    out.textContent = '// Stream initiated.\n// Opening file in new tab.';
                    statusTag.textContent = '200 - ' + ms + 'ms';
                    statusTag.className = 'otag ok';
                    window.open(BASE + path, '_blank');
                    return;
                }

                const data = await res.json();
                out.style.color = 'var(--text)';
                out.textContent = JSON.stringify(data, null, 2);
                statusTag.textContent = res.status + ' - ' + ms + 'ms';
                statusTag.className = 'otag ' + (res.ok ? 'ok' : 'er');
            } catch (e) {
                out.style.color = '#c06060';
                out.textContent = '// Error: ' + e.message;
                statusTag.textContent = 'error';
                statusTag.className = 'otag er';
            } finally {
                btn.textContent = 'Execute';
            }
        }

        // Enter key in input
        document.getElementById('ci').addEventListener('keydown', e => {
            if (e.key === 'Enter') run();
        });

        // Expose functions globally (for onclick attributes)
        window.sp = sp;
        window.run = run;
        window.toggleTheme = toggleTheme;
    </script>
</body>
</html>
`;

app.get('/', (req, res) => {
res.setHeader('Content-Type', 'text/html; charset=utf-8');
res.send(DASHBOARD_HTML);
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found', path: req.path }));
app.use((err, req, res, next) => {
log.error('Express error', { error: err.message });
if (!res.headersSent) res.status(500).json({ ok: false, error: 'Internal server error' });
});

// =============================================================================
//  BACKGROUND JOBS
// =============================================================================
setInterval(() => {
const used = process.memoryUsage().heapUsed;
if (used > CFG.MEMORY_LIMIT * CFG.MEMORY_WARN) {
log.warn('Memory high, flushing caches', { mb: (used / 1024 / 1024).toFixed(1) });
searchCache.flushAll(); dlCache.flushAll();
if (global.gc) global.gc();
}
}, 60 * 1000);

setInterval(() => warmup(),               CFG.WARMUP_INTERVAL);
setInterval(() => fetchFreeProxies(true), 30 * 60 * 1000);
setInterval(() => { workingFreeProxies = []; }, 20 * 60 * 1000);
setInterval(async () => {
log.info('Refreshing OS API token…');
osToken = '';
await getOsToken();
}, 22 * 60 * 60 * 1000);

if (PLATFORM !== 'local' && !IS_SERVERLESS) {
setInterval(() => {
axios.get(BASE_URL + '/ping', { timeout: 8000 })
.then(() => log.debug('Self-ping OK'))
.catch(e => log.warn('Self-ping failed', { error: e.message }));
}, CFG.PING_INTERVAL);
}

// =============================================================================
//  GRACEFUL SHUTDOWN
// =============================================================================
let _server;
const shutdown = signal => {
log.info('Shutting down', { signal });
if (_server) _server.close(() => { log.info('Server closed'); process.exit(0); });
else process.exit(0);
setTimeout(() => process.exit(1), 10000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// =============================================================================
//  STARTUP
// =============================================================================
async function startup() {
log.info('VOID CINEMA FINAL BOSS — starting', { platform: PLATFORM });

PROXY_POOL = buildProxyPool();
if (PROXY_POOL.length) log.info('Proxy pool ready', { count: PROXY_POOL.length });
else log.warn('No env proxies — direct connections only, may be blocked');

if (!CFG.OS_API_KEY || !CFG.OS_USERNAME || !CFG.OS_PASSWORD)
log.warn('OS_API_KEY/OS_USERNAME/OS_PASSWORD not set — official API (S0) disabled. Set in Koyeb env vars.');
if (!CFG.WYZIE_KEY) log.warn('WYZIE_KEY not set — S3 disabled. Get free: sub.wyzie.io/redeem');
if (!CFG.OMDB_KEY)  log.warn('OMDB_API_KEY not set — IMDB lookup limited. Get free: omdbapi.com');

// Start all init tasks in parallel — faster cold start
await Promise.allSettled([
getOsToken(),
fetchFreeProxies(true),
warmup(),
]);

if (!CFG.WYZIE_KEY) log.warn('WYZIE_KEY not set — S3 disabled. Get free key: sub.wyzie.io/redeem');
if (!CFG.OMDB_KEY)  log.warn('OMDB_API_KEY not set — IMDB lookup limited. Get free: omdbapi.com');

_server = app.listen(PORT, () => {
log.info('Server ready', { url: BASE_URL });
log.info('Search:    ' + BASE_URL + '/search?q=Inception');
log.info('Dashboard: ' + BASE_URL + '/');
});
}

startup().catch(err => { log.error('Fatal startup error', { error: err.message }); process.exit(1); });
if (IS_SERVERLESS) module.exports = app;
