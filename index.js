const express = require("express");
const YTDlpWrap = require("yt-dlp-wrap").default;
const path = require("path");
const fs = require("fs");

const app = express();
const port = process.env.PORT || 3000;

// ---------------------------
// CONFIGURATION
// ---------------------------

const CONFIG = {
  binaryPath: "/usr/local/bin/yt-dlp",
  extractTimeout: 30000,        // 30 seconds
  cacheTTL: 1800000,            // 30 minutes
  maxRetries: 2,
  retryDelay: 2000
};

// Initialize YT-DLP
const ytdlpWrap = new YTDlpWrap();
ytdlpWrap.setBinaryPath(CONFIG.binaryPath);

// In-memory cache
const cache = new Map();

// ---------------------------
// PLATFORM DEFINITIONS
// ---------------------------

const PLATFORMS = {
  youtube: {
    detect: url => /youtube\.com|youtu\.be|music\.youtube\.com/i.test(url),
    format: "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
    cookiesFile: "youtube-cookies.txt",
    extraArgs: ["--no-playlist", "--no-cache-dir", "--geo-bypass"]
  },

  instagram: {
    detect: url => /instagram\.com|instagr\.am/i.test(url),
    format: "best[vcodec^=avc1]/best",
    cookiesFile: "instagram-cookies.txt",
    extraArgs: ["--no-check-certificate"]
  },

  tiktok: {
    detect: url => /tiktok\.com/i.test(url),
    format: "best[vcodec^=h264]/best",
    cookiesFile: "tiktok-cookies.txt",
    extraArgs: []
  },

  facebook: {
    detect: url => /facebook\.com|fb\.watch/i.test(url),
    format: "best",
    cookiesFile: "facebook-cookies.txt",
    extraArgs: ["--no-check-certificate"]
  }
};

// ---------------------------
// HELPER FUNCTIONS
// ---------------------------

function detectPlatform(url) {
  for (const [name, cfg] of Object.entries(PLATFORMS)) {
    if (cfg.detect(url)) return name;
  }
  return null;
}

function getPlatformArgs(platform) {
  const cfg = PLATFORMS[platform];
  if (!cfg) return [];

  const args = [...cfg.extraArgs];
  const cookiePath = path.resolve(__dirname, cfg.cookiesFile);

  if (fs.existsSync(cookiePath)) {
    args.push("--cookies", cookiePath);
  }

  return args;
}

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function retryOperation(operation) {
  let lastErr;
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      console.log(`⚠️ Attempt ${attempt}/${CONFIG.maxRetries} failed: ${err.message}`);
      if (attempt < CONFIG.maxRetries) await sleep(CONFIG.retryDelay * attempt);
    }
  }
  throw lastErr;
}

// ---------------------------
// CORE EXTRACTION LOGIC
// ---------------------------

async function extractMetadata(videoUrl) {
  const platform = detectPlatform(videoUrl);
  if (!platform) throw new Error("Unsupported platform");

  // cache check
  const cached = cache.get(videoUrl);
  if (cached && Date.now() - cached.timestamp < CONFIG.cacheTTL) {
    console.log(`✅ Cache Hit for: ${videoUrl}`);
    return cached.metadata;
  }

  console.log(`📥 Extracting: ${videoUrl} [${platform}]`);

  const platformArgs = getPlatformArgs(platform);

  const args = [
    videoUrl,
    "--dump-json",
    "--no-warnings",
    "--no-playlist",
    "--skip-download",
    ...platformArgs
  ];

  const stdout = await retryOperation(() =>
    Promise.race([
      ytdlpWrap.execPromise(args),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Extraction timed out (30s)")), CONFIG.extractTimeout)
      )
    ])
  );

  if (!stdout) throw new Error("Empty extractor output");

  const meta = JSON.parse(stdout);
  const resolution =
    meta.width && meta.height
      ? `${meta.width}x${meta.height}`
      : meta.format_note || "unknown";

  const metadata = {
    title: meta.title || "Unknown Title",
    author: meta.uploader || meta.channel || "Unknown Author",
    thumbnail: meta.thumbnail || null,
    duration: meta.duration || 0,
    platform: platform,
    videoId: meta.id,
    originalUrl: videoUrl,
    streamUrl: meta.url,
    filesize: meta.filesize_approx || meta.filesize || null,
    resolution,
    format: meta.ext || "mp4"
  };

  cache.set(videoUrl, { metadata, timestamp: Date.now() });
  cache.set(meta.id, { metadata, timestamp: Date.now(), originalUrl: videoUrl });

  return metadata;
}

// ---------------------------
// ROUTES
// ---------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    platform: process.platform,
    cacheSize: cache.size,
    uptime: process.uptime()
  });
});

app.get("/extract", async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).json({ error: "Missing 'url'" });

  try {
    const data = await extractMetadata(videoUrl);
    res.json(data);
  } catch (err) {
    console.error("❌ Extract Error:", err.message);
    let code = 500;
    if (err.message.includes("Unsupported")) code = 400;
    if (err.message.includes("timed out")) code = 504;

    res.status(code).json({
      error: "Extraction failed",
      details: err.message
    });
  }
});

app.get("/download", async (req, res) => {
  const videoId = req.query.vid;
  if (!videoId) return res.status(400).json({ error: "Missing 'vid'" });

  const cached = cache.get(videoId);
  if (!cached) {
    return res.status(404).json({ error: "Video ID expired or missing" });
  }

  const { originalUrl, metadata } = cached;
  const platform = detectPlatform(originalUrl);
  const cfg = PLATFORMS[platform];
  const platformArgs = getPlatformArgs(platform);

  console.log(`⬇️ Streaming: ${metadata.title}`);

  const filename = metadata.title.replace(/[^a-z0-9]/gi, "_").substring(0, 50);

  res.setHeader("Content-Disposition", `attachment; filename="${filename}.${metadata.format}"`);
  res.setHeader("Content-Type", "video/mp4");

  const streamArgs = [
    originalUrl,
    "-o", "-",
    "-f", cfg.format,
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    ...platformArgs
  ];

  const ytdlp = ytdlpWrap.exec(streamArgs);

  ytdlp.stdout.pipe(res);
  ytdlp.stderr.on("data", d => {
    const msg = d.toString();
    if (msg.includes("ERROR") || msg.includes("WARNING")) {
      console.error("[Stream Error]:", msg);
    }
  });

  ytdlp.on("close", code => {
    if (code !== 0) console.log(`Stream closed with code ${code}`);
    res.end();
  });

  req.on("close", () => {
    if (ytdlp.ytDlpProcess && !ytdlp.ytDlpProcess.killed) {
      ytdlp.ytDlpProcess.kill();
      console.log("🛑 Client disconnected, download killed.");
    }
  });
});

// ---------------------------
// STARTUP
// ---------------------------

async function initializeApp() {
  console.log("🔧 Starting Video Extractor...");

  try {
    if (!fs.existsSync(CONFIG.binaryPath)) {
      throw new Error(`yt-dlp binary missing at ${CONFIG.binaryPath}`);
    }

    const version = await ytdlpWrap.execPromise(["--version"]);
    console.log(`✅ yt-dlp version: ${version.trim()}`);

    console.log("🚀 Server running on port", port);
    app.listen(port);
  } catch (err) {
    console.error("❌ Startup Error:", err.message);
    process.exit(1);
  }
}

initializeApp();
