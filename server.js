const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
 
const app = express();
const PORT = process.env.PORT || 3000;
 
const client = axios.create({
  timeout: 20000,
  maxRedirects: 5,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://www.opensubtitles.org/",
    Connection: "keep-alive",
  },
  validateStatus: () => true,
});
 
function serializeError(res, url) {
  return {
    status: res && res.status,
    statusText: res && res.statusText,
    url: url,
    headers: res && res.headers,
    body:
      typeof res?.data === "string"
        ? res.data.slice(0, 3000)
        : res?.data || null,
  };
}
 
function parseSearch(html) {
  if (!html) return [];
 
  const $ = cheerio.load(html);
  const list = [];
 
  $("#search_results tbody tr").each((_, row) => {
    const r = $(row);
 
    if (
      r.hasClass("head") ||
      r.attr("style") === "display:none" ||
      !r.attr("onclick")
    )
      return;
 
    const idMatch =
      r.attr("onclick")?.match(/servOC\((\d+)/) ||
      r.attr("id")?.match(/name(\d+)/);
 
    if (!idMatch) return;
 
    const id = idMatch[1];
 
    let title = r.find("td:first-child strong a").text().trim();
    let year = null;
 
    const ym = title.match(/\((\d{4})\)$/);
    if (ym) {
      year = ym[1];
      title = title.replace(/\s*\(\d{4}\)$/, "");
    }
 
    let language = "unknown";
    const flag = r.find(".flag").attr("class") || "";
    const lm = flag.match(/flag\s+([a-z]{2})/);
    if (lm) language = lm[1];
 
    let downloads = 0;
    const dltxt = r.find('a[href*="subtitleserve"]').text();
    if (dltxt) downloads = parseInt(dltxt.replace("x", "")) || 0;
 
    const uploader = r.find("td:last-child a").text().trim() || "anonymous";
    const uploadDate = r.find("time").text().trim() || null;
 
    list.push({
      id,
      title,
      year,
      language,
      downloads,
      uploader,
      uploadDate,
    });
  });
 
  return list;
}
 
async function searchSubtitles(query) {
  const url =
    "https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-" +
    encodeURIComponent(query);
 
  const res = await client.get(url);
 
  if (res.status !== 200) {
    throw {
      type: "search_failed",
      debug: serializeError(res, url),
    };
  }
 
  const results = parseSearch(res.data);
  results.sort((a, b) => b.downloads - a.downloads);
 
  return {
    query,
    total: results.length,
    results,
  };
}
 
async function downloadSubtitle(id) {
  const urls = [
    `https://dl.opensubtitles.org/en/download/sub/${id}`,
    `https://www.opensubtitles.org/en/subtitleserve/sub/${id}`,
  ];
 
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const res = await client.get(url, { responseType: "arraybuffer" });
 
    if (res.status !== 200) continue;
 
    const buf = Buffer.from(res.data);
    const head = buf.slice(0, 200).toString();
 
    if (head.includes("<html")) continue;
 
    let ext = "srt";
    const cd = res.headers["content-disposition"];
    if (cd) {
      const m = cd.match(/filename="?([^";]+)"?/);
      if (m) ext = m[1].split(".").pop();
    }
 
    return { buffer: buf, ext };
  }
 
  throw { type: "download_failed", message: "All sources failed" };
}
 
app.get("/", (req, res) => {
  res.send("OpenSubtitles proxy running");
});
 
app.get("/subtitle", async (req, res) => {
  const action = req.query.action;
 
  try {
    if (action === "search") {
      const q = req.query.q;
      if (!q) return res.status(400).json({ error: "Missing q" });
 
      const data = await searchSubtitles(q);
      return res.json({ success: true, data });
    }
 
    if (action === "download") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "Missing id" });
 
      const file = await downloadSubtitle(id);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="subtitle_${id}.${file.ext}"`
      );
      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(file.buffer);
    }
 
    res.status(400).json({
      error: "Invalid action",
      usage: [
        "/subtitle?action=search&q=inception",
        "/subtitle?action=download&id=195979",
      ],
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.type || "internal_error",
      debug: err.debug || err,
    });
  }
});
 
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
