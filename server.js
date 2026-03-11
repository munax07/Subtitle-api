const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const { HttpsProxyAgent } = require("https-proxy-agent");
const cors = require("cors");
const zlib = require('zlib');
const NodeCache = require("node-cache");
const rateLimit = require("express-rate-limit");
const compression = require("compression");

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== PLATFORM DETECTION ====================
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

app.set("trust proxy", PLATFORM === "vercel" ? false : 1);

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(compression({ threshold: 512 })); // Compress responses
app.use(express.json({ limit: "1mb" }));

// Rate limiting – prevents abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Rate limit exceeded. Try again later." }
});
app.use(limiter);

// ==================== PROXY SETUP ====================
let proxyAgent = null;
if (process.env.PROXY_URL) {
  try {
    proxyAgent = new HttpsProxyAgent(process.env.PROXY_URL);
    console.log("✅ Custom proxy configured");
  } catch (e) {
    console.warn("❌ Invalid PROXY_URL, continuing without proxy");
  }
}

// ==================== CACHES ====================
const searchCache = new NodeCache({ stdTTL: 600 });  // 10 minutes
const downloadCache = new NodeCache({ stdTTL: 1800 }); // 30 minutes

// ==================== PROXY POOL ====================
let proxyList = [];
let workingProxies = [];
let sessionCookie = "";
let cookieJar = new Map();

// ---------- 1. PROXY FETCH (only if no env proxy) ----------
async function refreshProxies() {
    if (proxyAgent) return; // skip if custom proxy is set
    try {
        console.log("🔄 Fetching proxies...");
        const sources = [
            "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt",
            "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt"
        ];
        const results = await Promise.allSettled(sources.map(s => 
            axios.get(s, { timeout: 5000 })
        ));
        
        proxyList = results
            .filter(r => r.status === 'fulfilled')
            .flatMap(r => r.value.data.split("\n"))
            .map(p => p.trim())
            .filter(p => p && p.includes(':') && !p.startsWith('#'))
            .map(p => p.replace(/\r$/, ''))
            .slice(0, 150);
        
        proxyList = [...new Set(proxyList)];
        console.log(`✅ ${proxyList.length} proxies ready`);
    } catch (e) { 
        proxyList = ["8.210.83.33:80", "47.91.105.28:3128", "185.162.231.190:3128"];
    }
}

// ---------- 2. AGENT SELECTOR ----------
function getAgent(proxy) {
    if (proxyAgent) return proxyAgent; // use env proxy if set
    try {
        return new HttpsProxyAgent(`http://${proxy}`);
    } catch {
        return null;
    }
}

// ---------- 3. COOKIE HANDLING ----------
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

// ---------- 4. ROTATING USER AGENTS ----------
const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/121.0"
];

function getRandomHeaders() {
    return {
        "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1"
    };
}

// ---------- 5. JITTER DELAY (human-like) ----------
const delay = (min = 300, max = 800) => 
    new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

// ---------- 6. FAST FETCH (with fallbacks) ----------
async function fastFetch(url, responseType = "text") {
    // Try direct first (only if no proxyAgent is set)
    if (!proxyAgent) {
        try {
            await delay(200, 600); // Polite delay
            const res = await axios.get(url, {
                timeout: 5000,
                responseType,
                headers: { ...getRandomHeaders(), Cookie: sessionCookie, Referer: "https://www.opensubtitles.org/" }
            });
            if (res.status === 200) {
                extractCookies(res);
                return res;
            }
        } catch (e) {}
    }

    // If env proxy is set, use it and skip the pool
    if (proxyAgent) {
        await delay(300, 700);
        const res = await axios.get(url, {
            httpsAgent: proxyAgent,
            timeout: 10000,
            responseType,
            headers: { ...getRandomHeaders(), Cookie: sessionCookie, Referer: "https://www.opensubtitles.org/" }
        });
        extractCookies(res);
        return res;
    }

    // Try working proxies
    if (workingProxies.length > 0) {
        for (const proxy of workingProxies) {
            try {
                await delay(400, 900);
                const agent = getAgent(proxy);
                const res = await axios.get(url, {
                    httpsAgent: agent,
                    timeout: 4000,
                    responseType,
                    headers: { ...getRandomHeaders(), Cookie: sessionCookie, Referer: "https://www.opensubtitles.org/" }
                });
                if (res.status === 200) {
                    extractCookies(res);
                    return res;
                }
            } catch (e) {
                workingProxies = workingProxies.filter(p => p !== proxy);
            }
        }
    }

    // Try 2 random proxies
    const candidates = [...proxyList].sort(() => 0.5 - Math.random()).slice(0, 2);
    for (const proxy of candidates) {
        try {
            await delay(500, 1000);
            const agent = getAgent(proxy);
            const res = await axios.get(url, {
                httpsAgent: agent,
                timeout: 4000,
                responseType,
                headers: { ...getRandomHeaders(), Cookie: sessionCookie, Referer: "https://www.opensubtitles.org/" }
            });
            if (res.status === 200) {
                extractCookies(res);
                workingProxies.unshift(proxy);
                workingProxies = workingProxies.slice(0, 10);
                return res;
            }
        } catch (e) {
            proxyList = proxyList.filter(p => p !== proxy);
        }
    }
    
    throw new Error("All connection methods failed");
}

// ---------- 7. MOVIE/TV DETECTION ----------
function isMovieSubtitle(title) {
    if (!title) return false;
    
    // Normalize: replace newlines with spaces, trim multiple spaces
    const normalized = title.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    
    // TV show patterns (flexible)
    const tvPatterns = [
        /S\d{2}[.\s-]*E\d{2}/i,           // S02E08, S02.E08, S02-E08, S02 E08
        /S\d{2}[.\s-]*Episode[.\s-]*\d+/i, // S02 Episode 08, S02.Episode-08
        /Episode[.\s-]*\d+/i,               // Episode 08, Episode-08
        /Season[.\s-]*\d+/i,                 // Season 2, Season-2
        /The Last Airbender/i,
        /Legend of Korra/i,
        /\d+x\d+/i,                          // 2x08
        /Complete Series/i,
        /T?p \d+/i,                          // Vietnamese episode
        /Ep\.\s*\d+/i,                        // Ep. 46
        /Ph?n \d+/i,                          // Part/Chapter
        /The\.Guru/i,
        /Crossroads\.of\.Destiny/i,
        /Serpents\.Pass/i,
        /The\.Drill/i,
        /Day\.of\.Black\.Sun/i,
        /Boiling\.Rock/i,
        /Sozins\.Comet/i
    ];
    
    // Check for TV patterns
    for (const pattern of tvPatterns) {
        if (pattern.test(normalized)) return false;
    }
    
    // If it has a year in parentheses (2009 or 2022 etc.) - definitely a movie
    if (normalized.match(/\((19|20)\d{2}\)/)) return true;
    
    // Check for movie indicators
    const movieIndicators = [
        /The Way of Water/i,
        /1080p|720p|4K/i,
        /BluRay|WEBRip|BRRip|DVDRip/i,
        /Extended Cut/i,
        /Collector's Edition/i
    ];
    
    for (const pattern of movieIndicators) {
        if (pattern.test(normalized)) return true;
    }
    
    // Default: if it contains "Avatar" but not "Airbender", keep it
    if (normalized.includes("Avatar") && !normalized.includes("Airbender")) {
        return true;
    }
    
    return false;
}

// ---------- 8. LANGUAGE PRIORITY ----------
function prioritizeEnglish(results) {
    return results.sort((a, b) => {
        if (a.lang === 'en' && b.lang !== 'en') return -1;
        if (a.lang !== 'en' && b.lang === 'en') return 1;
        return (b.downloads || 0) - (a.downloads || 0);
    });
}

// ==================== ENDPOINTS ====================

// ---------- 9. SEARCH ----------
app.get("/search", async (req, res) => {
    const { q, lang, type } = req.query;
    if (!q) return res.status(400).json({ success: false, error: "Missing q" });

    const cacheKey = `search:${q}:${lang || 'all'}:${type || 'all'}`;
    const cached = searchCache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    console.log(`🔍 Searching: ${q}`);
    
    try {
        // Smart query adjustment for Avatar movies
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
            // Clean title: replace newlines with spaces, collapse multiple spaces
            const title = rawTitle.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
            const yearMatch = title.match(/\((\d{4})\)/);
            const year = yearMatch ? yearMatch[1] : null;
            
            results.push({
                id: $(el).find("idsubtitle").text(),
                title: title.replace(/\s*\(\d{4}\)$/, "").trim(),
                year,
                lang: $(el).find("iso639").text(),
                downloads: parseInt($(el).find("subdownloads").text()) || 0,
                filename: $(el).find("subfilename").text(),
                isMovie: isMovieSubtitle(title)
            });
        });

        // Apply filters
        if (type === 'movie') {
            results = results.filter(r => r.isMovie);
        }
        
        if (lang && lang !== 'all') {
            results = results.filter(r => r.lang.toLowerCase() === lang.toLowerCase());
        }
        
        // Sort
        if (!lang || lang === 'all') {
            results = prioritizeEnglish(results);
        } else {
            results.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
        }

        // Fallback for Avatar: try both movies if no results
        if (results.length === 0 && q.toLowerCase().includes('avatar')) {
            console.log("No results, trying specific Avatar movies...");
            const movieQueries = ['Avatar 2009', 'Avatar The Way of Water 2022'];
            for (const mq of movieQueries) {
                const movieUrl = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${encodeURIComponent(mq)}/simplexml`;
                try {
                    const movieResp = await fastFetch(movieUrl, "text");
                    const $movie = cheerio.load(movieResp.data, { xmlMode: true });
                    $movie("subtitle").each((i, el) => {
                        const rawTitle = $movie(el).find("moviename").text() || $movie(el).find("releasename").text();
                        const title = rawTitle.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
                        results.push({
                            id: $movie(el).find("idsubtitle").text(),
                            title: title.replace(/\s*\(\d{4}\)$/, "").trim(),
                            year: title.match(/\((\d{4})\)/)?.[1] || null,
                            lang: $movie(el).find("iso639").text(),
                            downloads: parseInt($movie(el).find("subdownloads").text()) || 0,
                            isMovie: true
                        });
                    });
                } catch (e) {}
            }
            // Deduplicate
            const uniqueIds = new Set();
            results = results.filter(r => {
                if (uniqueIds.has(r.id)) return false;
                uniqueIds.add(r.id);
                return true;
            });
            results = prioritizeEnglish(results);
        }

        const response = { 
            success: true, 
            count: results.length, 
            query: q,
            results: results.slice(0, 30)
        };
        
        searchCache.set(cacheKey, response);
        res.json(response);
        
    } catch (err) {
        console.error("Search error:", err.message);
        res.status(500).json({ success: false, error: "Search failed. Try again." });
    }
});

// ---------- 10. DOWNLOAD ----------
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
        
        if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
            buffer = zlib.gunzipSync(buffer);
        }
        
        const preview = buffer.slice(0, 200).toString();
        if (preview.includes("<!DOCTYPE") || preview.includes("<html") || preview.includes("subtitle not found")) {
            throw new Error("Got HTML or error page instead of subtitle");
        }
        
        const cleanTitle = title ? title.replace(/[^a-z0-9]/gi, '_') : `subtitle_${id}`;
        const filename = `${cleanTitle}.srt`;
        
        downloadCache.set(cacheKey, { buffer, filename });
        
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(buffer);
        
    } catch (err) {
        console.error("Download error:", err);
        res.status(500).json({ success: false, error: "Download failed" });
    }
});

// ---------- 11. MOVIE SHORTCUT ----------
app.get("/movie/:name", async (req, res) => {
    const { name } = req.params;
    const year = req.query.year || '';
    const lang = req.query.lang || 'en';
    let query = name;
    if (year) query += ` ${year}`;
    res.redirect(`/search?q=${encodeURIComponent(query)}&type=movie&lang=${lang}`);
});

// ---------- 12. STATUS ----------
app.get("/status", (req, res) => {
    res.json({
        status: "ONLINE",
        platform: PLATFORM,
        baseUrl: BASE_URL,
        proxies: proxyAgent ? "custom" : { total: proxyList.length, working: workingProxies.length },
        session: sessionCookie ? "active" : "none",
        cache: { 
            search: searchCache.getStats().keys, 
            download: downloadCache.getStats().keys 
        },
        uptime: process.uptime(),
        memory: (process.memoryUsage().rss / 1024 / 1024).toFixed(2) + ' MB'
    });
});

// ---------- 13. HEALTH CHECK (for Koyeb/Render) ----------
app.get("/health", (req, res) => {
    res.status(200).send("OK");
});

// ---------- 14. REFRESH PROXIES (manual) ----------
app.get("/refresh", async (req, res) => {
    await refreshProxies();
    res.json({ success: true, count: proxyList.length });
});

// ---------- 15. ROOT ----------
app.get("/", (req, res) => {
    res.send(`
        <html>
        <head><title>🎬 Subtitle API</title>
        <style>
            body { font-family: 'Segoe UI', Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 0 20px; background: #0a0c10; color: #e0e0e0; }
            h1 { color: #00e5ff; border-bottom: 2px solid #333; padding-bottom: 10px; }
            a { color: #ffb74d; text-decoration: none; }
            a:hover { text-decoration: underline; }
            code { background: #1e1e1e; padding: 2px 6px; border-radius: 4px; }
            .endpoint { background: #1a1a1a; padding: 15px; margin: 10px 0; border-radius: 8px; border-left: 4px solid #00e5ff; }
            .endpoint b { color: #00e5ff; }
            .badge { display: inline-block; background: #333; color: #fff; padding: 4px 12px; border-radius: 20px; font-size: 14px; margin-right: 8px; }
        </style>
        </head>
        <body>
            <h1>🎬 SUBTITLE API – ULTRA PEAK V6.0</h1>
            <p><span class="badge">🔥 Live</span> <span class="badge">⚡ Koyeb Ready</span> <span class="badge">🌍 ${PLATFORM}</span></p>
            <p>Your server is running at <strong>${BASE_URL}</strong></p>
            
            <h3>📡 Endpoints</h3>
            <div class="endpoint"><b>GET /search?q={query}&lang={lang}&type={movie|tv}</b> – Search subtitles (lang: en, ml, hi, ta, te, all...)</div>
            <div class="endpoint"><b>GET /download?id={id}&title={filename}</b> – Download subtitle by ID</div>
            <div class="endpoint"><b>GET /movie/{name}?year={year}&lang={lang}</b> – Shortcut for movie search</div>
            <div class="endpoint"><b>GET /status</b> – Server stats</div>
            <div class="endpoint"><b>GET /health</b> – Health check</div>
            
            <h3>🔍 Examples</h3>
            <ul>
                <li><a href="/search?q=Inception&lang=en">/search?q=Inception&lang=en</a></li>
                <li><a href="/search?q=Inception&lang=ml">/search?q=Inception&lang=ml</a> (Malayalam)</li>
                <li><a href="/movie/Avatar?year=2009">/movie/Avatar?year=2009</a></li>
                <li><a href="/status">/status</a></li>
            </ul>
            
            <p style="margin-top: 40px; color: #888;">Built by Munax, Jerry, Sahid Ikka – The Peak Team 🔥</p>
        </body>
        </html>
    `);
});

// ==================== BACKGROUND JOBS ====================
// Refresh proxy list every 15 minutes
if (!proxyAgent) {
    setInterval(refreshProxies, 15 * 60 * 1000);
}

// Self-ping to keep free tier awake (Koyeb/Render)
if (PLATFORM === "koyeb" || PLATFORM === "render") {
    setInterval(() => {
        axios.get(`${BASE_URL}/health`, { timeout: 5000 })
            .then(() => console.log("💓 Self-ping OK"))
            .catch(e => console.log("Self-ping failed:", e.message));
    }, 10 * 60 * 1000); // every 10 minutes
}

// ==================== START SERVER ====================
app.listen(PORT, async () => {
    console.log("╔════════════════════════════════════╗");
    console.log("║    🎬 SUBTITLE API – PEAK V6.0    ║");
    console.log("║      The One That Cannot Be Blocked ║");
    console.log("╚════════════════════════════════════╝");
    await refreshProxies();
    console.log(`\n🌐 Server URL: ${BASE_URL}`);
    console.log(`📱 Platform: ${PLATFORM}`);
    console.log(`🔍 Try: ${BASE_URL}/search?q=Inception&lang=en`);
    console.log(`📊 Status: ${BASE_URL}/status`);
    console.log(`\n✅ READY TO SERVE SUBTITLES! 🔥`);
});
