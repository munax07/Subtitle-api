// =============================================================================
//  ULTIMATE PEAK SUBTITLE API – v14.0 (HYBRID PROXY + FREE FALLBACK)
//  with FULL PREMIUM DASHBOARD (served from root-page.html)
//  Architecture: munax + community
//  Features:
//    - Malayalam first, then English, then others
//    - Env‑var proxy pool (PROXY_URL, BACKUP_PROXY_1..20)
//    - Auto‑refreshing free proxy fallback (when env proxies fail/unset)
//    - Smart ZIP extraction with size limit, perfect filenames
//    - Session & cookies, caching, rate limiting, request IDs
//    - Structured JSON logs, graceful shutdown
//    - Full premium dashboard (root-page.html) with live stats, search tester, etc.
// =============================================================================

'use strict';

const express        = require('express');
const axios          = require('axios');
const cheerio        = require('cheerio');
const NodeCache      = require('node-cache');
const rateLimit      = require('express-rate-limit');
const cors           = require('cors');
const AdmZip         = require('adm-zip');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent'); // for SOCKS5 support
const zlib           = require('zlib');
const path           = require('path');
const https          = require('https');
const { randomUUID } = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

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
//  CONFIGURATION
// =============================================================================
const CFG = {
  CACHE_SEARCH_TTL : parseInt(process.env.CACHE_TTL_SEARCH) || 600,  // 10 min
  CACHE_DL_TTL     : parseInt(process.env.CACHE_TTL_DL)     || 1800, // 30 min
  CACHE_META_TTL   : 3600,                                          // 1 hr – subtitle metadata
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
const metaCache   = new NodeCache({ stdTTL: CFG.CACHE_META_TTL,   checkperiod: 300, useClones: false });

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
//  RATE LIMITER
// =============================================================================
const limiter = rateLimit({
  windowMs: CFG.RATE_WINDOW_MS,
  max: CFG.RATE_MAX,
  standardHeaders: true,
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
//  COMPATIBILITY ROUTE: /subtitle (for old dashboard)
// =============================================================================
app.get('/subtitle', async (req, res) => {
  const { action } = req.query;
  if (action === 'search') {
    const { action: _, ...rest } = req.query;
    // Preserve all other query parameters (q, lang, page, type)
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
//  ENDPOINT: /search
// =============================================================================
app.get('/search', async (req, res) => {
  const start = Date.now();
  const requestId = req.requestId;
  let { q, lang, type } = req.query;

  if (!q) return res.status(400).json({ success: false, error: 'Missing q' });

  // Trim and validate length
  q = q.trim().slice(0, CFG.MAX_QUERY_LEN);
  if (!q) return res.status(400).json({ success: false, error: 'Query cannot be empty' });

  // Auto‑detect Malayalam
  if (!lang && detectMalayalamQuery(q)) {
    lang = 'ml';
    log.info('Auto‑detected Malayalam query', { query: q, requestId });
  }

  const cacheKey = `search:${q}:${lang || 'all'}:${type || 'all'}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    log.info('Cache hit', { cacheKey, requestId, duration: Date.now() - start });
    return res.json({ ...cached, cached: true });
  }

  // Deduplicate concurrent identical requests
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
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Search failed. Try again.' });
  }
});

// =============================================================================
//  ENDPOINT: /download (with ZIP extraction & perfect filename)
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
//  ROOT DASHBOARD – served from root-page.html (no more template string issues!)
// =============================================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'root-page.html'));
});

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
  log.info('║   ULTRA PEAK SUBTITLE API v14.0   ║');
  log.info('║      Malayalam First Edition       ║');
  log.info('╚════════════════════════════════════╝');

  // Initialise free proxy pool
  await fetchFreeProxies(true);

  // Warm up session
  await warmUpSession();

  // Periodic jobs
  setInterval(async () => {
    log.info('Periodic session refresh...');
    await warmUpSession();
  }, CFG.WARMUP_INTERVAL);

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
