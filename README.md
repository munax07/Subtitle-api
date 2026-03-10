# 🎬 VOID CINEMA — OpenSubtitles Proxy API

### Ultra Peak Edition · v4.0 Final

> Built with 🩷 by **Munax** & **Jerry** 🤝

[![Status](https://img.shields.io/badge/status-PEAK-brightgreen?style=for-the-badge)](.)
[![Version](https://img.shields.io/badge/version-4.0.0-blue?style=for-the-badge)](.)
[![License](https://img.shields.io/badge/license-MIT-purple?style=for-the-badge)](.)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green?style=for-the-badge)](.)

-----

## ✨ Features

|Feature                  |Details                                                        |
|-------------------------|---------------------------------------------------------------|
|🔁 **Multi-platform**     |Render · Koyeb · Vercel · Railway · Fly.io · Docker · Local    |
|🍪 **Cookie jar**         |Persists Cloudflare/session cookies across all requests        |
|🔥 **Session warm-up**    |Visits homepage on boot to get real cookies before first search|
|🔄 **Dual URL strategy**  |Alternates between `/search/` and `/search2/` on retries       |
|⏱️ **Exponential backoff**|1.1s → 1.6s → 2.5s → 3.7s per retry                            |
|🌐 **Language forced**    |`lang=en` cookies prevent Dutch/wrong locale redirects         |
|📦 **Smart caching**      |5 min search · 10 min download · in-memory NodeCache           |
|🛡️ **Rate limiting**      |100 req / 15 min per IP (configurable)                         |
|💓 **Self-ping**          |Keeps free-tier hosts awake (every 9 min)                      |
|🧹 **Memory watchdog**    |Auto-flushes caches above 80% heap threshold                   |
|🔀 **Proxy support**      |Set `PROXY_URL` env var for residential proxy                  |
|🔒 **TLS optimized**      |Curated cipher list + keepAlive connection reuse               |

-----

## 🚀 Quick Deploy

### Render (Free Tier)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

1. Fork this repo
1. Create a new **Web Service** on Render
1. Connect your fork — build/start commands auto-detected from `render.yaml`
1. Done ✅

### Koyeb

```bash
# Via koyeb.yml — just connect your GitHub repo
# Service auto-configured from koyeb.yml
```

### Vercel

```bash
npm i -g vercel
vercel --prod
```

> Vercel uses `vercel.json` and exports `app` from `server.js` as a serverless function.  
> Note: Self-ping and background jobs are disabled on Vercel (serverless has no persistent process).

### Docker

```bash
docker build -t void-cinema-api .
docker run -p 3000:3000 -e NODE_ENV=production void-cinema-api
```

### Local

```bash
npm install
npm start
# Visit http://localhost:3000
```

-----

## 📡 API Reference

### Search Subtitles

```
GET /subtitle?action=search&q={query}&lang={lang}&page={n}
```

|Param |Required|Description                                 |
|------|--------|--------------------------------------------|
|`q`   |✅       |Movie or show name                          |
|`lang`|❌       |Language code: `en`, `ml`, `fr`, `de`, `es`…|
|`page`|❌       |Page number 1–100 (default: 1)              |

### Download Subtitle

```
GET /subtitle?action=download&id={id}&filename={name}
```

|Param     |Required|Description                            |
|----------|--------|---------------------------------------|
|`id`      |✅       |Numeric subtitle ID from search results|
|`filename`|❌       |Custom filename hint                   |

### Other Endpoints

```
GET /languages?q={query}   — All available languages for a query
GET /stats                 — Server stats, cache info, session state
GET /health                — Health check for deployment platforms
```

-----

## ⚙️ Environment Variables

|Variable          |Default      |Description                                             |
|------------------|-------------|--------------------------------------------------------|
|`PORT`            |`3000`       |Server port                                             |
|`NODE_ENV`        |`development`|Set to `production` on deployment                       |
|`CACHE_TTL_SEARCH`|`300`        |Search cache TTL in seconds                             |
|`CACHE_TTL_DL`    |`600`        |Download cache TTL in seconds                           |
|`RATE_LIMIT_MAX`  |`100`        |Max requests per 15 min per IP                          |
|`MEMORY_LIMIT_MB` |`512`        |Memory threshold for cache flush                        |
|`PROXY_URL`       |*(none)*     |Optional residential proxy: `http://user:pass@host:port`|

Platform-specific variables are auto-detected:

- Render: `RENDER`, `RENDER_EXTERNAL_URL`
- Koyeb: `KOYEB`, `KOYEB_APP_NAME`, `KOYEB_PUBLIC_DOMAIN`
- Vercel: `VERCEL`, `VERCEL_URL`
- Railway: `RAILWAY_STATIC_URL`, `RAILWAY_ENVIRONMENT`
- Fly.io: `FLY_APP_NAME`

-----

## 🔧 Why It Doesn’t Get Blocked

1. **Session warm-up** — visits homepage first, gets real cookies
1. **English locale cookies** — `lang=en` + `oslocale=en` prevent locale redirects
1. **5 browser profiles** — Chrome Win/Mac/Linux, Firefox, Edge — round-robin rotated
1. **Consistent client-hint headers** — `sec-ch-ua` matches UA exactly
1. **Dual URL strategy** — `/search/` and `/search2/` alternated per retry
1. **Exponential backoff** — natural human-like timing between attempts
1. **Homepage redirect detection** — detects Dutch/wrong page and re-warms session
1. **Cookie persistence** — `cf_clearance` and session cookies reused across requests
1. **Curated TLS ciphers** — avoids obvious Node.js TLS fingerprint
1. **Proxy support** — set `PROXY_URL` for residential IP if cloud IP gets hard-blocked

-----

## 🏗️ Project Structure

```
subtitle-api/
├── server.js       ← Main server (all logic, all platforms)
├── package.json    ← Dependencies & scripts
├── render.yaml     ← Render IaC config
├── koyeb.yml       ← Koyeb deployment config
├── vercel.json     ← Vercel serverless config
├── Dockerfile      ← Production Docker image
└── .gitignore
```

-----

## 👥 Credits

|           |                                    |
|-----------|------------------------------------|
|🩷 **Munax**|Creator · Architect · Vision        |
|🤝 **Jerry**|Co-developer · Codebase Collaborator| 
**sahid ikk** 🤛🏻
-----

*VOID CINEMA API — Ultra Peak Edition · v4.0*
