const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------
// Provided functions (unchanged)
// ------------------------------------------------------------
function parseSubtitleSearch(html) {
  if (!html || typeof html !== "string") {
    console.error("Invalid HTML passed to parseSubtitleSearch:", typeof html);
    return [];
  }

  const $ = cheerio.load(html);
  const results = [];

  $("#search_results tbody tr").each((i, row) => {
    const $row = $(row);

    if (
      $row.hasClass("head") ||
      $row.attr("style") === "display:none" ||
      !$row.attr("onclick")
    ) {
      return;
    }

    const onclick = $row.attr("onclick") || "";
    const idMatch =
      onclick.match(/servOC\((\d+)/) ||
      $row.attr("id")?.match(/name(\d+)/);

    if (!idMatch) return;
    const id = idMatch[1];

    const titleElement = $row
      .find("td:first-child strong a")
      .first();

    let title = titleElement.text().trim();
    let year = null;

    const yearMatch = title.match(/\((\d{4})\)$/);
    if (yearMatch) {
      year = yearMatch[1];
      title = title.replace(/\s*\(\d{4}\)$/, "").trim();
    }

    let language = "unknown";
    const flag = $row.find(".flag").first();
    if (flag.length) {
      const flagClass = flag.attr("class") || "";
      const langMatch = flagClass.match(/flag\s+([a-z]{2})/);
      if (langMatch) language = langMatch[1];
    }

    let downloads = 0;
    const downloadLink = $row
      .find('a[href*="subtitleserve"]')
      .first();

    if (downloadLink.length) {
      const dlText = downloadLink.text().trim().replace("x", "");
      downloads = parseInt(dlText) || 0;
    }

    let uploader = "anonymous";
    const uploaderLink = $row
      .find("td:last-child a")
      .first();

    if (uploaderLink.length) {
      uploader = uploaderLink.text().trim() || "anonymous";
    }

    let uploadDate = null;
    const timeEl = $row.find("time").first();
    if (timeEl.length) {
      uploadDate = timeEl.text().trim();
    }

    const features = {
      hd: $row.find('img[src*="hd.gif"]').length > 0,
      hearingImpaired:
        $row.find('img[src*="hearing_impaired.gif"]').length > 0,
      trusted:
        $row.find('img[src*="from_trusted.gif"]').length > 0,
    };

    let filename = null;
    const span = $row.find("span[title]").first();
    if (span.length) filename = span.attr("title") || null;

    results.push({
      id,
      title,
      year,
      language,
      downloads,
      uploader,
      uploadDate,
      filename,
      features,
    });
  });

  return results;
}

async function searchSubtitles(q) {
  if (!q) throw new Error("Query is required");

  const searchUrl = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${encodeURIComponent(q)}`;

  const response = await axios.get(searchUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });

  const html = response.data;

  const results = parseSubtitleSearch(html);

  results.sort((a, b) => b.downloads - a.downloads);

  return {
    query: q,
    language: "all",
    total: results.length,
    results,
  };
}

function filterByLanguage(searchData, lang) {
  if (!lang) return searchData;

  const filtered = searchData.results.filter(
    (item) => item.language.toLowerCase() === lang.toLowerCase()
  );

  return {
    query: searchData.query,
    language: lang,
    total: filtered.length,
    results: filtered,
  };
}

async function downloadSubtitleFile(id) {
  const urls = [
    `https://dl.opensubtitles.org/en/download/sub/${id}`,
    `https://www.opensubtitles.org/en/subtitleserve/sub/${id}`,
  ];

  for (const url of urls) {
    try {
      const response = await axios({
        method: "get",
        url,
        responseType: "arraybuffer",
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "*/*",
          Referer: "https://www.opensubtitles.org/",
        },
        maxRedirects: 5,
        timeout: 15000,
      });

      const buffer = Buffer.from(response.data);
      const sample = buffer.slice(0, 200).toString();

      if (sample.includes("<!DOCTYPE") || sample.includes("<html")) {
        continue;
      }

      let ext = "srt";
      const contentDisposition = response.headers["content-disposition"];

      if (contentDisposition) {
        const match = contentDisposition.match(/filename="?([^";]+)"?/);
        if (match) {
          const fname = match[1];
          const parts = fname.split(".");
          if (parts.length > 1) ext = parts.pop();
        }
      }

      return { buffer, ext };
    } catch (err) {
      console.log(`Failed URL ${url}`);
    }
  }

  throw new Error("All download URLs failed");
}

// ------------------------------------------------------------
// Express routes
// ------------------------------------------------------------

// Home
app.get('/', (req, res) => {
  res.send(`
    <h1>OpenSubtitles Proxy</h1>
    <p>Use <code>/search?q=</code> to search subtitles.</p>
    <p>Use <code>/download/:id</code> to download a subtitle file.</p>
  `);
});

// Search endpoint
app.get('/search', async (req, res) => {
  const query = req.query.q;
  const lang = req.query.lang; // optional language filter, e.g. ?q=inception&lang=en

  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter "q"' });
  }

  try {
    const searchResult = await searchSubtitles(query);
    const finalResult = lang ? filterByLanguage(searchResult, lang) : searchResult;
    res.json(finalResult);
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: 'Failed to fetch subtitles' });
  }
});

// Download endpoint
app.get('/download/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const { buffer, ext } = await downloadSubtitleFile(id);
    const filename = `subtitle_${id}.${ext}`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(buffer);
  } catch (error) {
    console.error('Download error:', error.message);
    res.status(500).json({ error: 'Failed to download subtitle file' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
