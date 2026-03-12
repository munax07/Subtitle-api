# VOID CINEMA

**OpenSubtitles Proxy API — Ultra Peak v13.0**

> Unlimited subtitle search. Malayalam-first. Auto-title from release metadata. Proxy rotation. ZIP extraction. Session warmup. Silent precision.

**Base URL** — `https://powerful-sib-mujaiwow-0209e698.koyeb.app`

**Dashboard** — [void.cinema dashboard](https://powerful-sib-mujaiwow-0209e698.koyeb.app) · available in dark and light

-----

## Endpoints

|Method|Route                                              |Description                                  |
|------|---------------------------------------------------|---------------------------------------------|
|`GET` |`/search?q={query}`                                |Search subtitles                             |
|`GET` |`/search?q={query}&lang={code}&type={movie|series}`|Filtered search                              |
|`GET` |`/download?id={id}`                                |Download subtitle file                       |
|`GET` |`/languages?q={query}`                             |Available languages for a title              |
|`GET` |`/stats`                                           |Server stats — cache, memory, proxy, session |
|`GET` |`/health`                                          |Health check — lightweight, no outbound calls|

-----

## Quick Start

```
# Search
GET /search?q=Inception

# Malayalam search
GET /search?q=Vikram&lang=ml&type=movie

# English search
GET /search?q=fight+club&lang=en

# Download
GET /download?id=3962439

# Available languages for a title
GET /languages?q=Inception
```

-----

## Response — Search

```json
{
  "success": true,
  "total": 40,
  "results": [
    {
      "id": "3962439",
      "title": "Inception",
      "year": "2010",
      "lang": "en",
      "langName": "English",
      "downloads": 132462,
      "subfilename": "Inception.2010.BluRay.1080p.srt",
      "type": "movie",
      "features": {
        "hd": true,
        "trusted": false,
        "hearing_impaired": false
      }
    }
  ]
}
```

-----

## Response — Download

Returns the raw `.srt` file directly — ready to use.

Auto-title pulls the real release filename from meta cache. No manual `&title=` param needed.

-----

## Language Codes

|Code|Language                                    |
|----|--------------------------------------------|
|`ml`|Malayalam *(priority — always sorted first)*|
|`en`|English                                     |
|`ta`|Tamil                                       |
|`hi`|Hindi                                       |
|`te`|Telugu                                      |
|`fr`|French                                      |
|`es`|Spanish                                     |
|`de`|German                                      |
|`ja`|Japanese                                    |
|`ko`|Korean                                      |
|`zh`|Chinese                                     |

-----

## Architecture

```
Search  ->  OpenSubtitles simpleXML  (unlimited, no login)
Download -> Official REST API (if credentials set)
            +-- Scraper fallback
Auto-title <- Meta cache (subtitle ID -> release filename)
Proxy   ->  PROXY_URL (primary) + BACKUP_PROXY_1..20 (rotation)
Session ->  Browser-mimicked cookies, auto-refresh
Cache   ->  Search 600s . Download 1800s . Meta 3600s
```

-----

## Self-Host — Koyeb

```
1. Fork this repo
2. Connect to Koyeb -> New App -> GitHub
3. Set env vars:

   PROXY_URL=http://user:pass@host:port
   BACKUP_PROXY_1=http://user:pass@host:port
   BACKUP_PROXY_2=http://user:pass@host:port

   # Optional -- 100 reliable downloads/day free
   OS_API_KEY=your_key
   OS_USERNAME=your_username
   OS_PASSWORD=your_password

4. Deploy. Done.
```

-----

## Self-Host — Local

```bash
git clone https://github.com/munax07/Opensub-Api.git
cd Opensub-Api
npm install
npm start
```

Requires Node >= 18.

-----

## Dependencies

```json
"adm-zip":           "^0.5.10",
"axios":             "^1.6.2",
"cheerio":           "^1.0.0-rc.12",
"compression":       "^1.7.4",
"cors":              "^2.8.5",
"express":           "^4.18.2",
"express-rate-limit":"^7.1.5",
"https-proxy-agent": "^7.0.2",
"node-cache":        "^5.1.2"
```

-----

## Dashboard

The `/` root serves a live dashboard in two colorways.

**Dark** — pure black, warm gold accent, Cormorant Garamond serif.

**Light** — warm cream, same gold, same font. Editorial.

Live stats auto-refresh every 12 seconds — uptime, cache keys, heap memory, proxy pool, session status, API quota.

-----

## Stack

- **Runtime** — Node.js 20, Express 4
- **Deploy** — Koyeb (auto-ping, graceful shutdown)
- **Search** — OpenSubtitles simpleXML scraping
- **Download** — Official REST API + scraper fallback
- **Proxy** — https-proxy-agent, rotation pool up to 20
- **Cache** — node-cache, three independent caches
- **Compression** — gzip via compression middleware

-----

## Notes

- Rate limit: 100 requests / 15 min per IP
- Every request gets a unique `X-Request-ID` header
- `X-Response-Time` header on every response
- ETag support on search responses — `If-None-Match` for 304
- Malayalam auto-detected from query — ml to en priority applied automatically
- Session warms up on cold start — requests queue until ready

-----

<br>

```
architecture by munax
```

[instagram.com/munavi.r_](https://instagram.com/munavi.r_)
