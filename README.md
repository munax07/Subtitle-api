# 🎬 ULTRA PEAK SUBTITLE API  
**The most advanced, unblockable, Malayalam‑first OpenSubtitles proxy**  

<p align="center">
  <img src="https://img.shields.io/badge/version-11.0.0-brightgreen" />
  <img src="https://img.shields.io/badge/node-%3E%3D18-blue" />
  <img src="https://img.shields.io/badge/license-MIT-purple" />
  <img src="https://img.shields.io/badge/PRs-welcome-orange" />
</p>

<p align="center">
  <a href="https://app.koyeb.com/deploy?type=git&repository=github.com/shamilmyran/subtitle-api&branch=main&name=subtitle-api">
    <img src="https://www.koyeb.com/static/images/deploy/button.svg" />
  </a>
  <a href="https://render.com/deploy?repo=https://github.com/shamilmyran/subtitle-api">
    <img src="https://render.com/images/deploy-to-render-button.svg" />
  </a>
</p>

---

## ✨ Features  
- **Malayalam first** – automatically prioritizes Malayalam subtitles, then English, then others.  
- **Anti‑block** – multi‑layer fallback: Vercel proxy, free proxy pool, direct connection.  
- **Smart ZIP extraction** – unpacks `.srt` files from ZIP archives, discards `.nfo`.  
- **Perfect filenames** – downloads named like `Inception_2010.srt`.  
- **Session & cookies** – mimics a real browser, avoids Cloudflare blocks.  
- **Caching** – search results (10 min), download metadata (30 min).  
- **Rate limiting** – 100 requests / 15 min per IP (configurable).  
- **Request ID tracking** – every request gets a unique ID for debugging.  
- **Deep health checks** – `/health` verifies connectivity & session.  
- **Structured JSON logs** – ready for log aggregators.  
- **Graceful shutdown** – handles SIGTERM, finishes active requests.  
- **Platform‑aware** – runs on Koyeb, Render, Vercel, Railway, Fly.io, locally.  

---

## 🚀 Quick Deploy  

| Platform | One‑click |
|----------|-----------|
| **Koyeb** | [![Deploy to Koyeb](https://www.koyeb.com/static/images/deploy/button.svg)](https://app.koyeb.com/deploy?type=git&repository=github.com/shamilmyran/subtitle-api&branch=main&name=subtitle-api) |
| **Render** | [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/shamilmyran/subtitle-api) |

### Manual  
```bash
git clone https://github.com/shamilmyran/subtitle-api.git
cd subtitle-api
npm install
npm start
