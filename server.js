// ============================================================
// server.js – ULTRA PEAK SUBTITLE API (KOYEB/RENDER/CLOUD)
//            – Now with Vercel reverse proxy support
// ============================================================
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const { HttpsProxyAgent } = require("https-proxy-agent");
const cors = require("cors");
const zlib = require('zlib');
const NodeCache = require("node-cache");

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------
// Platform detection – works everywhere
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// Environment variables
// ------------------------------------------------------------
const PROXY_URL = process.env.PROXY_URL; // Your Vercel app URL, e.g. https://termux-proxy.vercel.app

// ------------------------------------------------------------
// Caches
// ------------------------------------------------------------
const searchCache = new NodeCache({ stdTTL: 600 });      // 10 min
const downloadCache = new NodeCache({ stdTTL: 1800 });   // 30 min

// ------------------------------------------------------------
// Free proxy pool (for fallback when PROXY_URL isn't set or fails)
// ------------------------------------------------------------
let proxyList = [];
let workingProxies = [];
let sessionCookie = "";
let cookieJar = new Map();

// ------------------------------------------------------------
// Fetch free proxies from multiple sources (fallback)
// ------------------------------------------------------------
async function refreshProxies() {
  if (PROXY_URL) return; // if we have a PROXY_URL, we don't need free proxies
  try {
    console.log("🔄 Fetching free proxies...");
    const sources = [
      "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt",
      "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
      "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt"
    ];
    const results = await Promise.allSettled(sources.map(s => 
      axios.get(s, { timeout: 8000 })
    ));
    
    proxyList = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value.data.split("\n"))
      .map(p => p.trim())
      .filter(p => p && p.includes(':') && !p.startsWith('#'))
      .map(p => p.replace(/\r$/, ''))
      .slice(0, 200);
    
    proxyList = [...new Set(proxyList)];
    console.log(`✅ ${proxyList.length} free proxies loaded`);
  } catch (e) {
    console.error("Proxy refresh failed, using fallback list");
    proxyList = ["8.210.83.33:80", "47.91.105.28:3128", "185.162.231.190:3128"];
  }
}

// ------------------------------------------------------------
// Test a proxy (used for fallback)
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// Validate working proxies (fallback)
// ------------------------------------------------------------
async function validateWorkingProxies() {
  if (workingProxies.length === 0) return;
  console.log(`🔍 Validating ${workingProxies.length} working proxies...`);
  const valid = [];
  for (const proxy of workingProxies) {
    if (await testProxy(proxy)) valid.push(proxy);
    else console.log(`   ❌ ${proxy} died`);
  }
  workingProxies = valid;
  console.log(`✅ ${workingProxies.length} working proxies remain`);
}

// ------------------------------------------------------------
// Cookie handling
// ------------------------------------------------------------
function extractCookies(res) {
  const setCookie = res?.headers?.["set-cookie"];
  if (!Array.isArray(setCookie)) return;
  setCookie.forEach(raw => {
    const [pair] = raw.split(';');
    const [key, val] = pair.split('=');
    if (key && val) cookieJar.set(key.trim(), val.trim());
  });
  const cookies = [];
  cookieJar.forEach((val, key) => cookies.push(`${key}=${val}`));
  sessionCookie = cookies.join("; ");
}

// ------------------------------------------------------------
// Default headers – mimic a real browser
// ------------------------------------------------------------
const defaultHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Referer": "https://www.opensubtitles.org/"
};

// ------------------------------------------------------------
// Session warm-up (get fresh cookies)
// ------------------------------------------------------------
async function warmUpSession() {
  console.log("🌡️  Warming up session...");
  try {
    // If we have a PROXY_URL, we should warm up through it?
    // But warm-up should ideally hit the target directly. Let's try direct first.
    const res = await axios.get("https://www.opensubtitles.org/en", {
      timeout: 10000,
      headers: defaultHeaders,
      maxRedirects: 2
    });
    extractCookies(res);
    console.log(`✅ Session ready, cookies: ${cookieJar.size}`);
    return true;
  } catch (e) {
    console.error("❌ Session warm-up failed:", e.message);
    return false;
  }
}

// ------------------------------------------------------------
// The heart – fastFetch with support for Vercel reverse proxy
// ------------------------------------------------------------
async function fastFetch(url, responseType = "text") {
  // ------------------------------------------------------------------
  // If PROXY_URL is set, we treat it as a reverse proxy prefix.
  // We simply prepend it to the target URL.
  // ------------------------------------------------------------------
  if (PROXY_URL) {
    const proxyTarget = `${PROXY_URL}/${url}`;
    try {
      const res = await axios.get(proxyTarget, {
        timeout: 15000,
        responseType,
        headers: { ...defaultHeaders, Cookie: sessionCookie }
      });
      extractCookies(res);
      console.log("🔌 Vercel reverse proxy OK");
      return res;
    } catch (e) {
      console.log("➖ Vercel proxy failed, falling back to free proxy pool...");
      // fall through to other methods
    }
  }

  // ------------------------------------------------------------------
  // Original fallback: direct connection + free proxy pool
  // ------------------------------------------------------------------
  // 1) Try direct connection (only if no PROXY_URL is set)
  if (!PROXY_URL) {
    try {
      const res = await axios.get(url, {
        timeout: 8000,
        responseType,
        headers: { ...defaultHeaders, Cookie: sessionCookie }
      });
      if (res.status === 200) {
        extractCookies(res);
        console.log("⚡ Direct OK");
        return res;
      }
    } catch (e) {
      console.log("➖ Direct failed");
    }
  }

  // 2) Try previously working proxies (fallback pool)
  if (workingProxies.length > 0) {
    for (const proxy of workingProxies) {
      try {
        const agent = new HttpsProxyAgent(`http://${proxy}`);
        const res = await axios.get(url, {
          httpsAgent: agent,
          timeout: 5000,
          responseType,
          headers: { ...defaultHeaders, Cookie: sessionCookie }
        });
        if (res.status === 200) {
          extractCookies(res);
          console.log(`✅ Working proxy: ${proxy}`);
          return res;
        }
      } catch (e) {
        workingProxies = workingProxies.filter(p => p !== proxy);
      }
    }
  }

  // 3) Try 3 random proxies from the pool
  const candidates = [...proxyList].sort(() => 0.5 - Math.random()).slice(0, 3);
  for (const proxy of candidates) {
    try {
      const agent = new HttpsProxyAgent(`http://${proxy}`);
      const res = await axios.get(url, {
        httpsAgent: agent,
        timeout: 6000,
        responseType,
        headers: { ...defaultHeaders, Cookie: sessionCookie }
      });
      if (res.status === 200) {
        extractCookies(res);
        workingProxies.unshift(proxy);
        workingProxies = workingProxies.slice(0, 15);
        console.log(`✅ New working proxy: ${proxy}`);
        return res;
      }
    } catch (e) {
      proxyList = proxyList.filter(p => p !== proxy);
    }
  }

  throw new Error("All connection methods exhausted");
}

// ------------------------------------------------------------
// Movie detection – improved to catch many TV patterns
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// Language sorter – Malayalam first, then English, then others
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// Search endpoint
// ------------------------------------------------------------
app.get("/search", async (req, res) => {
  const { q, lang, type } = req.query;
  if (!q) return res.status(400).json({ success: false, error: "Missing q" });

  const cacheKey = `search:${q}:${lang || 'all'}:${type || 'all'}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  console.log(`🔍 Searching: ${q}`);
  try {
    let searchQuery = q;
    if (type === 'movie' && !q.match(/19|20\d{2}/)) {
      if (q.toLowerCase().includes('avatar') && !q.includes('2022')) {
        searchQuery = 'Avatar 2009';
      }
    }

    const url = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${encodeURIComponent(searchQuery)}/simplexml`;
    const resp = await fastFetch(url, "text");
    const $ = cheerio.load(resp.data, { xmlMode: true });

    let results = [];
    $("subtitle").each((i, el) => {
      const rawTitle = $(el).find("moviename").text() || $(el).find("releasename").text();
      const title = rawTitle.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
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

    if (type === 'movie') results = results.filter(r => r.isMovie);
    if (lang && lang !== 'all') results = results.filter(r => r.lang.toLowerCase() === lang.toLowerCase());

    if (!lang || lang === 'all') results = sortByLanguagePriority(results);
    else results.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));

    // Avatar fallback
    if (results.length === 0 && q.toLowerCase().includes('avatar')) {
      console.log("Trying specific Avatar movies...");
      for (const mq of ['Avatar 2009', 'Avatar The Way of Water 2022']) {
        try {
          const movieUrl = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${encodeURIComponent(mq)}/simplexml`;
          const movieResp = await fastFetch(movieUrl, "text");
          const $m = cheerio.load(movieResp.data, { xmlMode: true });
          $m("subtitle").each((i, el) => {
            const rawTitle = $m(el).find("moviename").text() || $m(el).find("releasename").text();
            const title = rawTitle.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
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
      if (!lang || lang === 'all') results = sortByLanguagePriority(results);
    }

    const response = { success: true, count: results.length, query: q, results: results.slice(0, 30) };
    searchCache.set(cacheKey, response);
    res.json(response);

  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ success: false, error: "Search failed. Try again." });
  }
});

// ------------------------------------------------------------
// Download endpoint
// ------------------------------------------------------------
app.get("/download", async (req, res) => {
  const { id, title } = req.query;
  if (!id) return res.status(400).json({ success: false, error: "Missing id" });

  const cacheKey = `dl:${id}`;
  const cached = downloadCache.get(cacheKey);
  if (cached) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${cached.filename}"`);
    return res.send(cached.buffer);
  }

  console.log(`⬇️ Downloading: ${id}`);
  const url = `https://dl.opensubtitles.org/en/download/sub/${id}`;
  try {
    const resp = await fastFetch(url, "arraybuffer");
    let buffer = Buffer.from(resp.data);
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = zlib.gunzipSync(buffer);
    if (buffer.slice(0, 100).toString().includes("<!DOCTYPE")) throw new Error("Got HTML instead of subtitle");

    const filename = title ? `${title.replace(/[^a-z0-9]/gi, '_')}.srt` : `subtitle_${id}.srt`;

    downloadCache.set(cacheKey, { buffer, filename });

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error("Download error:", err);
    res.status(500).json({ success: false, error: "Download failed" });
  }
});

// ------------------------------------------------------------
// Languages endpoint
// ------------------------------------------------------------
app.get("/languages", async (req, res) => {
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
    res.json({ success: true, query: q, languages: Array.from(langs).sort() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ------------------------------------------------------------
// Stats endpoint
// ------------------------------------------------------------
app.get("/stats", (req, res) => {
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  const uptimeStr = `${hours.toString().padStart(2,'0')}:${minutes.toString().padStart(2,'0')}:${seconds.toString().padStart(2,'0')}`;

  res.json({
    success: true,
    platform: PLATFORM,
    uptime,
    uptimeFormatted: uptimeStr,
    sessionReady: cookieJar.size > 0,
    cookieCount: cookieJar.size,
    proxies: PROXY_URL ? "custom (Vercel)" : { total: proxyList.length, working: workingProxies.length },
    memory: {
      rss: `${(mem.rss / 1024 / 1024).toFixed(2)} MB`,
      heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB`
    },
    cache: {
      search: { keys: searchCache.getStats().keys, hits: searchCache.getStats().hits, misses: searchCache.getStats().misses },
      download: { keys: downloadCache.getStats().keys, hits: downloadCache.getStats().hits, misses: downloadCache.getStats().misses }
    }
  });
});

// ------------------------------------------------------------
// Health endpoint
// ------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "healthy", platform: PLATFORM, uptime: process.uptime() });
});

// ------------------------------------------------------------
// Root – simple dashboard
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>🎬 Subtitle API – Live</title>
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
    <div class="endpoint"><code>GET /download?id=4290587</code> – download subtitle</div>
    <div class="endpoint"><code>GET /languages?q=Inception</code> – available languages</div>
    <div class="endpoint"><code>GET /stats</code> – server stats</div>
    <div class="endpoint"><code>GET /health</code> – health check</div>
  </div>
  <footer>Made with ❤️ – v7.0 (Vercel Proxy Ready)</footer>
  <script>
    async function loadStats() {
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
    loadStats();
    setInterval(loadStats, 10000);
  </script>
</body>
</html>
  `);
});

// ------------------------------------------------------------
// Startup & background jobs
// ------------------------------------------------------------
async function startup() {
  console.log("╔════════════════════════════════════╗");
  console.log("║   ULTRA PEAK SUBTITLE API v8.0    ║");
  console.log("║      Malayalam First Edition       ║");
  console.log("╚════════════════════════════════════╝");
  await refreshProxies();
  await warmUpSession();

  setInterval(async () => {
    console.log("🔄 Periodic session refresh...");
    await warmUpSession();
  }, 2 * 60 * 60 * 1000);

  setInterval(validateWorkingProxies, 10 * 60 * 1000);
  setInterval(refreshProxies, 30 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`🌐 Server listening on ${BASE_URL}`);
    console.log(`🔍 Test search: ${BASE_URL}/search?q=Inception`);
    console.log(`📊 Dashboard: ${BASE_URL}/`);
  });
}

startup().catch(err => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
