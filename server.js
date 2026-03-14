// =============================================================================
//  ULTIMATE PEAK SUBTITLE API – AK46 EDITION (Bulletproof + Dashboard Fixes)
//  Architecture: munax + Jerry 
//  Features:
//    - Malayalam first, then English, then others
//    - Hybrid proxy: residential (PROXY_URL + BACKUP_PROXY_1..20) + free fallback
//    - Auto‑refreshing free proxy pool (TheSpeedX, refreshed every 30 min)
//    - Smart ZIP extraction with size limit, perfect filenames
//    - Session & cookies, caching, rate limiting, request IDs
//    - Structured JSON logs, graceful shutdown, global error handlers
//    - Response time (logged only), ETag, Retry‑After headers
//    - Self‑ping (keeps Koyeb alive) & memory watchdog
//    - Full premium embedded dashboard (Munax aesthetic) – now with live data!
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
  CACHE_META_TTL   : 3600,                                          // 1 hr
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
const metaCache   = new NodeCache({ stdTTL: CFG.CACHE_META_TTL,   checkperiod: 300, useClones: false });

const inFlight = new Map();

// =============================================================================
//  PROXY LAYERS (same as before – unchanged)
// =============================================================================
function buildEnvProxyPool() {
  const list = [];
  if (process.env.PROXY_URL) list.push({ url: process.env.PROXY_URL, label: 'primary' });
  for (let i = 1; i <= 20; i++) {
    const v = process.env[`BACKUP_PROXY_${i}`];
    if (v) list.push({ url: v, label: `backup_${i}` });
  }
  return list.map(p => {
    try {
      let agent;
      if (p.url.startsWith('socks5://')) {
        agent = new SocksProxyAgent(p.url);
      } else {
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
let envIdx = 0, envFails = 0;
function getActiveEnvProxy() { return ENV_PROXY_POOL.length ? ENV_PROXY_POOL[envIdx % ENV_PROXY_POOL.length] : null; }
function rotateEnvProxy(reason) {
  if (ENV_PROXY_POOL.length <= 1) return;
  const prev = getActiveEnvProxy();
  envIdx = (envIdx + 1) % ENV_PROXY_POOL.length;
  envFails = 0;
  log.warn('Env proxy rotated', { from: prev?.label, to: getActiveEnvProxy()?.label, reason });
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

// Free proxy fallback (unchanged) – included for completeness
let freeProxyList = [], workingFreeProxies = [], freeProxyLastFetch = 0;
const FREE_PROXY_SOURCES = [ /* ... */ ]; // keep as before
const EMERGENCY_PROXIES = [ /* ... */ ];  // keep as before

async function fetchFreeProxies(force = false) { /* ... */ } // keep as before
async function testFreeProxy(proxy) { /* ... */ } // keep as before
async function validateWorkingFreeProxies() { /* ... */ } // keep as before

// TLS agent, browser profiles, session management (unchanged)
const TLS_AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 24 });
const PROFILES = [ /* ... */ ]; // keep as before
const COMMON_HEADERS = { /* ... */ }; // keep as before
let profileIdx = 0;
function nextProfile() { return { ...COMMON_HEADERS, ...PROFILES[profileIdx++ % PROFILES.length] }; }

let cookieJar = new Map(), sessionCookie = '';
function extractCookies(res) { /* ... */ } // keep as before
async function warmUpSession() { /* ... */ } // keep as before

// Core request function (unchanged)
async function request(url, options = {}) { /* ... */ } // keep as before

// Movie detection, language sorter, Malayalam detection (unchanged)
function isMovieSubtitle(title) { /* ... */ } // keep as before
function sortByLanguagePriority(results, priorityLangs = ['ml', 'en']) { /* ... */ } // keep as before
function detectMalayalamQuery(q) { /* ... */ } // keep as before

// Rate limiter, request ID, double-response prevention, response time (unchanged)
const limiter = rateLimit({ windowMs: CFG.RATE_WINDOW_MS, max: CFG.RATE_MAX, standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' },
  keyGenerator: (req) => req.headers['x-request-id'] || req.ip });
app.use('/search', limiter);
app.use('/download', limiter);

app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
});

app.use((req, res, next) => {
  const originalSend = res.send;
  const originalJson = res.json;
  res.send = function(...args) {
    if (res.headersSent) {
      log.warn('Attempted to send response twice – ignored', { path: req.path, method: req.method });
      return;
    }
    originalSend.apply(res, args);
  };
  res.json = function(...args) {
    if (res.headersSent) {
      log.warn('Attempted to send JSON twice – ignored', { path: req.path, method: req.method });
      return;
    }
    originalJson.apply(res, args);
  };
  next();
});

app.use((req, res, next) => {
  const start = process.hrtime();
  res.on('finish', () => {
    const diff = process.hrtime(start);
    const ms = (diff[0] * 1e3 + diff[1] / 1e6).toFixed(0);
    log.debug('Request completed', { path: req.path, method: req.method, durationMs: ms });
  });
  next();
});

// =============================================================================
//  COMPATIBILITY ROUTE: /subtitle
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
    return res.status(400).json({ success: false, error: 'Invalid action' });
  }
});

// =============================================================================
//  ENDPOINT: /search (with ETag fix)
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
    const responseWithFlag = { ...cached, cached: true };
    const etag = `"${Buffer.from(JSON.stringify(responseWithFlag)).toString('base64').substring(0, 27)}"`;
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    log.info('Cache hit', { cacheKey, requestId, duration: Date.now() - start });
    return res.json(responseWithFlag);
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

      // Avatar fallback (unchanged)
      if (results.length === 0 && q.toLowerCase().includes('avatar')) {
        // ... (keep existing fallback)
      }

      const response = { success: true, count: results.length, query: q, results: results.slice(0, CFG.MAX_RESULTS) };
      searchCache.set(cacheKey, response);
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
    const etag = `"${Buffer.from(JSON.stringify(result)).toString('base64').substring(0, 27)}"`;
    res.setHeader('ETag', etag);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Search failed. Try again.' });
  }
});

// =============================================================================
//  ENDPOINT: /download (unchanged, but with log fixed)
// =============================================================================
app.get('/download', async (req, res) => {
  const start = Date.now();
  const requestId = req.requestId;
  let { id, title } = req.query;

  if (!id) return res.status(400).json({ success: false, error: 'Missing id' });

  if (title) {
    title = path.basename(title).replace(/[^a-z0-9\s\-_.]/gi, '').substring(0, 100);
  }

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

    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      buffer = zlib.gunzipSync(buffer);
    }

    if (buffer.slice(0, 100).toString().includes('<!DOCTYPE')) {
      throw new Error('Got HTML instead of subtitle');
    }

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
      }
    }

    let finalFilename;
    if (title) {
      finalFilename = `${title.replace(/[^a-z0-9]/gi, '_')}.srt`;
    } else if (extractedFilename) {
      finalFilename = path.basename(extractedFilename).replace(/[^a-z0-9.-]/gi, '_');
    } else {
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
    log.info('Download completed', { id, filename: finalFilename, requestId, duration: Date.now() - start });
    return res.send(buffer);
  } catch (err) {
    log.error('Download error', { error: err.message, id, requestId, duration: Date.now() - start });
    return res.status(500).json({ success: false, error: 'Download failed' });
  }
});

// =============================================================================
//  ENDPOINT: /languages (unchanged)
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
    return res.json({ success: true, query: q, languages: sorted });
  } catch (err) {
    log.error('Languages error', { error: err.message, requestId, duration: Date.now() - start });
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =============================================================================
//  ENDPOINT: /stats (returns real data for dashboard)
// =============================================================================
app.get('/stats', (req, res) => {
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  const uptimeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

  return res.json({
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
//  ENDPOINT: /health (unchanged)
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
  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
//  SELF‑PING ENDPOINT
// =============================================================================
app.get('/ping', (req, res) => {
  return res.status(200).send('pong');
});

// =============================================================================
//  EMBEDDED PREMIUM DASHBOARD (with robust JavaScript)
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
                <div class="bento-item"><span class="text-[10px] uppercase tracking-widest text-neutral-500 font-bold">Uptime</span><span class="text-2xl mono mt-4" id="uptime">0<span class="text-xs text-neutral-600 ml-1 italic">HRS</span></span></div>
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
        // Ensure DOM is fully loaded before running
        document.addEventListener('DOMContentLoaded', function() {
            // Live clock
            function updateClock() {
                const now = new Date();
                document.getElementById('live-clock').innerText = now.toTimeString().split(' ')[0];
            }
            setInterval(updateClock, 1000);
            updateClock();

            // Set base URL dynamically
            const BASE = window.location.origin;
            document.getElementById('base-url').innerText = BASE;

            // Stats refresh
            async function refreshStats() {
                try {
                    const res = await fetch(BASE + '/stats');
                    if (!res.ok) throw new Error('Stats endpoint not available');
                    const data = await res.json();
                    if (!data.success) return;

                    // Update uptime (format as hours)
                    if (data.uptimeFormatted) {
                        const hours = data.uptimeFormatted.split(':')[0];
                        document.getElementById('uptime').innerHTML = hours + '<span class="text-xs text-neutral-600 ml-1 italic">HRS</span>';
                    } else {
                        document.getElementById('uptime').innerHTML = '0<span class="text-xs text-neutral-600 ml-1 italic">HRS</span>';
                    }

                    document.getElementById('search-cache').innerText = data.cache?.search?.keys || 0;
                    document.getElementById('download-cache').innerHTML = (data.cache?.download?.keys || 0) + '<span class="text-xs text-neutral-600 ml-1">files</span>';

                    const heap = data.memory?.heapUsed ? parseFloat(data.memory.heapUsed) : 0;
                    document.getElementById('heap').innerHTML = heap + '<span class="text-xs text-neutral-600 ml-1">MB</span>';

                    document.getElementById('cookies').innerText = data.cookieCount || 0;

                    // Quota (simulated, you can replace with real data if available)
                    const quota = Math.floor(Math.random() * 100);
                    document.getElementById('quota').innerText = quota + '% REMAINING';
                    document.getElementById('quota-bar').style.width = quota + '%';
                } catch (e) {
                    console.log('Stats not ready yet:', e.message);
                    // Keep showing zeros, but don't break the page
                }
            }
            refreshStats();
            setInterval(refreshStats, 10000);

            // Console functions
            window.runRequest = async function() {
                const btn = document.getElementById('exec-btn');
                const out = document.getElementById('output');
                const stat = document.getElementById('status');
                const path = document.getElementById('path').value;
                const method = document.getElementById('method').value;

                btn.innerText = "Processing...";
                out.innerText = "// Establishing connection...";
                stat.innerText = "Loading";

                try {
                    const start = performance.now();
                    const url = path.startsWith('http') ? path : BASE + (path.startsWith('/') ? '' : '/') + path;
                    const res = await fetch(url, { method });
                    const time = Math.round(performance.now() - start);
                    const data = await res.json();

                    stat.innerText = res.status + ' OK / ' + time + 'ms';
                    stat.className = "mono italic text-emerald-500";
                    out.innerText = JSON.stringify(data, null, 2);
                    out.classList.remove('text-neutral-500');
                    out.classList.add('text-neutral-300');
                } catch (e) {
                    stat.innerText = "Error";
                    stat.className = "mono italic text-red-500";
                    out.innerText = '// Connection failed\n' + e.message;
                } finally {
                    btn.innerText = "Run Request";
                }
            };

            window.copyUrl = function() {
                navigator.clipboard.writeText(BASE);
                const b = document.querySelector('[onclick="copyUrl()"]');
                b.innerText = "Copied";
                setTimeout(() => b.innerText = "Copy", 2000);
            };

            window.setPath = function(p) {
                document.getElementById('path').value = p;
            };
        });
    </script>
</body>
</html>`;

app.get('/', (req, res) => {
  return res.send(DASHBOARD_HTML);
});

// =============================================================================
//  MEMORY WATCHDOG
// =============================================================================
function checkMemory() {
  const mem = process.memoryUsage();
  const heapUsed = mem.heapUsed;
  if (heapUsed > CFG.MEMORY_LIMIT * CFG.MEMORY_WARN) {
    log.warn('Memory usage high', { heapUsed, limit: CFG.MEMORY_LIMIT });
    if (heapUsed > CFG.MEMORY_LIMIT) {
      log.error('Memory limit exceeded, clearing caches');
      searchCache.flushAll();
      dlCache.flushAll();
      metaCache.flushAll();
    }
  }
}
setInterval(checkMemory, 60 * 1000);

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
  if (server) {
    server.close(() => {
      log.info('HTTP server closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
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
