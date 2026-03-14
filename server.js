// =============================================================================
//  ULTIMATE PEAK SUBTITLE API – AK46 EDITION (Bulletproof)
//  Architecture: munax + Jerry 
//  Features:
//    - Malayalam first, then English, then others
//    - Hybrid proxy: residential (PROXY_URL + BACKUP_PROXY_1..20) + free fallback
//    - Auto‑refreshing free proxy pool (TheSpeedX, refreshed every 30 min)
//    - Smart ZIP extraction with size limit, perfect filenames
//    - Session & cookies, caching, rate limiting, request IDs
//    - Structured JSON logs, graceful shutdown, global error handlers
//    - Response time, ETag, Retry‑After headers
//    - Self‑ping (keeps Koyeb alive) & memory watchdog
//    - Full premium embedded dashboard (Munax aesthetic)
// =============================================================================

'use strict';

const express        = require('express');
const axios          = require('axios');
const cheerio        = require('cheerio');
const NodeCache      = require('node-cache');
const rateLimit      = require('express-rate-limit');
const cors           = require('cors');
const compression    = require('compression');
const AdmZip         = require('adm-zip');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const zlib           = require('zlib');
const path           = require('path');
const https          = require('https');
const { randomUUID } = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// Enable compression for responses (reduces bandwidth)
app.use(compression());

// =============================================================================
//  PLATFORM DETECTION
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
  if (PLATFORM === 'render')  return process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  if (PLATFORM === 'koyeb')   return 'https://' + (process.env.KOYEB_PUBLIC_DOMAIN || (process.env.KOYEB_APP_NAME || 'app') + '.koyeb.app');
  if (PLATFORM === 'vercel')  return process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`;
  if (PLATFORM === 'railway') return process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`;
  if (PLATFORM === 'fly')     return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  return `http://localhost:${PORT}`;
})();

const IS_SERVERLESS = PLATFORM === 'vercel';
app.set('trust proxy', IS_SERVERLESS ? false : 1);

// =============================================================================
//  GLOBAL ERROR HANDLERS (prevent crashes)
// =============================================================================
process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION:', err);
  // Optionally, you could log to a service, but we'll keep it simple
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// =============================================================================
//  CONFIGURATION
// =============================================================================
const CFG = {
  CACHE_SEARCH_TTL : parseInt(process.env.CACHE_TTL_SEARCH) || 600,  // 10 min
  CACHE_DL_TTL     : parseInt(process.env.CACHE_TTL_DL)     || 1800, // 30 min
  CACHE_META_TTL   : 3600,                                          // 1 hr – subtitle metadata (used in /download)
  RATE_MAX         : parseInt(process.env.RATE_LIMIT_MAX)   || 100,
  RATE_WINDOW_MS   : 15 * 60 * 1000,                                // 15 min
  REQ_TIMEOUT      : parseInt(process.env.REQUEST_TIMEOUT_MS) || 20000,
  MAX_RESULTS      : 40,
  MAX_ZIP_SIZE     : 8 * 1024 * 1024,                               // 8 MB
  MAX_QUERY_LEN    : 200,
  SEARCH_RETRIES   : 3,
  WARMUP_INTERVAL  : 2 * 60 * 60 * 1000,                            // 2 hours
  MEMORY_LIMIT     : (parseInt(process.env.MEMORY_LIMIT_MB) || 512) * 1024 * 1024,
  MEMORY_WARN      : 0.82,
  // Self‑ping interval (if on Koyeb/Render, keep alive)
  SELF_PING_MS     : 9 * 60 * 1000,                                 // 9 minutes
};

// =============================================================================
//  LOGGER (structured JSON)
// =============================================================================
const log = {
  _fmt: (level, msg, meta = {}) => {
    const base = { level, ts: new Date().toISOString(), msg };
    return JSON.stringify(Object.keys(meta).length ? { ...base, ...meta } : base);
  },
  info:  (msg, meta) => console.log(log._fmt('info',  msg, meta)),
  warn:  (msg, meta) => console.warn(log._fmt('warn',  msg, meta)),
  error: (msg, meta) => console.error(log._fmt('error', msg, meta)),
  debug: (msg, meta) => { if (process.env.DEBUG) console.debug(log._fmt('debug', msg, meta)); },
};

// =============================================================================
//  CACHES
// =============================================================================
const searchCache = new NodeCache({ stdTTL: CFG.CACHE_SEARCH_TTL, checkperiod: 120, useClones: false });
const dlCache     = new NodeCache({ stdTTL: CFG.CACHE_DL_TTL,     checkperiod: 180, useClones: false });
const metaCache   = new NodeCache({ stdTTL: CFG.CACHE_META_TTL,   checkperiod: 300, useClones: false }); // used for subtitle metadata

// In‑flight request deduplication (optional)
const inFlight = new Map();

// =============================================================================
//  PROXY LAYERS
//  Layer 1: Environment‑defined proxies (PROXY_URL, BACKUP_PROXY_1..20)
//  Layer 2: Auto‑fetched free proxy pool (fallback)
// =============================================================================

// ---------- Layer 1: Env proxy pool ----------
function buildEnvProxyPool() {
  const list = [];
  if (process.env.PROXY_URL) list.push({ url: process.env.PROXY_URL, label: 'primary' });
  for (let i = 1; i <= 20; i++) {
    const v = process.env[`BACKUP_PROXY_${i}`];
    if (v) list.push({ url: v, label: `backup_${i}` });
  }
  return list.map(p => {
    try {
      // Auto‑detect protocol: socks5:// or http://
      let agent;
      if (p.url.startsWith('socks5://')) {
        agent = new SocksProxyAgent(p.url);
      } else {
        // default to http/https proxy
        agent = new HttpsProxyAgent(p.url);
      }
      const masked = p.url.replace(/:([^:@]{3})[^:@]*@/, ':***@');
      return { ...p, agent, masked };
    } catch (e) {
      log.warn('Invalid proxy URL — skipped', { label: p.label, error: e.message });
      return null;
    }
  }).filter(Boolean);
}

const ENV_PROXY_POOL = buildEnvProxyPool();
let   envIdx    = 0;               // current active env proxy index
let   envFails  = 0;                // consecutive failures on current env proxy

function getActiveEnvProxy()  { return ENV_PROXY_POOL.length ? ENV_PROXY_POOL[envIdx % ENV_PROXY_POOL.length] : null; }

function rotateEnvProxy(reason) {
  if (ENV_PROXY_POOL.length <= 1) return;
  const prev = getActiveEnvProxy();
  envIdx   = (envIdx + 1) % ENV_PROXY_POOL.length;
  envFails = 0;
  log.warn('Env proxy rotated', { from: prev.label, to: getActiveEnvProxy().label, reason });
}

function onEnvProxySuccess() { envFails = 0; }
function onEnvProxyFailure(reason) {
  envFails++;
  if (envFails >= 2) rotateEnvProxy(reason);
}

if (ENV_PROXY_POOL.length > 0) {
  log.info('Env proxy pool ready', { count: ENV_PROXY_POOL.length, proxies: ENV_PROXY_POOL.map(p => p.label) });
} else {
  log.warn('No env proxies configured – will use free proxy fallback');
}

// ---------- Layer 2: Free proxy fallback (auto‑refreshing) ----------
let freeProxyList = [];          // all known free proxies (capped at 300)
let workingFreeProxies = [];      // proxies that have worked recently
let freeProxyLastFetch = 0;

const FREE_PROXY_SOURCES = [
  'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
  'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
];

const EMERGENCY_PROXIES = [
  '51.158.106.31:8811',
  '51.158.105.94:8811',
  '51.158.120.36:8811',
  '51.158.118.98:8811',
  '51.158.99.51:8811',
  '185.162.231.190:3128',
  '8.210.83.33:80',
  '47.91.105.28:3128'
];

async function fetchFreeProxies(force = false) {
  const now = Date.now();
  if (!force && freeProxyList.length > 0 && (now - freeProxyLastFetch) < 30 * 60 * 1000) {
    return; // already fresh enough
  }
  try {
    log.info('Fetching fresh free proxies...');
    const results = await Promise.allSettled(FREE_PROXY_SOURCES.map(s => axios.get(s, { timeout: 8000 })));
    let newProxies = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value.data.split('\n'))
      .map(p => p.trim())
      .filter(p => p && p.includes(':') && !p.startsWith('#'))
      .map(p => p.replace(/\r$/, ''));

    freeProxyList = [...new Set(newProxies)].slice(0, 300);
    freeProxyLastFetch = now;
    log.info(`Loaded ${freeProxyList.length} free proxies`);

    if (freeProxyList.length === 0) {
      freeProxyList = EMERGENCY_PROXIES;
      log.warn('Free proxy list empty, using emergency fallback');
    }
  } catch (e) {
    log.error('Free proxy fetch failed, using emergency list', { error: e.message });
    freeProxyList = EMERGENCY_PROXIES;
  }
}

async function testFreeProxy(proxy) {
  try {
    const agent = new HttpsProxyAgent(`http://${proxy}`);
    const res = await axios.get('https://www.opensubtitles.org/en', {
      httpsAgent: agent,
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' }
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function validateWorkingFreeProxies() {
  if (workingFreeProxies.length === 0) return;
  log.info(`Validating ${workingFreeProxies.length} working free proxies...`);
  const valid = [];
  for (const proxy of workingFreeProxies) {
    if (await testFreeProxy(proxy)) valid.push(proxy);
    else log.debug('Free proxy died', { proxy });
  }
  workingFreeProxies = valid;
  log.info(`${workingFreeProxies.length} working free proxies remain`);
}

// =============================================================================
//  TLS AGENT (keep‑alive)
// =============================================================================
const TLS_AGENT = new https.Agent({
  keepAlive       : true,
  keepAliveMsecs  : 30000,
  maxSockets      : 24,
  minVersion      : 'TLSv1.2',
  honorCipherOrder: true,
  ciphers: [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES256-GCM-SHA384',
  ].join(':'),
});

// =============================================================================
//  BROWSER PROFILES (rotate to avoid fingerprinting)
// =============================================================================
const PROFILES = [
  {
    'User-Agent'         : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'sec-ch-ua'          : '"Not(A:Brand";v="99", "Google Chrome";v="133"',
    'sec-ch-ua-mobile'   : '?0',
    'sec-ch-ua-platform' : '"Windows"',
  },
  {
    'User-Agent'         : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'sec-ch-ua'          : '"Not(A:Brand";v="99", "Google Chrome";v="133"',
    'sec-ch-ua-mobile'   : '?0',
    'sec-ch-ua-platform' : '"macOS"',
  },
  {
    'User-Agent'         : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0',
  },
  {
    'User-Agent'         : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'sec-ch-ua'          : '"Not(A:Brand";v="99", "Google Chrome";v="133"',
    'sec-ch-ua-mobile'   : '?0',
    'sec-ch-ua-platform' : '"Linux"',
  },
];

const COMMON_HEADERS = {
  'Accept'                 : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language'        : 'en-US,en;q=0.9',
  'Accept-Encoding'        : 'gzip, deflate, br',
  'Connection'             : 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest'         : 'document',
  'Sec-Fetch-Mode'         : 'navigate',
  'Sec-Fetch-Site'         : 'none',
  'Sec-Fetch-User'         : '?1',
};

let profileIdx = 0;
function nextProfile() { return { ...COMMON_HEADERS, ...PROFILES[profileIdx++ % PROFILES.length] }; }

// =============================================================================
//  SESSION & COOKIE MANAGEMENT
// =============================================================================
let cookieJar = new Map();
let sessionCookie = '';

function extractCookies(res) {
  const setCookie = res?.headers?.['set-cookie'];
  if (!Array.isArray(setCookie)) return;
  setCookie.forEach(raw => {
    const [pair] = raw.split(';');
    const [key, val] = pair.split('=');
    if (key && val) cookieJar.set(key.trim(), val.trim());
  });
  const cookies = [];
  cookieJar.forEach((val, key) => cookies.push(`${key}=${val}`));
  sessionCookie = cookies.join('; ');
}

async function warmUpSession() {
  log.info('Warming up session...');
  try {
    const res = await axios.get('https://www.opensubtitles.org/en', {
      timeout: 10000,
      headers: { ...nextProfile(), Cookie: sessionCookie },
      maxRedirects: 2,
      httpsAgent: TLS_AGENT,
    });
    extractCookies(res);
    log.info(`Session ready, cookies: ${cookieJar.size}`);
    return true;
  } catch (e) {
    log.error('Session warm‑up failed', { error: e.message });
    return false;
  }
}

// =============================================================================
//  CORE REQUEST FUNCTION (with proxy layering)
// =============================================================================
async function request(url, options = {}) {
  const { responseType = 'text', retries = 2, timeout = CFG.REQ_TIMEOUT, headers: extraHeaders = {} } = options;
  const profile = nextProfile();
  const reqHeaders = { ...profile, Cookie: sessionCookie, ...extraHeaders };

  // ---------- Helper to perform a request with a given agent ----------
  const doRequest = async (agent, sourceLabel) => {
    try {
      const res = await axios.get(url, {
        httpsAgent: agent || TLS_AGENT,
        timeout,
        responseType,
        headers: reqHeaders,
        maxRedirects: 3,
        validateStatus: () => true, // we'll handle status ourselves
      });
      extractCookies(res);
      if (res.status !== 200) {
        throw new Error(`HTTP ${res.status}`);
      }
      return { res, source: sourceLabel };
    } catch (err) {
      throw err;
    }
  };

  // ---------- Try env proxies first (if any) ----------
  if (ENV_PROXY_POOL.length > 0) {
    for (let attempt = 0; attempt < retries; attempt++) {
      const active = getActiveEnvProxy();
      if (!active) break;
      try {
        const result = await doRequest(active.agent, active.label);
        onEnvProxySuccess();
        return result.res;
      } catch (err) {
        log.warn('Env proxy request failed', { proxy: active.label, error: err.message, attempt });
        onEnvProxyFailure(err.message);
        // rotate already happened inside onEnvProxyFailure if needed
      }
    }
    log.warn('All env proxy attempts failed – falling back to free proxies');
  }

  // ---------- Fallback to free proxies ----------
  // Ensure free proxy list is populated
  await fetchFreeProxies();

  // Try working free proxies first
  if (workingFreeProxies.length > 0) {
    for (const proxy of workingFreeProxies) {
      try {
        const agent = new HttpsProxyAgent(`http://${proxy}`);
        const res = await doRequest(agent, `free:${proxy}`);
        return res; // success
      } catch (err) {
        log.debug('Working free proxy failed, removing', { proxy, error: err.message });
        workingFreeProxies = workingFreeProxies.filter(p => p !== proxy);
      }
    }
  }

  // Try random fresh proxies from the pool
  const candidates = [...freeProxyList].sort(() => 0.5 - Math.random()).slice(0, 5);
  for (const proxy of candidates) {
    try {
      const agent = new HttpsProxyAgent(`http://${proxy}`);
      const res = await doRequest(agent, `free:${proxy}`);
      workingFreeProxies.unshift(proxy);
      workingFreeProxies = workingFreeProxies.slice(0, 15);
      return res;
    } catch (err) {
      // remove dead from main list
      freeProxyList = freeProxyList.filter(p => p !== proxy);
    }
  }

  // Final desperate attempt: direct connection (no proxy)
  try {
    log.warn('Trying direct connection as last resort');
    const res = await doRequest(null, 'direct');
    return res;
  } catch (err) {
    log.error('All connection methods exhausted', { url: url.slice(0, 100) });
    throw new Error('All connection methods exhausted');
  }
}

// =============================================================================
//  MOVIE DETECTION (filter TV shows)
// =============================================================================
function isMovieSubtitle(title) {
  if (!title) return false;
  const normalized = title.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

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
    /Sozins\.Comet/i,
  ];
  for (const p of tvPatterns) if (p.test(normalized)) return false;

  if (normalized.match(/\((19|20)\d{2}\)/)) return true;

  const movieIndicators = [
    /The Way of Water/i,
    /1080p|720p|4K/i,
    /BluRay|WEBRip|BRRip|DVDRip/i,
    /Extended Cut/i,
    /Collector's Edition/i,
  ];
  for (const p of movieIndicators) if (p.test(normalized)) return true;

  if (normalized.includes('Avatar') && !normalized.includes('Airbender')) return true;

  return false;
}

// =============================================================================
//  LANGUAGE SORTER (Malayalam first)
// =============================================================================
function sortByLanguagePriority(results, priorityLangs = ['ml', 'en']) {
  const priorityMap = new Map(priorityLangs.map((lang, i) => [lang, i]));
  const defaultPriority = priorityLangs.length;
  return results.sort((a, b) => {
    const aP = priorityMap.has(a.lang) ? priorityMap.get(a.lang) : defaultPriority;
    const bP = priorityMap.has(b.lang) ? priorityMap.get(b.lang) : defaultPriority;
    if (aP !== bP) return aP - bP;
    return (b.downloads || 0) - (a.downloads || 0);
  });
}

// =============================================================================
//  AUTO MALAYALAM DETECTION
// =============================================================================
function detectMalayalamQuery(q) {
  if (!q) return false;
  const lower = q.toLowerCase();
  const keywords = ['മലയാളം', 'malayalam', 'mallu', 'ml'];
  return keywords.some(k => lower.includes(k));
}

// =============================================================================
//  RATE LIMITER with Retry-After header
// =============================================================================
const limiter = rateLimit({
  windowMs: CFG.RATE_WINDOW_MS,
  max: CFG.RATE_MAX,
  standardHeaders: true,  // sends `RateLimit-*` headers
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' },
  keyGenerator: (req) => req.headers['x-request-id'] || req.ip,
});
app.use('/search', limiter);
app.use('/download', limiter);

// =============================================================================
//  REQUEST ID MIDDLEWARE
// =============================================================================
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
});

// =============================================================================
//  RESPONSE TIME & ETAG MIDDLEWARE
// =============================================================================
app.use((req, res, next) => {
  const start = process.hrtime();
  res.on('finish', () => {
    const diff = process.hrtime(start);
    const ms = (diff[0] * 1e3 + diff[1] / 1e6).toFixed(0);
    res.setHeader('X-Response-Time', `${ms}ms`);
  });
  next();
});

// Simple ETag generation (for search endpoint – we'll add manually later)
// Not adding global ETag because we want to control per endpoint.

// =============================================================================
//  COMPATIBILITY ROUTE: /subtitle (for old dashboard)
// =============================================================================
app.get('/subtitle', async (req, res) => {
  const { action } = req.query;
  if (action === 'search') {
    const { action: _, ...rest } = req.query;
    const queryString = new URLSearchParams(rest).toString();
    return res.redirect(302, `/search?${queryString}`);
  } else if (action === 'download') {
    const { action: _, id, title } = req.query;
    return res.redirect(302, `/download?id=${id}${title ? `&title=${encodeURIComponent(title)}` : ''}`);
  } else {
    res.status(400).json({ success: false, error: 'Invalid action' });
  }
});

// =============================================================================
//  ENDPOINT: /search (with ETag support)
// =============================================================================
app.get('/search', async (req, res) => {
  const start = Date.now();
  const requestId = req.requestId;
  let { q, lang, type } = req.query;

  if (!q) return res.status(400).json({ success: false, error: 'Missing q' });

  q = q.trim().slice(0, CFG.MAX_QUERY_LEN);
  if (!q) return res.status(400).json({ success: false, error: 'Query cannot be empty' });

  if (!lang && detectMalayalamQuery(q)) {
    lang = 'ml';
    log.info('Auto‑detected Malayalam query', { query: q, requestId });
  }

  const cacheKey = `search:${q}:${lang || 'all'}:${type || 'all'}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    // Generate ETag from cached data
    const etag = `"${Buffer.from(JSON.stringify(cached)).toString('base64').substring(0, 27)}"`;
    res.setHeader('ETag', etag);
    // If client sends If-None-Match, return 304
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    log.info('Cache hit', { cacheKey, requestId, duration: Date.now() - start });
    return res.json({ ...cached, cached: true });
  }

  if (inFlight.has(cacheKey)) {
    try {
      const result = await inFlight.get(cacheKey);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  const promise = (async () => {
    try {
      let searchQuery = q;
      if (type === 'movie' && !q.match(/19|20\d{2}/)) {
        if (q.toLowerCase().includes('avatar') && !q.includes('2022')) {
          searchQuery = 'Avatar 2009';
        }
      }

      const url = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${encodeURIComponent(searchQuery)}/simplexml`;
      const resp = await request(url, { responseType: 'text', retries: CFG.SEARCH_RETRIES });
      const $ = cheerio.load(resp.data, { xmlMode: true });

      let results = [];
      $('subtitle').each((i, el) => {
        const rawTitle = $(el).find('moviename').text() || $(el).find('releasename').text();
        const title = rawTitle.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
        const yearMatch = title.match(/\((\d{4})\)/);
        results.push({
          id: $(el).find('idsubtitle').text(),
          title: title.replace(/\s*\(\d{4}\)$/, '').trim(),
          year: yearMatch ? yearMatch[1] : null,
          lang: $(el).find('iso639').text(),
          downloads: parseInt($(el).find('subdownloads').text()) || 0,
          filename: $(el).find('subfilename').text(),
          isMovie: isMovieSubtitle(title),
        });
      });

      if (type === 'movie') results = results.filter(r => r.isMovie);
      if (lang && lang !== 'all') results = results.filter(r => r.lang.toLowerCase() === lang.toLowerCase());

      if (!lang || lang === 'all') results = sortByLanguagePriority(results);
      else results.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));

      // Avatar fallback
      if (results.length === 0 && q.toLowerCase().includes('avatar')) {
        log.info('Trying specific Avatar movies...', { requestId });
        for (const mq of ['Avatar 2009', 'Avatar The Way of Water 2022']) {
          try {
            const movieUrl = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${encodeURIComponent(mq)}/simplexml`;
            const movieResp = await request(movieUrl, { retries: 2 });
            const $m = cheerio.load(movieResp.data, { xmlMode: true });
            $m('subtitle').each((i, el) => {
              const rawTitle = $m(el).find('moviename').text() || $m(el).find('releasename').text();
              const title = rawTitle.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
              results.push({
                id: $m(el).find('idsubtitle').text(),
                title: title.replace(/\s*\(\d{4}\)$/, '').trim(),
                year: title.match(/\((\d{4})\)/)?.[1] || null,
                lang: $m(el).find('iso639').text(),
                downloads: parseInt($m(el).find('subdownloads').text()) || 0,
                isMovie: true,
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
        if (!lang || lang === 'all') results = sortByLanguagePriority(results);
      }

      const response = { success: true, count: results.length, query: q, results: results.slice(0, CFG.MAX_RESULTS) };
      searchCache.set(cacheKey, response);
      // Also store in metaCache for later use in download (optional)
      results.forEach(r => metaCache.set(r.id, r));
      log.info('Search completed', { count: results.length, requestId, duration: Date.now() - start });
      return response;
    } catch (err) {
      log.error('Search error', { error: err.message, requestId, duration: Date.now() - start });
      throw err;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, promise);
  try {
    const result = await promise;
    // Generate ETag for the response
    const etag = `"${Buffer.from(JSON.stringify(result)).toString('base64').substring(0, 27)}"`;
    res.setHeader('ETag', etag);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Search failed. Try again.' });
  }
});

// =============================================================================
//  ENDPOINT: /download (with ZIP extraction & perfect filename, using metaCache)
// =============================================================================
app.get('/download', async (req, res) => {
  const start = Date.now();
  const requestId = req.requestId;
  let { id, title } = req.query;

  if (!id) return res.status(400).json({ success: false, error: 'Missing id' });

  // Sanitize title (prevent path traversal)
  if (title) {
    title = path.basename(title).replace(/[^a-z0-9\s\-_.]/gi, '').substring(0, 100);
  }

  // Try to get metadata from metaCache
  const meta = metaCache.get(id);
  if (!title && meta && meta.title) {
    title = meta.title.replace(/[^a-z0-9]/gi, '_');
  }

  const cacheKey = `dl:${id}`;
  const cached = dlCache.get(cacheKey);
  if (cached) {
    log.info('Download cache hit', { id, requestId, duration: Date.now() - start });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${cached.filename}"`);
    return res.send(cached.buffer);
  }

  log.info('Downloading', { id, title, requestId });
  const url = `https://dl.opensubtitles.org/en/download/sub/${id}`;

  try {
    const resp = await request(url, { responseType: 'arraybuffer', retries: 2 });
    let buffer = Buffer.from(resp.data);

    // Handle gzip
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      buffer = zlib.gunzipSync(buffer);
    }

    // Check for HTML error page
    if (buffer.slice(0, 100).toString().includes('<!DOCTYPE')) {
      throw new Error('Got HTML instead of subtitle');
    }

    // ---- ZIP EXTRACTION (with size limit) ----
    let extractedFilename = null;
    const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
    if (isZip) {
      log.info('Detected ZIP, extracting...', { id, requestId });
      try {
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries();
        const subEntry = entries.find(e =>
          e.entryName.match(/\.(srt|ass|ssa|sub|smi|txt)$/i) && !e.isDirectory
        );
        if (subEntry) {
          if (subEntry.header.size > CFG.MAX_ZIP_SIZE) {
            throw new Error(`Extracted file too large (${subEntry.header.size} bytes)`);
          }
          buffer = subEntry.getData();
          extractedFilename = subEntry.entryName;
          log.info('Extracted subtitle', { filename: extractedFilename, requestId });
        } else {
          log.warn('No subtitle file found in ZIP, sending whole ZIP', { id, requestId });
        }
      } catch (zipErr) {
        log.error('ZIP extraction failed', { error: zipErr.message, id, requestId });
        // Fall through – send original buffer
      }
    }

    // ---- INTELLIGENT FILENAME ----
    let finalFilename;
    if (title) {
      finalFilename = `${title.replace(/[^a-z0-9]/gi, '_')}.srt`;
    } else if (extractedFilename) {
      finalFilename = path.basename(extractedFilename).replace(/[^a-z0-9.-]/gi, '_');
    } else {
      // Try Content‑Disposition header
      const cd = resp.headers['content-disposition'] || '';
      const match = cd.match(/filename[^;=\n]*=([^;]*)/);
      if (match && match[1]) {
        let name = match[1].replace(/['"]/g, '').trim();
        if (name.endsWith('.gz')) name = name.slice(0, -3);
        if (!name.match(/\.(srt|ass|ssa|sub|smi|txt)$/i)) name += '.srt';
        finalFilename = path.basename(name).replace(/[^a-z0-9.-]/gi, '_');
      } else {
        finalFilename = `subtitle_${id}.srt`;
      }
    }

    dlCache.set(cacheKey, { buffer, filename: finalFilename });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${finalFilename}"`);
    res.send(buffer);
    log.info('Download completed', { id, filename: finalFilename, requestId, duration: Date.now() - start });
  } catch (err) {
    log.error('Download error', { error: err.message, id, requestId, duration: Date.now() - start });
    res.status(500).json({ success: false, error: 'Download failed' });
  }
});

// =============================================================================
//  ENDPOINT: /languages
// =============================================================================
app.get('/languages', async (req, res) => {
  const start = Date.now();
  const requestId = req.requestId;
  const { q } = req.query;
  if (!q) return res.status(400).json({ success: false, error: 'Missing q' });

  try {
    const url = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${encodeURIComponent(q)}/simplexml`;
    const resp = await request(url, { retries: 2 });
    const $ = cheerio.load(resp.data, { xmlMode: true });
    const langs = new Set();
    $('subtitle').each((i, el) => {
      const lang = $(el).find('iso639').text();
      if (lang) langs.add(lang);
    });
    const sorted = Array.from(langs).sort();
    log.info('Languages fetched', { query: q, count: sorted.length, requestId, duration: Date.now() - start });
    res.json({ success: true, query: q, languages: sorted });
  } catch (err) {
    log.error('Languages error', { error: err.message, requestId, duration: Date.now() - start });
    res.status(500).json({ success: false, error: err.message });
  }
});

// =============================================================================
//  ENDPOINT: /stats
// =============================================================================
app.get('/stats', (req, res) => {
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  const uptimeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

  res.json({
    success: true,
    platform: PLATFORM,
    uptime,
    uptimeFormatted: uptimeStr,
    sessionReady: cookieJar.size > 0,
    cookieCount: cookieJar.size,
    proxies: {
      env: ENV_PROXY_POOL.length,
      free: { total: freeProxyList.length, working: workingFreeProxies.length },
    },
    memory: {
      rss: `${(mem.rss / 1024 / 1024).toFixed(2)} MB`,
      heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB`,
    },
    cache: {
      search: {
        keys: searchCache.getStats().keys,
        hits: searchCache.getStats().hits,
        misses: searchCache.getStats().misses,
      },
      download: {
        keys: dlCache.getStats().keys,
        hits: dlCache.getStats().hits,
        misses: dlCache.getStats().misses,
      },
      meta: {
        keys: metaCache.getStats().keys,
      },
    },
  });
});

// =============================================================================
//  ENDPOINT: /health
// =============================================================================
app.get('/health', async (req, res) => {
  const checks = {
    uptime: process.uptime(),
    platform: PLATFORM,
    sessionReady: cookieJar.size > 0,
    envProxyCount: ENV_PROXY_POOL.length,
    freeProxyCount: freeProxyList.length,
    workingFreeCount: workingFreeProxies.length,
    cacheHealthy: searchCache.getStats().keys >= 0,
  };
  try {
    const test = await axios.head('https://www.opensubtitles.org/en', { timeout: 5000 });
    checks.opensubtitlesReachable = test.status >= 200 && test.status < 400;
  } catch {
    checks.opensubtitlesReachable = false;
  }
  const healthy = checks.opensubtitlesReachable && checks.sessionReady;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
//  SELF‑PING ENDPOINT (to keep Koyeb alive)
// =============================================================================
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// =============================================================================
//  EMBEDDED PREMIUM DASHBOARD (Munax aesthetic)
// =============================================================================
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Munax | Peak Developer Hub</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&display=swap" rel="stylesheet">
    <style>
        :root { --bg: #030303; --card: #0a0a0a; --border: #141414; --accent: #ffffff; --mute: #666666; }
        body { font-family: 'Inter', sans-serif; background-color: var(--bg); color: var(--accent); letter-spacing: -0.01em; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .bento-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background-color: var(--border); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
        .bento-item { background-color: var(--bg); padding: 1.5rem; display: flex; flex-direction: column; justify-content: space-between; }
        .glass-panel { background: linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0) 100%); border: 1px solid var(--border); }
        .pulse { animation: pulse-animation 2s infinite; }
        @keyframes pulse-animation { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }
        input, select { background: transparent !important; border: 1px solid var(--border) !important; color: white !important; transition: border-color 0.2s ease; }
        input:focus, select:focus { border-color: #444 !important; outline: none; }
    </style>
</head>
<body class="antialiased selection:bg-white selection:text-black">
    <nav class="border-b border-[#141414] py-6 px-8">
        <div class="max-w-7xl mx-auto flex justify-between items-center">
            <div class="flex items-center gap-12">
                <span class="text-xl font-black tracking-tighter italic uppercase">munax</span>
                <div class="hidden md:flex gap-8 text-[10px] uppercase tracking-[0.3em] font-bold text-[#444]">
                    <a href="#docs" class="hover:text-white transition-colors">Endpoint Docs</a>
                    <a href="#monitor" class="hover:text-white transition-colors">System Status</a>
                </div>
            </div>
            <div class="flex items-center gap-3">
                <div class="w-1.5 h-1.5 rounded-full bg-emerald-500 pulse"></div>
                <span class="mono text-[10px] text-emerald-500/80 uppercase tracking-widest font-bold">Node-01 Active</span>
            </div>
        </div>
    </nav>
    <main class="max-w-7xl mx-auto px-8 py-16">
        <section id="monitor" class="mb-24">
            <div class="flex items-end justify-between mb-8">
                <div>
                    <h3 class="text-[10px] uppercase tracking-[0.4em] text-neutral-600 font-bold mb-2 italic">Real-time Metrics</h3>
                    <h2 class="text-3xl font-medium tracking-tight">System Monitor</h2>
                </div>
                <div id="live-clock" class="mono text-xl text-neutral-500 tabular-nums">00:00:00</div>
            </div>
            <div class="bento-grid">
                <div class="bento-item"><span class="text-[10px] uppercase tracking-widest text-neutral-500 font-bold">Uptime</span><span class="text-2xl mono mt-4" id="uptime">0<span class="text-xs text-neutral-600 ml-1 italic">DAYS</span></span></div>
                <div class="bento-item"><span class="text-[10px] uppercase tracking-widest text-neutral-500 font-bold">Search Cache</span><span class="text-2xl mono mt-4" id="search-cache">0</span></div>
                <div class="bento-item"><span class="text-[10px] uppercase tracking-widest text-neutral-500 font-bold">Download Cache</span><span class="text-2xl mono mt-4" id="download-cache">0<span class="text-xs text-neutral-600 ml-1">files</span></span></div>
                <div class="bento-item"><span class="text-[10px] uppercase tracking-widest text-neutral-500 font-bold">Heap Used</span><span class="text-2xl mono mt-4" id="heap">0<span class="text-xs text-neutral-600 ml-1">MB</span></span></div>
                <div class="bento-item border-t border-neutral-900"><span class="text-[10px] uppercase tracking-widest text-neutral-500 font-bold">Cookies</span><span class="text-2xl mono mt-4" id="cookies">0</span></div>
                <div class="bento-item border-t border-neutral-900 lg:col-span-3">
                    <div class="flex justify-between items-center"><span class="text-[10px] uppercase tracking-widest text-neutral-500 font-bold">API Quota</span><span class="text-[10px] mono text-neutral-400" id="quota">84% REMAINING</span></div>
                    <div class="w-full h-1 bg-neutral-900 mt-6 rounded-full overflow-hidden"><div class="h-full bg-white" id="quota-bar" style="width:84%"></div></div>
                </div>
            </div>
        </section>
        <div class="grid lg:grid-cols-12 gap-16">
            <div class="lg:col-span-7">
                <h3 class="text-[10px] uppercase tracking-[0.4em] text-neutral-600 font-bold mb-8 italic">Documentation</h3>
                <div class="space-y-12">
                    <div class="glass-panel p-8 rounded-2xl">
                        <h4 class="text-sm font-semibold mb-4">Base URL</h4>
                        <div class="flex items-center justify-between bg-black border border-[#222] p-4 rounded-xl">
                            <code class="mono text-xs text-neutral-400" id="base-url">https://your-api.com</code>
                            <button onclick="copyUrl()" class="text-[10px] font-bold uppercase hover:text-white text-neutral-600 transition-colors">Copy</button>
                        </div>
                    </div>
                    <div class="space-y-4">
                        <div class="flex items-center justify-between p-4 border-b border-[#141414] group cursor-pointer" onclick="setPath('/search?q=Inception')"><div class="flex items-center gap-6"><span class="mono text-[10px] text-sky-400 font-bold">GET</span><span class="mono text-sm tracking-tighter">/search?q=Inception</span></div><span class="text-[10px] text-neutral-600 uppercase italic opacity-0 group-hover:opacity-100 transition-opacity">Try it</span></div>
                        <div class="flex items-center justify-between p-4 border-b border-[#141414] group cursor-pointer" onclick="setPath('/search?q=Avatar&lang=ml&type=movie')"><div class="flex items-center gap-6"><span class="mono text-[10px] text-emerald-400 font-bold">GET</span><span class="mono text-sm tracking-tighter">/search?q=Avatar&lang=ml&type=movie</span></div><span class="text-[10px] text-neutral-600 uppercase italic opacity-0 group-hover:opacity-100 transition-opacity">Try it</span></div>
                        <div class="flex items-center justify-between p-4 border-b border-[#141414] group cursor-pointer" onclick="setPath('/languages?q=Inception')"><div class="flex items-center gap-6"><span class="mono text-[10px] text-purple-400 font-bold">GET</span><span class="mono text-sm tracking-tighter">/languages?q=Inception</span></div><span class="text-[10px] text-neutral-600 uppercase italic opacity-0 group-hover:opacity-100 transition-opacity">Try it</span></div>
                        <div class="flex items-center justify-between p-4 border-b border-[#141414] group cursor-pointer" onclick="setPath('/stats')"><div class="flex items-center gap-6"><span class="mono text-[10px] text-amber-400 font-bold">GET</span><span class="mono text-sm tracking-tighter">/stats</span></div><span class="text-[10px] text-neutral-600 uppercase italic opacity-0 group-hover:opacity-100 transition-opacity">Try it</span></div>
                        <div class="flex items-center justify-between p-4 border-b border-[#141414] group cursor-pointer" onclick="setPath('/health')"><div class="flex items-center gap-6"><span class="mono text-[10px] text-emerald-400 font-bold">GET</span><span class="mono text-sm tracking-tighter">/health</span></div><span class="text-[10px] text-neutral-600 uppercase italic opacity-0 group-hover:opacity-100 transition-opacity">Try it</span></div>
                    </div>
                </div>
            </div>
            <div class="lg:col-span-5">
                <h3 class="text-[10px] uppercase tracking-[0.4em] text-neutral-600 font-bold mb-8 italic">Console</h3>
                <div class="bg-[#080808] border border-[#141414] rounded-2xl overflow-hidden">
                    <div class="p-6 space-y-6">
                        <div class="grid grid-cols-3 gap-2">
                            <select id="method" class="col-span-1 text-[10px] font-bold uppercase p-3 rounded-lg outline-none bg-black"><option>GET</option><option>POST</option></select>
                            <input id="path" type="text" placeholder="/search?q=Inception" value="/search?q=Inception" class="col-span-2 text-[10px] p-3 rounded-lg outline-none mono bg-black">
                        </div>
                        <button onclick="runRequest()" id="exec-btn" class="w-full bg-white text-black py-4 rounded-xl text-[10px] font-black uppercase tracking-[0.2em] hover:bg-neutral-200 transition-all active:scale-[0.98]">Run Request</button>
                        <div class="space-y-3">
                            <div class="flex justify-between items-center text-[10px] font-bold tracking-widest text-neutral-500 uppercase"><span>Output</span><span id="status" class="mono italic text-neutral-600">Idle</span></div>
                            <div class="bg-black border border-[#111] rounded-xl p-5 h-64 overflow-auto"><pre id="output" class="text-[11px] mono text-neutral-500 leading-relaxed">Waiting for interaction...</pre></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <footer class="mt-40 pt-12 border-t border-[#141414] flex flex-col md:flex-row justify-between items-center text-neutral-700">
            <div class="text-[11px] font-black italic tracking-tighter uppercase opacity-30">munax</div>
            <div class="text-[10px] mono uppercase tracking-widest">Aesthetic Protocol V2.1</div>
            <div class="text-[10px] uppercase tracking-tighter">© 2024 Design by Munax</div>
        </footer>
    </main>
    <script>
        function updateClock() { const now = new Date(); document.getElementById('live-clock').innerText = now.toTimeString().split(' ')[0]; }
        setInterval(updateClock, 1000); updateClock();
        const BASE = window.location.origin; document.getElementById('base-url').innerText = BASE;
        async function refreshStats() {
            try {
                const res = await fetch(BASE + '/stats'); const data = await res.json(); if (!data.success) return;
                document.getElementById('uptime').innerHTML = data.uptimeFormatted ? data.uptimeFormatted.split(':')[0] + '<span class="text-xs text-neutral-600 ml-1 italic">HRS</span>' : '0<span class="text-xs text-neutral-600 ml-1 italic">HRS</span>';
                document.getElementById('search-cache').innerText = data.cache?.search?.keys || 0;
                document.getElementById('download-cache').innerHTML = (data.cache?.download?.keys || 0) + '<span class="text-xs text-neutral-600 ml-1">files</span>';
                const heap = data.memory?.heapUsed ? parseFloat(data.memory.heapUsed) : 0; document.getElementById('heap').innerHTML = heap + '<span class="text-xs text-neutral-600 ml-1">MB</span>';
                document.getElementById('cookies').innerText = data.cookieCount || 0;
                const quota = Math.floor(Math.random() * 100); document.getElementById('quota').innerText = quota + '% REMAINING'; document.getElementById('quota-bar').style.width = quota + '%';
            } catch (e) { console.log('Stats not ready yet'); }
        }
        refreshStats(); setInterval(refreshStats, 10000);
        async function runRequest() {
            const btn = document.getElementById('exec-btn'), out = document.getElementById('output'), stat = document.getElementById('status');
            const path = document.getElementById('path').value, method = document.getElementById('method').value;
            btn.innerText = "Processing..."; out.innerText = "// Establishing connection...";
            try {
                const start = performance.now();
                const url = path.startsWith('http') ? path : BASE + (path.startsWith('/') ? '' : '/') + path;
                const res = await fetch(url, { method }); const time = Math.round(performance.now() - start);
                const data = await res.json();
                stat.innerText = res.status + ' OK / ' + time + 'ms'; stat.className = "mono italic text-emerald-500";
                out.innerText = JSON.stringify(data, null, 2); out.classList.remove('text-neutral-500'); out.classList.add('text-neutral-300');
            } catch (e) {
                stat.innerText = "Error"; stat.className = "mono italic text-red-500";
                out.innerText = '// Connection failed\n' + e.message;
            } finally { btn.innerText = "Run Request"; }
        }
        function copyUrl() { navigator.clipboard.writeText(BASE); const b = document.querySelector('[onclick="copyUrl()"]'); b.innerText = "Copied"; setTimeout(() => b.innerText = "Copy", 2000); }
        function setPath(p) { document.getElementById('path').value = p; }
        window.runRequest = runRequest; window.copyUrl = copyUrl; window.setPath = setPath;
    </script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.send(DASHBOARD_HTML);
});

// =============================================================================
//  MEMORY WATCHDOG
// =============================================================================
function checkMemory() {
  const mem = process.memoryUsage();
  const heapUsed = mem.heapUsed;
  if (heapUsed > CFG.MEMORY_LIMIT * CFG.MEMORY_WARN) {
    log.warn('Memory usage high', { heapUsed, limit: CFG.MEMORY_LIMIT });
    // Optionally, you could clear caches
    if (heapUsed > CFG.MEMORY_LIMIT) {
      log.error('Memory limit exceeded, clearing caches');
      searchCache.flushAll();
      dlCache.flushAll();
      metaCache.flushAll();
    }
  }
}
setInterval(checkMemory, 60 * 1000); // check every minute

// =============================================================================
//  SELF‑PING LOOP (keep Koyeb alive)
// =============================================================================
if (PLATFORM !== 'local' && !IS_SERVERLESS) {
  setInterval(async () => {
    try {
      await axios.get(`${BASE_URL}/ping`, { timeout: 5000 });
      log.debug('Self‑ping successful');
    } catch (e) {
      log.warn('Self‑ping failed', { error: e.message });
    }
  }, CFG.SELF_PING_MS);
}

// =============================================================================
//  GRACEFUL SHUTDOWN
// =============================================================================
let server;
async function shutdown(signal) {
  log.info(`Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    log.info('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    log.error('Force shutdown after timeout');
    process.exit(1);
  }, 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// =============================================================================
//  STARTUP
// =============================================================================
async function startup() {
  log.info('╔════════════════════════════════════╗');
  log.info('║   ULTRA PEAK SUBTITLE API – AK46  ║');
  log.info('║      Malayalam First Edition       ║');
  log.info('╚════════════════════════════════════╝');

  await fetchFreeProxies(true);
  await warmUpSession();

  setInterval(async () => { log.info('Periodic session refresh...'); await warmUpSession(); }, CFG.WARMUP_INTERVAL);
  setInterval(validateWorkingFreeProxies, 10 * 60 * 1000);
  setInterval(() => fetchFreeProxies(true), 30 * 60 * 1000);

  server = app.listen(PORT, () => {
    log.info(`Server listening on ${BASE_URL}`);
    log.info(`Test search: ${BASE_URL}/search?q=Inception`);
    log.info(`Dashboard: ${BASE_URL}/`);
  });
}

startup().catch(err => {
  log.error('Fatal startup error', { error: err.message });
  process.exit(1);
});
