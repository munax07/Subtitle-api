<div align="center">

<br>
<br>

# ⍟   V O I D   C I N E M A   ⍟

<br>

<sup>O P E N S U B T I T L E S   P R O X Y   I N F R A S T R U C T U R E</sup>

<br>


> *Unlimited search. Malayalam-first. Auto-title. Proxy rotation.*
> *Session warmup. ZIP extraction. Silent precision.*

<br>

`https://powerful-sib-mujaiwow-0209e698.koyeb.app`

<br>

[![](https://img.shields.io/badge/status-live-00e5ff?style=flat-square&logo=koyeb&logoColor=white&labelColor=0a0c10)](https://powerful-sib-mujaiwow-0209e698.koyeb.app) 
[![](https://img.shields.io/badge/version-v13.0-b8965a?style=flat-square&labelColor=0a0c10)]() 
[![](https://img.shields.io/badge/node-%3E%3D18-ffb74d?style=flat-square&logo=node.js&logoColor=white&labelColor=0a0c10)]() 
[![](https://img.shields.io/badge/license-MIT-444?style=flat-square&labelColor=0a0c10)]()

<br>
<br>

-----

</div>

<br>

## ▸   Quick Start

<br>

```bash
# Search — unlimited, no auth
curl "https://powerful-sib-mujaiwow-0209e698.koyeb.app/search?q=inception"

# Malayalam — always sorted first
curl "https://powerful-sib-mujaiwow-0209e698.koyeb.app/search?q=vikram&lang=ml&type=movie"

# English
curl "https://powerful-sib-mujaiwow-0209e698.koyeb.app/search?q=fight+club&lang=en"

# Download — filename resolved automatically
curl -OJ "https://powerful-sib-mujaiwow-0209e698.koyeb.app/download?id=3962439"

# Available languages for a title
curl "https://powerful-sib-mujaiwow-0209e698.koyeb.app/languages?q=inception"

# Live server stats
curl "https://powerful-sib-mujaiwow-0209e698.koyeb.app/stats"
```

<br>

-----

<br>

## ▸   Endpoints

<br>

| |Method|Route                                              |Description                 |
|-|------|---------------------------------------------------|----------------------------|
|🔍|`GET` |`/search?q={query}`                                |Search subtitles            |
|🔍|`GET` |`/search?q={query}&lang={code}&type={movie|series}`|Filtered search             |
|⬇️|`GET` |`/download?id={id}`                                |Download `.srt` — auto‑title|
|🌐|`GET` |`/languages?q={query}`                             |Languages for a title       |
|📊|`GET` |`/stats`                                           |Live server stats           |
|🩺|`GET` |`/health`                                          |Health check                |

<br>

-----

<br>

## ▸   Response

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


> `/download` returns the raw `.srt` file directly.
> Filename is resolved from the meta cache — no `&title=` param needed.

<br>

-----

<br>

## ▸   Language Codes

<br>

|Code|Language |Priority        |
|----|---------|----------------|
|`ml`|Malayalam|**Always first**|
|`en`|English  |2nd             |
|`ta`|Tamil    |                |
|`hi`|Hindi    |                |
|`te`|Telugu   |                |
|`fr`|French   |                |
|`es`|Spanish  |                |
|`de`|German   |                |
|`ja`|Japanese |                |
|`ko`|Korean   |                |
|`zh`|Chinese  |                |

<br>


> Malayalam is auto-detected from your query and prioritised automatically.
> You don’t need to pass `&lang=ml` for it to work.

<br>

-----

<br>

## ▸   Architecture

<br>

```
Search   ──▶  simpleXML scraping          unlimited · no login required
Download ──▶  Official REST API           if OS credentials configured
              └──▶ Scraper fallback       automatic on any failure

Auto-title ◀── Meta cache                subtitle ID → real release filename
                                          stored during search, used at download

Proxy pool ──▶  PROXY_URL (primary)      
                BACKUP_PROXY_1..20       auto-rotates on 2 consecutive fails

Session    ──▶  Browser-mimicked         cookies · user-agent · auto-refresh
Cold start ──▶  Request queue            all requests wait until session is warm

Cache layers
  Search   ──────────────────────────────────────────  600s
  Download ──────────────────────────────────────────  1800s
  Meta     ──────────────────────────────────────────  3600s
```

<br>

-----

<br>

## ▸   Deploy — Koyeb

<br>

```bash
# 1  Fork this repo
# 2  Koyeb → New App → GitHub → select your fork
# 3  Set environment variables below
# 4  Deploy
```

<br>

```env
# Primary proxy — required for best results
PROXY_URL=http://user:pass@host:port

# Backup rotation — up to 20 supported
BACKUP_PROXY_1=http://user:pass@host:port
BACKUP_PROXY_2=http://user:pass@host:port

# Official API — optional
# 100 reliable downloads/day free
# Register → opensubtitles.com/en/consumers
OS_API_KEY=your_api_key
OS_USERNAME=your_username
OS_PASSWORD=your_password
```

<br>

-----

<br>

## ▸   Run Locally

<br>

```bash
git clone https://github.com/munax07/Opensub-Api.git
cd Opensub-Api
npm install
npm start
```

<br>


> Requires Node.js ≥ 18

<br>

-----

<br>

## ▸   Response Headers

<br>

```
X-Request-ID      unique ID per request — use for debugging
X-Response-Time   response latency in ms
ETag              on search responses — supports If-None-Match → 304
Retry-After       on 429 — tells client when to retry
```

<br>


> Rate limit — `100 requests / 15 min / IP`

<br>

-----

<br>

## ▸   Dashboard

<br>

The root `/` serves a live dashboard with a **dark ↔ light** toggle.

Built with Bodoni Moda serif and Fragment Mono — two colorways, one file.
Stats auto‑refresh every 12 seconds.

<br>

|Stat        |Description                     |
|------------|--------------------------------|
|Uptime      |Hours since last cold start     |
|Search Cache|Active search result keys       |
|Meta Cache  |Subtitle metadata keys          |
|DL Buffer   |Cached download files           |
|Heap        |Node.js memory usage            |
|Session     |Warmup status                   |
|Proxy       |Active proxy in rotation        |
|Quota       |Official API usage if configured|

<br>

-----

<br>
<br>

<div align="center">

<br>

**Built with precision. No shortcuts.**

<br>

```
architecture by munax
```

<sub>[instagram.com/munavi.r_](https://instagram.com/munavi.r_)</sub>

<br>
<br>

</div>
