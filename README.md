<div align="center">

<br>

# V O I D   C I N E M A

<br>

**OpenSubtitles Proxy API**

<sub>Ultra Peak v13.0  ·  Malayalam First  ·  Proxy Rotation  ·  Auto-title  ·  Silent Precision</sub>

<br>

`https://powerful-sib-mujaiwow-0209e698.koyeb.app`

<br>

[![Live](https://img.shields.io/badge/status-live-gold?style=flat-square&color=b8965a&labelColor=000)](https://powerful-sib-mujaiwow-0209e698.koyeb.app)
[![Node](https://img.shields.io/badge/node-%3E%3D18-gold?style=flat-square&color=b8965a&labelColor=000)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-koyeb-gold?style=flat-square&color=b8965a&labelColor=000)](https://koyeb.com)

</div>

<br>

-----

<br>

##   Endpoints

<br>

|  Method|Route                                              |Description                    |
|--------|---------------------------------------------------|-------------------------------|
|  `GET` |`/search?q={query}`                                |Search subtitles — unlimited   |
|  `GET` |`/search?q={query}&lang={code}&type={movie|series}`|Filtered search                |
|  `GET` |`/download?id={id}`                                |Download subtitle — auto-title |
|  `GET` |`/languages?q={query}`                             |Available languages for a title|
|  `GET` |`/stats`                                           |Live server stats              |
|  `GET` |`/health`                                          |Health check                   |

<br>

-----

<br>

##   Quick Start

<br>

```bash
# Search
GET /search?q=Inception

# Malayalam — always priority
GET /search?q=Vikram&lang=ml&type=movie

# English
GET /search?q=fight+club&lang=en

# Download — filename auto-resolved from meta cache
GET /download?id=3962439

# Languages available for a title
GET /languages?q=Inception
```

<br>

-----

<br>

##   Response

<br>

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

<br>


> Download returns the raw `.srt` file directly. No `&title=` param needed — filename is resolved automatically from the meta cache.

<br>

-----

<br>

##   Architecture

<br>

```
Search   ──▶  simpleXML scraping        unlimited, no auth required
Download ──▶  Official REST API         if OS_API_KEY is set
             └─▶ Scraper fallback       automatic on failure

Auto-title ◀── Meta cache              subtitle ID → release filename
Proxy      ──▶  Primary + up to 20     auto-rotates on 2 consecutive fails
Session    ──▶  Browser-mimicked       cookies, UA, auto-refresh
Requests   ──▶  Queued on cold start   nothing fires until session is ready

Cache
  Search   ────────────────────────── 600s
  Download ────────────────────────── 1800s
  Meta     ────────────────────────── 3600s
```

<br>

-----

<br>

##   Language Priority

<br>

|Code|Language |              |
|----|---------|--------------|
|`ml`|Malayalam|← always first|
|`en`|English  |              |
|`ta`|Tamil    |              |
|`hi`|Hindi    |              |
|`te`|Telugu   |              |
|`fr`|French   |              |
|`es`|Spanish  |              |
|`de`|German   |              |
|`ja`|Japanese |              |
|`ko`|Korean   |              |
|`zh`|Chinese  |              |

<br>


> Malayalam is auto-detected and sorted first regardless of query language.

<br>

-----

<br>

##   Deploy — Koyeb

<br>

```bash
# 1. Fork this repo
# 2. Connect GitHub to Koyeb → New App

# Required env vars
PROXY_URL=http://user:pass@host:port

# Optional backup rotation (up to 20)
BACKUP_PROXY_1=http://user:pass@host:port
BACKUP_PROXY_2=http://user:pass@host:port

# Optional — 100 reliable downloads/day free
# register at opensubtitles.com/en/consumers
OS_API_KEY=your_key
OS_USERNAME=your_username
OS_PASSWORD=your_password
```

<br>

-----

<br>

##   Run Locally

<br>

```bash
git clone https://github.com/munax07/Opensub-Api.git
cd Opensub-Api
npm install
npm start
```

<sub>Requires Node.js ≥ 18</sub>

<br>

-----

<br>

##   Stack

<br>

```
Runtime      Node.js 20 + Express 4
Deploy       Koyeb — auto-ping, graceful shutdown
Search       OpenSubtitles simpleXML
Download     REST API + cheerio scraper
Proxy        https-proxy-agent — rotation pool
Cache        node-cache — three independent stores
Compression  gzip via compression middleware
```

<br>

-----

<br>

##   Headers

<br>

Every response includes:

```
X-Request-ID      unique per request — for debugging
X-Response-Time   latency in ms
ETag              search responses — supports If-None-Match → 304
Retry-After       on 429 rate limit responses
```

Rate limit: `100 requests / 15 min / IP`

<br>

-----

<br>

##   Dashboard

<br>

The root `/` serves a live dashboard — dark and light mode with one toggle.

Live stats refresh every 12 seconds — uptime, cache keys, heap, proxy pool, session status, API quota.

<br>

-----

<br>
<br>

<div align="center">

```
architecture by munax
```

<sub>[instagram.com/munavi.r_](https://instagram.com/munavi.r_)</sub>

<br>

</div>
