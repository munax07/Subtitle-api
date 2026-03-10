<div align="center">

```
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║    ░░  ░░  ░░░░░  ░░  ░░░░░      ░░░░░  ░░  ░░░░  ░░░░░    ║
║    ▒▒  ▒▒ ▒▒   ▒ ▒▒  ▒▒   ▒    ▒▒      ▒▒  ▒▒  ▒ ▒▒  ▒▒   ║
║    ▓▓  ▓▓ ▓▓   ▓ ▓▓  ▓▓   ▓▓  ▓▓       ▓▓  ▓▓  ▓ ▓▓  ▓▓   ║
║    ██████ ██   █ ██  █████    ██        ██  █████ █████    ║
║    ██  ██  █████ ██  ██   ██   █████    ██  ██  █ ██  ██   ║
║                                                              ║
║              O P E N S U B T I T L E S   P R O X Y          ║
║                   U L T R A  P E A K  E D I T I O N         ║
║                          v 4 . 0  F I N A L                  ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

<br>

![Status](https://img.shields.io/badge/STATUS-PEAK-e2ff47?style=for-the-badge&labelColor=0c0f18&color=e2ff47)
![Version](https://img.shields.io/badge/VERSION-4.0.0-47f4c8?style=for-the-badge&labelColor=0c0f18&color=47f4c8)
![Platform](https://img.shields.io/badge/PLATFORMS-5-f447a8?style=for-the-badge&labelColor=0c0f18&color=f447a8)
![Node](https://img.shields.io/badge/NODE-%3E%3D18-ffffff?style=for-the-badge&labelColor=0c0f18)
![License](https://img.shields.io/badge/LICENSE-MIT-ffffff?style=for-the-badge&labelColor=0c0f18)

<br>

*A session-aware, anti-block, multi-platform subtitle proxy —*
*built for people who want subtitles to just work, forever.*

<br>

</div>

-----

<br>

## ◈ What Is This

A proxy API that sits between your app and OpenSubtitles.org.
It handles everything that makes scraping hard — sessions, cookies, redirects, retries, blocks, caching, rate limiting — so you never have to think about it.

You call one endpoint. You get subtitles. That’s it.

<br>

## ◈ Why It Doesn’t Get Blocked

Most proxies break because they send a bare request with no context and get immediately flagged. This one doesn’t.

```
Boot
 └─ warmUpSession()
     └─ visits opensubtitles.org/en
         └─ collects real Cloudflare + session cookies
             └─ stores them in cookie jar
                 └─ every request from here uses those cookies
```

On top of that:

```
Request comes in
 └─ pick next browser profile (round-robin: 5 profiles)
     Chrome Win / Chrome Mac / Chrome Linux / Firefox Win / Edge Win
 └─ attach cookie jar (lang=en forced from first byte)
 └─ send with exponential backoff if blocked:
     attempt 1 → 1.1s delay
     attempt 2 → 1.6s delay  + alternate URL strategy
     attempt 3 → 2.5s delay  + re-warm session
     attempt 4 → 3.7s delay  + alternate URL strategy
 └─ detect homepage redirect (Dutch/wrong locale)
     └─ re-warm session automatically
         └─ retry
```

The result: **4 retries, 2 URL strategies, 5 browser identities, live cookie jar, session auto-refresh every 2 hours.**

<br>

-----

## ◈ Feature Matrix

```
┌─────────────────────────────────────────┬──────────┐
│  Feature                                │  Status  │
├─────────────────────────────────────────┼──────────┤
│  Session warm-up on boot                │  ✦ ON    │
│  Forced English locale (no redirects)   │  ✦ ON    │
│  Cookie jar (Cloudflare persistence)    │  ✦ ON    │
│  5 browser profiles, round-robin        │  ✦ ON    │
│  Dual URL strategy (/search + /search2) │  ✦ ON    │
│  Exponential backoff (4 retries)        │  ✦ ON    │
│  Homepage redirect detection            │  ✦ ON    │
│  Search cache (5 min TTL)               │  ✦ ON    │
│  Download cache (10 min TTL)            │  ✦ ON    │
│  Memory watchdog + auto GC              │  ✦ ON    │
│  Rate limiting (100 req / 15 min)       │  ✦ ON    │
│  CORS enabled (all origins)             │  ✦ ON    │
│  Self-ping (free tier keepalive)        │  ✦ ON    │
│  TLS cipher optimization                │  ✦ ON    │
│  Residential proxy support              │  ✧ OPT   │
│  Vercel serverless                      │  ✧ OPT   │
└─────────────────────────────────────────┴──────────┘
```

<br>

-----

## ◈ Platform Support

This codebase detects its deployment environment automatically.
One `server.js`. Zero platform-specific config changes needed.

```
  RENDER    ─── render.yaml        free tier · self-ping · IaC
  KOYEB     ─── koyeb.yml          free tier · health check · auto-deploy
  VERCEL    ─── vercel.json        serverless · 30s timeout · no bg jobs
  RAILWAY   ─── (auto-detected)    persistent · keepalive active
  FLY.IO    ─── (auto-detected)    persistent · keepalive active
  DOCKER    ─── Dockerfile         non-root · multi-stage · healthcheck
  LOCAL     ─── npm start          development mode
```

Platform detection is fully automatic — the server reads env vars and configures itself:

```js
// You never touch this. It just works.
const PLATFORM = detect();  // → "render" | "koyeb" | "vercel" | ...
const BASE_URL  = resolve(); // → your real public URL, automatically
```

<br>

-----

## ◈ Quick Deploy

### Render

1. Fork this repo
1. Go to [render.com](https://render.com) → New Web Service
1. Connect your fork
1. Render reads `render.yaml` automatically
1. Done

Or one-click:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/munax07/Subtitle-api)

### Koyeb

1. Go to [koyeb.com](https://koyeb.com) → Create App
1. Connect your GitHub repo
1. Koyeb reads `koyeb.yml` automatically
1. Set env vars if needed (all have defaults)
1. Done

### Vercel

```bash
npm i -g vercel
vercel --prod
```

> Note: Background jobs (self-ping, session refresh, memory watchdog) are automatically disabled on Vercel because serverless functions have no persistent process. Each request is stateless — warm-up runs per cold start.

### Docker

```bash
# Build
docker build -t void-cinema-api .

# Run
docker run -p 3000:3000 \
  -e NODE_ENV=production \
  -e MEMORY_LIMIT_MB=512 \
  void-cinema-api
```

### Local

```bash
git clone https://github.com/munax07/Subtitle-api
cd Subtitle-api
npm install
npm start
# → http://localhost:3000
```

<br>

-----

## ◈ API Reference

### `GET /subtitle`

The main endpoint. Everything goes through here.

-----

**Search**

```
GET /subtitle?action=search&q={query}&lang={lang}&page={n}
```

```
Parameters:
  q       required   Movie or show name. Max 200 chars.
  lang    optional   Language code: en · ml · fr · de · es · hi · ja · ko …
  page    optional   Page number. Range: 1 – 100. Default: 1.
```

```json
{
  "success": true,
  "data": {
    "query":     "inception",
    "page":      1,
    "total":     40,
    "fromCache": false,
    "results": [
      {
        "id":           "3962439",
        "title":        "Inception",
        "year":         "2010",
        "language":     "en",
        "downloads":    132434,
        "uploader":     "kmmt123",
        "uploadDate":   "18/11/10",
        "filename":     "Inception.2010.1080p.BluRay.x264-FGT",
        "features": {
          "hd":               true,
          "hearingImpaired":  false,
          "trusted":          true
        }
      }
    ]
  }
}
```

-----

**Download**

```
GET /subtitle?action=download&id={id}&filename={hint}
```

```
Parameters:
  id        required   Numeric subtitle ID from search results.
  filename  optional   Custom filename hint for the downloaded file.
```

Returns the raw subtitle file with correct `Content-Disposition`,
`Content-Type`, and `Content-Length` headers. Supports `.srt`, `.sub`, `.ass`, `.ssa`.

-----

### `GET /languages`

```
GET /languages?q={query}
```

Returns all available language codes for a query. Useful for building language pickers.

```json
{
  "success":   true,
  "query":     "inception",
  "fromCache": true,
  "count":     12,
  "languages": ["ar", "en", "es", "fr", "hi", "it", "ml", "pt", "ro", "ru", "tr", "zh"]
}
```

-----

### `GET /stats`

Returns full server telemetry.

```json
{
  "success":         true,
  "uptime":          3720,
  "uptimeFormatted": "01:02:00",
  "platform":        "koyeb",
  "sessionReady":    true,
  "cookieCount":     4,
  "memory": {
    "rss":       "62.40 MB",
    "heapUsed":  "28.11 MB",
    "heapTotal": "48.00 MB"
  },
  "cache": {
    "search":   { "keys": 12, "hits": 340, "misses": 12 },
    "download": { "keys": 5,  "hits": 88,  "misses": 5  }
  },
  "config": {
    "searchTTL":   300,
    "dlTTL":       600,
    "rateMax":     100,
    "retries":     4,
    "proxyActive": false,
    "selfPing":    true,
    "serverless":  false
  },
  "credits": {
    "creator":      "Munax 🩷",
    "collaborator": "Jerry 🤝"
  }
}
```

-----

### `GET /health`

Lightweight. Used by all deployment platforms.

```json
{
  "status":       "healthy",
  "uptime":       3720,
  "platform":     "koyeb",
  "sessionReady": true,
  "timestamp":    "2025-03-10T07:00:00.000Z"
}
```

<br>

-----

## ◈ Environment Variables

```
┌──────────────────────┬────────────┬──────────────────────────────────────────┐
│  Variable            │  Default   │  Description                             │
├──────────────────────┼────────────┼──────────────────────────────────────────┤
│  PORT                │  3000      │  Server port                             │
│  NODE_ENV            │  dev       │  Set to production on deploy             │
│  CACHE_TTL_SEARCH    │  300       │  Search cache TTL in seconds             │
│  CACHE_TTL_DL        │  600       │  Download cache TTL in seconds           │
│  RATE_LIMIT_MAX      │  100       │  Max requests per 15 min per IP          │
│  MEMORY_LIMIT_MB     │  512       │  Heap threshold before cache flush       │
│  PROXY_URL           │  (none)    │  http://user:pass@host:port              │
│  REQUEST_TIMEOUT_MS  │  22000     │  Axios timeout in ms                     │
└──────────────────────┴────────────┴──────────────────────────────────────────┘

  Auto-detected (do not set manually):
    RENDER / RENDER_EXTERNAL_URL     → platform = render
    KOYEB / KOYEB_APP_NAME           → platform = koyeb
    VERCEL / VERCEL_URL              → platform = vercel
    RAILWAY_STATIC_URL               → platform = railway
    FLY_APP_NAME                     → platform = fly
```

<br>

-----

## ◈ Project Structure

```
Subtitle-api/
│
├── server.js          ← Everything. One file. All platforms.
│                         1,225 lines. Zero compromises.
│
├── package.json       ← Dependencies + npm scripts
│
├── render.yaml        ← Render IaC deployment config
├── koyeb.yml          ← Koyeb deployment config
├── vercel.json        ← Vercel serverless config
│
├── Dockerfile         ← Multi-stage · non-root · healthcheck
│
├── .gitignore
└── README.md          ← You are here
```

<br>

-----

## ◈ Stack

```
  Runtime     Node.js ≥ 18
  Framework   Express 4
  HTTP        Axios 1.7
  Parsing     Cheerio 1.0
  Cache       NodeCache 5
  Rate limit  express-rate-limit 7
  CORS        cors 2
```

No database. No external services. No paid dependencies.
Everything runs in a single process on the smallest free tier available.

<br>

-----

## ◈ If It Gets Blocked

**Level 1 — already handled automatically:**

- 403 / 429 / 503 → retry with session re-warm

**Level 2 — set a residential proxy:**

```
PROXY_URL=http://username:password@proxy-host:port
```

Residential IPs bypass Cloudflare IP reputation scoring.
Free cloud IPs (Render, Koyeb) have lower trust scores by default.

**Level 3 — Cloudflare JS Challenge:**
If OpenSubtitles ever enables a full JS challenge (the spinning “Checking your browser” page), no HTTP client can solve it without executing real JavaScript. The solution at that point is [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) — a companion service that uses a real headless browser to solve challenges and return cookies.

<br>

-----

## ◈ People

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   🩷  Munax                                             │
│       Creator · Architect · Vision                      │
│       github.com/munax07                                │
│                                                         │
│   🤝  Jerry                                             │
│       Co-developer · Bug Fixer · Collaborator           │
│                                                         │
│   🤛🏻  Sahid Ikka                                        │
│       Codebase Co-developer · Silent Force              │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

<br>

-----

## ◈ License

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
```

<br>

-----

<div align="center">

```
  ─────────────────────────────────────────────
    VOID CINEMA API  ·  Ultra Peak Edition
    v4.0 Final  ·  Node.js · Express · Cheerio
    🩷 Munax  ·  🤝 Jerry  ·  🤛🏻 Sahid Ikka
  ─────────────────────────────────────────────
```

*Built for the subtitle community.*
*Made to last.*

</div>
