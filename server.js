const express   = require(‘express’);
const axios     = require(‘axios’);
const cheerio   = require(‘cheerio’);
const NodeCache = require(‘node-cache’);
const rateLimit = require(‘express-rate-limit’);
const cors      = require(‘cors’);
const https     = require(‘https’);
const path      = require(‘path’);

const app  = express();
const PORT = process.env.PORT || 3000;

// PLATFORM DETECTION
const PLATFORM = (function() {
if (process.env.RENDER === ‘true’ || process.env.RENDER_EXTERNAL_URL) return ‘render’;
if (process.env.KOYEB_APP_NAME    || process.env.KOYEB)               return ‘koyeb’;
if (process.env.VERCEL            || process.env.VERCEL_URL)           return ‘vercel’;
if (process.env.RAILWAY_STATIC_URL|| process.env.RAILWAY_ENVIRONMENT)  return ‘railway’;
if (process.env.FLY_APP_NAME)                                          return ‘fly’;
return ‘local’;
}());

const BASE_URL = (function() {
if (PLATFORM === ‘render’)  return process.env.RENDER_EXTERNAL_URL   || (‘http://localhost:’ + PORT);
if (PLATFORM === ‘koyeb’)   return ‘https://’ + (process.env.KOYEB_PUBLIC_DOMAIN || ((process.env.KOYEB_APP_NAME || ‘app’) + ‘.koyeb.app’));
if (PLATFORM === ‘vercel’)  return process.env.VERCEL_URL ? (‘https://’ + process.env.VERCEL_URL) : (‘http://localhost:’ + PORT);
if (PLATFORM === ‘railway’) return process.env.RAILWAY_STATIC_URL    || (‘http://localhost:’ + PORT);
if (PLATFORM === ‘fly’)     return ‘https://’ + process.env.FLY_APP_NAME + ‘.fly.dev’;
return ‘http://localhost:’ + PORT;
}());

const IS_SERVERLESS = PLATFORM === ‘vercel’;
const IS_PROD       = process.env.NODE_ENV === ‘production’;
const NEEDS_PING    = (PLATFORM === ‘render’ || PLATFORM === ‘koyeb’ || PLATFORM === ‘railway’);

app.set(‘trust proxy’, IS_SERVERLESS ? false : 1);

// CONFIG
const CFG = {
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

// CACHES
const searchCache = new NodeCache({ stdTTL: CFG.CACHE_SEARCH_TTL, checkperiod: 90,  useClones: false });
const dlCache     = new NodeCache({ stdTTL: CFG.CACHE_DL_TTL,     checkperiod: 120, useClones: false });

// MIDDLEWARE
app.use(cors({ origin: ‘*’, methods: [‘GET’, ‘OPTIONS’] }));
app.use(express.json({ limit: ‘1mb’ }));
app.use(function(_req, res, next) {
res.setHeader(‘X-Content-Type-Options’, ‘nosniff’);
res.setHeader(‘X-Frame-Options’, ‘DENY’);
res.setHeader(‘X-Powered-By’, ‘VOID CINEMA API’);
next();
});

const limiter = rateLimit({
windowMs       : CFG.RATE_WINDOW_MS,
max            : CFG.RATE_MAX,
standardHeaders: true,
legacyHeaders  : false,
skip           : function() { return IS_SERVERLESS; },
message        : { success: false, error: ‘Rate limit exceeded. Try again in 15 minutes.’ },
});

// BROWSER PROFILES
const PROFILES = [
{
‘User-Agent’            : ‘Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36’,
‘sec-ch-ua’             : ‘“Not(A:Brand”;v=“99”, “Google Chrome”;v=“133”, “Chromium”;v=“133”’,
‘sec-ch-ua-mobile’      : ‘?0’,
‘sec-ch-ua-platform’    : ‘“Windows”’,
‘Accept’                : ‘text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8’,
‘Accept-Language’       : ‘en-US,en;q=0.9’,
‘Accept-Encoding’       : ‘gzip, deflate, br’,
‘Connection’            : ‘keep-alive’,
‘Upgrade-Insecure-Requests’: ‘1’,
‘Sec-Fetch-Dest’        : ‘document’,
‘Sec-Fetch-Mode’        : ‘navigate’,
‘Sec-Fetch-Site’        : ‘none’,
‘Sec-Fetch-User’        : ‘?1’,
},
{
‘User-Agent’            : ‘Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36’,
‘sec-ch-ua’             : ‘“Not(A:Brand”;v=“99”, “Google Chrome”;v=“133”, “Chromium”;v=“133”’,
‘sec-ch-ua-mobile’      : ‘?0’,
‘sec-ch-ua-platform’    : ‘“macOS”’,
‘Accept’                : ‘text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8’,
‘Accept-Language’       : ‘en-US,en;q=0.9’,
‘Accept-Encoding’       : ‘gzip, deflate, br’,
‘Connection’            : ‘keep-alive’,
‘Upgrade-Insecure-Requests’: ‘1’,
‘Sec-Fetch-Dest’        : ‘document’,
‘Sec-Fetch-Mode’        : ‘navigate’,
‘Sec-Fetch-Site’        : ‘none’,
‘Sec-Fetch-User’        : ‘?1’,
},
{
‘User-Agent’            : ‘Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0’,
‘Accept’                : ‘text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8’,
‘Accept-Language’       : ‘en-US,en;q=0.5’,
‘Accept-Encoding’       : ‘gzip, deflate, br’,
‘Connection’            : ‘keep-alive’,
‘Upgrade-Insecure-Requests’: ‘1’,
‘Sec-Fetch-Dest’        : ‘document’,
‘Sec-Fetch-Mode’        : ‘navigate’,
‘Sec-Fetch-Site’        : ‘none’,
‘Sec-Fetch-User’        : ‘?1’,
},
{
‘User-Agent’            : ‘Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36’,
‘sec-ch-ua’             : ‘“Not(A:Brand”;v=“99”, “Google Chrome”;v=“133”, “Chromium”;v=“133”’,
‘sec-ch-ua-mobile’      : ‘?0’,
‘sec-ch-ua-platform’    : ‘“Linux”’,
‘Accept’                : ‘text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8’,
‘Accept-Language’       : ‘en-US,en;q=0.9’,
‘Accept-Encoding’       : ‘gzip, deflate, br’,
‘Connection’            : ‘keep-alive’,
‘Upgrade-Insecure-Requests’: ‘1’,
‘Sec-Fetch-Dest’        : ‘document’,
‘Sec-Fetch-Mode’        : ‘navigate’,
‘Sec-Fetch-Site’        : ‘none’,
‘Sec-Fetch-User’        : ‘?1’,
},
];

let profileIdx = 0;
function nextProfile() { return PROFILES[profileIdx++ % PROFILES.length]; }

// COOKIE JAR
const cookieJar = new Map([[‘lang’, ‘en’], [‘oslocale’, ‘en’]]);

function extractCookies(res) {
const sc = res && res.headers && res.headers[‘set-cookie’];
if (!Array.isArray(sc)) return;
sc.forEach(function(raw) {
const pair = raw.split(’;’)[0];
const eq   = pair.indexOf(’=’);
if (eq < 1) return;
const key = pair.slice(0, eq).trim();
const val = pair.slice(eq + 1).trim();
if (key) cookieJar.set(key, val);
});
}

function cookieHeader() {
const parts = [];
cookieJar.forEach(function(v, k) { parts.push(k + ‘=’ + v); });
return parts.join(’; ’);
}

// TLS AGENT
const TLS_AGENT = new https.Agent({
keepAlive       : true,
keepAliveMsecs  : 30000,
maxSockets      : 20,
minVersion      : ‘TLSv1.2’,
honorCipherOrder: true,
ciphers: [
‘TLS_AES_128_GCM_SHA256’,
‘TLS_AES_256_GCM_SHA384’,
‘TLS_CHACHA20_POLY1305_SHA256’,
‘ECDHE-RSA-AES128-GCM-SHA256’,
‘ECDHE-ECDSA-AES128-GCM-SHA256’,
‘ECDHE-RSA-AES256-GCM-SHA384’,
].join(’:’),
});

// PROXY
let PROXY = false;
if (process.env.PROXY_URL) {
try {
const p = new URL(process.env.PROXY_URL);
PROXY = { protocol: p.protocol.replace(’:’, ‘’), host: p.hostname, port: parseInt(p.port, 10) };
if (p.username) PROXY.auth = { username: decodeURIComponent(p.username), password: decodeURIComponent(p.password) };
console.log(’Proxy active: ’ + p.hostname);
} catch(e) { console.warn(‘Invalid PROXY_URL’); }
}

// HTTP CLIENT
function createClient(extra) {
const headers = Object.assign({}, nextProfile(), { Cookie: cookieHeader() }, extra || {});
return axios.create({
timeout       : CFG.REQ_TIMEOUT,
maxRedirects  : CFG.MAX_REDIRECTS,
httpsAgent    : TLS_AGENT,
proxy         : PROXY,
decompress    : true,
validateStatus: function() { return true; },
headers       : headers,
});
}

// UTILS
function mkErr(type, msg, dbg) {
const e = new Error(msg);
e.type  = type;
e.debug = IS_PROD ? null : (dbg || null);
return e;
}

function delay(mn, mx) {
const ms = Math.floor(Math.random() * ((mx || CFG.DELAY_MAX) - (mn || CFG.DELAY_MIN) + 1)) + (mn || CFG.DELAY_MIN);
return new Promise(function(r) { setTimeout(r, ms); });
}

function fmtBytes(b) {
if (!b) return ‘0 B’;
const u = [‘B’,‘KB’,‘MB’,‘GB’];
const i = Math.floor(Math.log(b) / Math.log(1024));
return (b / Math.pow(1024, i)).toFixed(2) + ’ ’ + u[i];
}

function fmtUptime(s) {
return String(Math.floor(s/3600)).padStart(2,‘0’) + ‘:’ +
String(Math.floor((s%3600)/60)).padStart(2,‘0’) + ‘:’ +
String(Math.floor(s%60)).padStart(2,‘0’);
}

function isHtml(buf) {
const s = Buffer.isBuffer(buf) ? buf.subarray(0,800).toString(‘utf8’) : String(buf).slice(0,800);
return /<(html|!doctype|body|head)\b/i.test(s);
}

// PARSER
function parseSearchPage(html) {
if (typeof html !== ‘string’ || !html) return null;
const $ = cheerio.load(html);
if ($(’#search_results’).length === 0) return null;

const results = [];
$(’#search_results tbody tr’).each(function(_, row) {
const $r = $(row);
if ($r.hasClass(‘head’) || $r.attr(‘style’) === ‘display:none’ || !$r.attr(‘onclick’)) return;

```
const iM = ($r.attr('onclick')||'').match(/servOC\((\d+)/) || ($r.attr('id')||'').match(/name(\d+)/);
if (!iM) return;
const id = iM[1];

let title = $r.find('td:first-child strong a').first().text().trim();
if (!title) return;
let year = null;
const ym = title.match(/\((\d{4})\)$/);
if (ym) { year = ym[1]; title = title.replace(/\s*\(\d{4}\)$/, '').trim(); }

let lang = 'unknown';
const lm = ($r.find('.flag').first().attr('class')||'').match(/flag\s+([a-z]{2})/);
if (lm) lang = lm[1];

let downloads = 0;
const dl = $r.find('a[href*="subtitleserve"]').first();
if (dl.length) downloads = parseInt(dl.text().replace(/[^\d]/g,''), 10) || 0;

const uploader  = $r.find('td:last-child a').first().text().trim() || 'anonymous';
const uploadDate= $r.find('time').first().text().trim() || null;

let filename = null;
const st = $r.find('span[title]').first().attr('title');
if (st && !/^\d+\s+votes?$/i.test(st)) filename = st;

const features = {
  hd             : $r.find('img[src*="hd.gif"]').length             > 0,
  hearingImpaired: $r.find('img[src*="hearing_impaired.gif"]').length > 0,
  trusted        : $r.find('img[src*="from_trusted.gif"]').length    > 0,
};

results.push({ id, title, year, language: lang, downloads, uploader, uploadDate, filename, features });
```

});

return results;
}

// SESSION WARM-UP
let sessionReady   = false;
let sessionWarming = false;

function warmUpSession(attempt) {
attempt = attempt || 1;
if (sessionWarming) return Promise.resolve();
sessionWarming = true;
console.log(’Warming up session (attempt ’ + attempt + ‘)…’);

return createClient({ ‘Sec-Fetch-Site’: ‘none’ }).get(‘https://www.opensubtitles.org/en’)
.then(function(res) {
extractCookies(res);
if (res.status === 200) { sessionReady = true; console.log(’Session ready. Cookies: ’ + cookieJar.size); }
else throw new Error(’HTTP ’ + res.status);
})
.catch(function(err) {
console.warn(’Warm-up ’ + attempt + ’ failed: ’ + err.message);
if (attempt < CFG.WARMUP_RETRIES) {
sessionWarming = false;
return delay(CFG.WARMUP_DELAY, CFG.WARMUP_DELAY * 1.5).then(function() { return warmUpSession(attempt + 1); });
}
console.warn(‘Warm-up gave up.’);
})
.finally(function() { sessionWarming = false; });
}

// SEARCH
function buildURLs(query, page) {
const enc = encodeURIComponent(query);
const off = (page - 1) * 40;
return [
‘https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-’ + enc + ‘/’ + page,
‘https://www.opensubtitles.org/en/search2/sublanguageid-all/moviename-’ + enc + ‘/offset-’ + off + ‘/sort-7/asc-0’,
];
}

function searchSubtitles(query, page) {
page = page || 1;
const ckey = ‘s:’ + query + ‘:’ + page;
const hit  = searchCache.get(ckey);
if (hit) return Promise.resolve(Object.assign({}, hit, { fromCache: true }));

const urls = buildURLs(query, page);
let lastErr = null;
let att = 0;

function run() {
if (att >= CFG.SEARCH_RETRIES) return Promise.reject(lastErr || mkErr(‘search_failed’, ‘All attempts exhausted.’));
const backoff = CFG.DELAY_MIN * Math.pow(1.5, att);
const url = urls[att % urls.length];
att++;

```
return delay(backoff, backoff + 1400)
  .then(function() { return createClient({ Referer: 'https://www.opensubtitles.org/en' }).get(url); })
  .then(function(res) {
    extractCookies(res);
    if (res.status === 403 || res.status === 429 || res.status === 503) {
      console.warn('Status ' + res.status + ' - re-warming...');
      lastErr = mkErr('blocked', 'HTTP ' + res.status);
      return warmUpSession().then(run);
    }
    if (res.status !== 200) { lastErr = mkErr('search_failed', 'HTTP ' + res.status); return run(); }
    if (typeof res.data === 'string' && res.data.indexOf('search_results') === -1) {
      console.warn('Redirect detected - re-warming...');
      lastErr = mkErr('redirected', 'Got homepage instead of results.');
      return warmUpSession().then(run);
    }
    const results = parseSearchPage(res.data);
    if (!results) { lastErr = mkErr('parse_failed', 'Could not parse page.'); return run(); }
    results.sort(function(a,b) { return b.downloads - a.downloads; });
    const payload = { query, page, total: results.length, fromCache: false, results };
    searchCache.set(ckey, payload);
    return payload;
  })
  .catch(function(err) {
    if (err.type) return Promise.reject(err);
    lastErr = mkErr('network_error', 'Network: ' + err.message);
    return run();
  });
```

}
return run();
}

function filterByLanguage(data, lang) {
if (!lang || lang === ‘all’) return data;
const filtered = data.results.filter(function(r) { return r.language.toLowerCase() === lang.toLowerCase(); });
return Object.assign({}, data, { language: lang, total: filtered.length, results: filtered });
}

// DOWNLOAD
function downloadSubtitle(id, hint) {
const ckey = ‘dl:’ + id;
const hit  = dlCache.get(ckey);
if (hit) return Promise.resolve(hit);

const urls = [
‘https://dl.opensubtitles.org/en/download/sub/’ + id,
‘https://www.opensubtitles.org/en/subtitleserve/sub/’ + id,
];
let idx = 0;

function tryNext() {
if (idx >= urls.length) return Promise.reject(mkErr(‘download_failed’, ‘All sources failed.’));
const url = urls[idx++];
return delay(CFG.DL_DELAY_MIN, CFG.DL_DELAY_MAX)
.then(function() {
return createClient({ Referer: ‘https://www.opensubtitles.org/en/subtitles/’ + id }).get(url, { responseType: ‘arraybuffer’ });
})
.then(function(res) {
extractCookies(res);
if (res.status !== 200) return tryNext();
const buf = Buffer.from(res.data);
if (buf.length < 16 || isHtml(buf)) return tryNext();

```
    let ext  = 'srt';
    let name = hint || null;
    const cd  = res.headers['content-disposition'] || '';
    const cdm = cd.match(/filename[^;=\n]*=(['"]?)([^\n'"]*)\1/i);
    if (cdm && cdm[2]) name = path.basename(cdm[2]).replace(/[^\w.\-]/g,'_');
    if (name) { const p = name.split('.'); if (p.length > 1) ext = p.pop().toLowerCase(); }
    if (!name) name = 'subtitle_' + id + '.' + ext;

    const result = { buffer: buf, ext, filename: name, size: buf.length };
    dlCache.set(ckey, result);
    return result;
  })
  .catch(function() { return tryNext(); });
```

}
return tryNext();
}

// VALIDATION
function validateQuery(q) {
if (!q || typeof q !== ‘string’) return ‘Missing parameter q’;
if (!q.trim()) return ‘Query cannot be blank’;
if (q.trim().length > CFG.MAX_QUERY_LEN) return ‘Query too long’;
return null;
}
function validatePage(s) {
if (!s) return 1;
const n = parseInt(s, 10);
if (isNaN(n) || n < 1 || n > CFG.MAX_PAGE) return null;
return n;
}
function validateId(id) { return typeof id === ‘string’ && /^\d{1,12}$/.test(id.trim()); }

// BACKGROUND JOBS
if (!IS_SERVERLESS) {
if (NEEDS_PING) {
setInterval(function() {
axios.get(BASE_URL + ‘/health’, { timeout: 6000 })
.then(function(r) { console.log(’Self-ping -> ’ + r.status); })
.catch(function(e) { console.warn(’Ping failed: ’ + e.message); });
}, CFG.SELF_PING_MS);
}
setInterval(function() { warmUpSession(); }, CFG.SESSION_REFRESH_MS);
setInterval(function() {
if (process.memoryUsage().heapUsed > CFG.MEMORY_LIMIT * CFG.MEMORY_WARN) {
searchCache.flushAll(); dlCache.flushAll();
if (typeof global.gc === ‘function’) global.gc();
}
}, 5 * 60 * 1000);
}

// ROOT PAGE
const ROOT = `<!DOCTYPE html>

<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VOID CINEMA - Subtitle API</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@800&display=swap" rel="stylesheet">
<style>
:root{--bg:#07090e;--s:#0c0f18;--b:#1a2035;--a:#e2ff47;--a2:#47f4c8;--a3:#f447a8;--m:#3d4d6a;--m2:#5a6e90;--t:#b8c8e0;--w:#e8eef8}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--t);font-family:'Syne',sans-serif;min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(71,244,200,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(71,244,200,.02) 1px,transparent 1px);background-size:52px 52px}
.glow{position:fixed;top:-300px;left:50%;transform:translateX(-50%);width:1000px;height:500px;pointer-events:none;background:radial-gradient(ellipse at 50% 0%,rgba(71,244,200,.05) 0%,transparent 65%)}
main{position:relative;z-index:1;max-width:880px;margin:0 auto;padding:64px 24px 100px}
header{margin-bottom:72px}
.eye{font-family:'Space Mono',monospace;font-size:.65rem;letter-spacing:.22em;color:var(--a2);text-transform:uppercase;display:flex;align-items:center;gap:14px;margin-bottom:24px}
.eye::before{content:'';width:36px;height:1px;background:var(--a2)}
h1{font-size:clamp(2.6rem,7vw,4.4rem);line-height:.95;letter-spacing:-.04em;color:var(--w);font-weight:800}
h1 .d{color:var(--m)} h1 .h{color:var(--a)} h1 .h2{color:var(--a2)}
.tag{font-family:'Space Mono',monospace;font-size:.78rem;line-height:1.8;color:var(--m2);max-width:460px;margin-top:16px}
.badges{display:flex;flex-wrap:wrap;gap:8px;margin:32px 0 64px}
.badge{font-family:'Space Mono',monospace;font-size:.62rem;padding:4px 12px;border-radius:3px;border:1px solid #232b42;color:var(--m2);display:flex;align-items:center;gap:7px}
.badge.live{border-color:rgba(71,244,200,.35);color:var(--a2)}
.badge.live::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--a2);box-shadow:0 0 8px var(--a2);animation:blink 2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.sl{font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.25em;color:var(--m);text-transform:uppercase;padding-bottom:12px;margin-bottom:20px;border-bottom:1px solid var(--b)}
.eps{display:flex;flex-direction:column;gap:1px;margin-bottom:64px}
.ep{background:var(--s);border:1px solid var(--b);padding:22px 26px;transition:background .2s,border-color .2s;position:relative}
.ep::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:transparent;transition:background .2s}
.ep:hover{background:#111520;border-color:#232b42} .ep:hover::before{background:var(--a2)}
.eh{display:flex;align-items:baseline;gap:12px;margin-bottom:10px;flex-wrap:wrap}
.mt{font-family:'Space Mono',monospace;font-size:.6rem;font-weight:700;padding:3px 9px;background:rgba(226,255,71,.08);color:var(--a);border-radius:3px}
.eu{font-family:'Space Mono',monospace;font-size:.8rem;color:var(--w);word-break:break-all}
.eu .p{color:var(--a2)} .eu .o{color:var(--m2)}
.ed{font-size:.8rem;color:var(--m2);line-height:1.65;margin-bottom:12px}
.ps{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.pt{font-family:'Space Mono',monospace;font-size:.6rem;padding:2px 9px;border:1px solid var(--b);border-radius:3px;color:var(--m2)}
.pt b{color:var(--t)} .pt.r{border-color:rgba(226,255,71,.2);color:rgba(226,255,71,.7)}
.try{font-family:'Space Mono',monospace;font-size:.6rem;color:var(--a2);text-decoration:none;display:inline-flex;align-items:center;gap:5px;opacity:.65;transition:opacity .2s}
.try:hover{opacity:1} .try::after{content:'->'}
pre{background:var(--s);border:1px solid var(--b);padding:28px;overflow-x:auto;border-radius:3px;font-family:'Space Mono',monospace;font-size:.72rem;line-height:1.9;color:var(--t);margin-bottom:64px}
.ck{color:var(--m2)} .cs{color:var(--a2)} .cn{color:var(--a)} .cb{color:#ff9f7f}
.creds{background:var(--s);border:1px solid var(--b);padding:28px 30px;margin-bottom:64px;border-radius:3px}
.ct{font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.22em;color:var(--a3);text-transform:uppercase;margin-bottom:18px;display:flex;align-items:center;gap:10px}
.ct::before{content:'';width:20px;height:1px;background:var(--a3)}
.cr{display:flex;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid var(--b)}
.cr:last-child{border-bottom:none}
.ca{width:34px;height:34px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-family:'Space Mono',monospace;font-size:.72rem;font-weight:700;background:#111520;border:1px solid #232b42}
.ca.m{color:var(--a3);border-color:rgba(244,71,168,.3)}
.ca.j{color:var(--a2);border-color:rgba(71,244,200,.3)}
.ca.s{color:#ffb347;border-color:rgba(255,179,71,.3)}
.cn2{font-size:.9rem;font-weight:700;color:var(--w)}
.cr2{font-family:'Space Mono',monospace;font-size:.62rem;color:var(--m2)}
.ch{margin-left:auto;font-size:1rem}
footer{border-top:1px solid var(--b);padding-top:28px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px}
footer span{font-family:'Space Mono',monospace;font-size:.6rem;color:var(--m)}
</style>
</head>
<body>
<div class="glow"></div>
<main>
<header>
<div class="eye">OpenSubtitles Proxy Infrastructure</div>
<h1><span class="d">VOID</span><span class="h">.</span><br>CINEMA<br><span class="h2">API</span></h1>
<p class="tag">Session-aware subtitle proxy. Multi-platform, cached, anti-block with retry backoff.</p>
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
<div class="sl">Endpoints</div>
<div class="eps">
<div class="ep"><div class="eh"><span class="mt">GET</span><span class="eu">/subtitle?action=search&amp;<span class="p">q</span>={query}<span class="o">&amp;lang={lang}&amp;page={n}</span></span></div><p class="ed">Search subtitles by movie or TV show name. Sorted by downloads.</p><div class="ps"><span class="pt r"><b>q</b> required</span><span class="pt"><b>lang</b> en/ml/fr...</span><span class="pt"><b>page</b> 1-100</span></div><a class="try" href="/subtitle?action=search&q=inception&lang=en">Try it</a></div>
<div class="ep"><div class="eh"><span class="mt">GET</span><span class="eu">/subtitle?action=download&amp;<span class="p">id</span>={id}</span></div><p class="ed">Download subtitle file by numeric ID from search results.</p><div class="ps"><span class="pt r"><b>id</b> required</span><span class="pt"><b>filename</b> optional</span></div><a class="try" href="/subtitle?action=download&id=3962439">Try it</a></div>
<div class="ep"><div class="eh"><span class="mt">GET</span><span class="eu">/languages?<span class="p">q</span>={query}</span></div><p class="ed">Get all available language codes for a search query.</p><a class="try" href="/languages?q=inception">Try it</a></div>
<div class="ep"><div class="eh"><span class="mt">GET</span><span class="eu">/stats</span></div><p class="ed">Uptime, memory, cache stats, session state.</p><a class="try" href="/stats">Try it</a></div>
<div class="ep"><div class="eh"><span class="mt">GET</span><span class="eu">/health</span></div><p class="ed">Health check for deployment platforms.</p><a class="try" href="/health">Try it</a></div>
</div>
<div class="sl">Example Response</div>
<pre><span class="ck">{</span>
  <span class="cs">"success"</span><span class="ck">:</span> <span class="cn">true</span><span class="ck">,</span>
  <span class="cs">"data"</span><span class="ck">: {</span>
    <span class="cs">"query"</span><span class="ck">:</span>     <span class="cb">"inception"</span><span class="ck">,</span>
    <span class="cs">"total"</span><span class="ck">:</span>     <span class="cn">40</span><span class="ck">,</span>
    <span class="cs">"fromCache"</span><span class="ck">:</span> <span class="cn">false</span><span class="ck">,</span>
    <span class="cs">"results"</span><span class="ck">: [{</span>
      <span class="cs">"id"</span><span class="ck">:</span>        <span class="cb">"3962439"</span><span class="ck">,</span>
      <span class="cs">"title"</span><span class="ck">:</span>     <span class="cb">"Inception"</span><span class="ck">,</span>
      <span class="cs">"language"</span><span class="ck">:</span>  <span class="cb">"en"</span><span class="ck">,</span>
      <span class="cs">"downloads"</span><span class="ck">:</span> <span class="cn">132434</span><span class="ck">,</span>
      <span class="cs">"features"</span><span class="ck">: {</span> <span class="cs">"hd"</span><span class="ck">:</span> <span class="cn">true</span> <span class="ck">}</span>
    <span class="ck">}]</span>
  <span class="ck">}</span>
<span class="ck">}</span></pre>
<div class="sl">Built by</div>
<div class="creds">
<div class="ct">Credits</div>
<div class="cr"><div class="ca m">M</div><div><div class="cn2">Munax</div><div class="cr2">Creator - Architect - Vision</div></div><span class="ch">&#129144;</span></div>
<div class="cr"><div class="ca j">J</div><div><div class="cn2">Jerry</div><div class="cr2">Co-developer - Bug Fixer - Collaborator</div></div><span class="ch">&#129309;</span></div>
<div class="cr"><div class="ca s">S</div><div><div class="cn2">Sahid Ikka</div><div class="cr2">Codebase Co-developer - Silent Force</div></div><span class="ch">&#129307;&#127995;</span></div>
</div>
<footer><span>VOID CINEMA API - Ultra Peak v4.0</span><span>Node.js - Express - Cheerio - Munax + Jerry</span></footer>
</main>
</body>
</html>`;

// ROUTES
app.get(’/’, function(_req, res) {
res.setHeader(‘Content-Type’, ‘text/html; charset=utf-8’);
res.send(ROOT);
});

app.get(’/languages’, limiter, function(req, res) {
const qErr = validateQuery(req.query.q);
if (qErr) return res.status(400).json({ success: false, error: qErr });
searchSubtitles(req.query.q.trim())
.then(function(data) {
const seen = {}, langs = [];
data.results.forEach(function(r) { if (!seen[r.language]) { seen[r.language]=true; langs.push(r.language); } });
langs.sort();
res.json({ success: true, query: req.query.q.trim(), fromCache: data.fromCache, count: langs.length, languages: langs });
})
.catch(function(e) { res.status(500).json({ success: false, error: e.type||‘internal’, message: e.message }); });
});

app.get(’/stats’, function(_req, res) {
const ss = searchCache.getStats(), ds = dlCache.getStats(), mem = process.memoryUsage();
res.json({
success: true, uptime: Math.floor(process.uptime()), uptimeFormatted: fmtUptime(process.uptime()),
platform: PLATFORM, sessionReady, cookieCount: cookieJar.size,
memory: { rss: fmtBytes(mem.rss), heapUsed: fmtBytes(mem.heapUsed), heapTotal: fmtBytes(mem.heapTotal) },
cache: { search: { keys: searchCache.keys().length, hits: ss.hits, misses: ss.misses }, download: { keys: dlCache.keys().length, hits: ds.hits, misses: ds.misses } },
config: { searchTTL: CFG.CACHE_SEARCH_TTL, dlTTL: CFG.CACHE_DL_TTL, rateMax: CFG.RATE_MAX, retries: CFG.SEARCH_RETRIES, proxyActive: !!PROXY, selfPing: NEEDS_PING },
credits: { creator: ‘Munax’, collaborator: ‘Jerry’, codeDev: ‘Sahid Ikka’ },
timestamp: new Date().toISOString(),
});
});

app.get(’/subtitle’, limiter, function(req, res) {
const { action } = req.query;

if (action === ‘search’) {
const qErr = validateQuery(req.query.q);
if (qErr) return res.status(400).json({ success: false, error: qErr });
const page = validatePage(req.query.page);
if (req.query.page !== undefined && page === null) return res.status(400).json({ success: false, error: ‘Page must be 1-100.’ });
searchSubtitles(req.query.q.trim(), page || 1)
.then(function(raw) {
const result = req.query.lang ? filterByLanguage(raw, req.query.lang.trim()) : raw;
res.json({ success: true, data: result });
})
.catch(function(e) { res.status(500).json({ success: false, error: e.type||‘internal’, message: e.message, debug: e.debug }); });
return;
}

if (action === ‘download’) {
const { id, filename } = req.query;
if (!validateId(id)) return res.status(400).json({ success: false, error: ‘Invalid id - must be numeric.’ });
downloadSubtitle(id.trim(), filename||null)
.then(function(file) {
const mime = file.ext === ‘srt’ ? ‘application/x-subrip’ : ‘application/octet-stream’;
res.setHeader(‘Content-Disposition’, ‘attachment; filename=”’ + file.filename + ‘”’);
res.setHeader(‘Content-Type’, mime);
res.setHeader(‘Content-Length’, file.size);
res.send(file.buffer);
})
.catch(function(e) { res.status(500).json({ success: false, error: e.type||‘internal’, message: e.message }); });
return;
}

res.status(400).json({ success: false, error: ‘Use action=search or action=download.’ });
});

app.get(’/health’, function(_req, res) {
res.status(200).json({ status: ‘healthy’, uptime: Math.floor(process.uptime()), platform: PLATFORM, sessionReady, timestamp: new Date().toISOString() });
});

app.get(’/favicon.ico’, function(_req, res) { res.status(204).end(); });

app.use(function(_req, res) { res.status(404).json({ success: false, error: ‘Not found.’ }); });
app.use(function(err, _req, res, _next) { console.error(err); res.status(500).json({ success: false, error: ‘server_error’ }); });

module.exports = app;

if (require.main === module) {
app.listen(PORT, function() {
console.log(’================================================’);
console.log(’  VOID CINEMA - OpenSubtitles Proxy API’);
console.log(’  Ultra Peak Edition v4.0 - Munax + Jerry’);
console.log(’  Platform : ’ + PLATFORM);
console.log(’  Port     : ’ + PORT);
console.log(’================================================’);
warmUpSession();
});
}
