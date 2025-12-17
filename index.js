const express = require("express");
const YTDlpWrap = require("yt-dlp-wrap").default;
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const app = express();
const port = process.env.PORT || 3000;

// ---------------------------
// ENHANCED CONFIGURATION
// ---------------------------

const CONFIG = {
  binaryPath: "/usr/local/bin/yt-dlp",
  ffmpegPath: "/usr/bin/ffmpeg",
  extractTimeout: 45000, // Increased for proxy
  cacheTTL: 1800000,
  cacheCleanupInterval: 300000,
  maxRetries: 3, // Increased retries
  retryDelay: 3000, // Longer delay between retries
  preview: {
    duration: 5,
    startTime: 0,
    width: 480,
    crf: 28,
    preset: "ultrafast",
  },
  // Proxy configuration
  proxy: {
    enabled: process.env.USE_PROXY === "true",
    url: process.env.PROXY_URL || null, // e.g., "http://user:pass@proxy.example.com:8080"
    rotateOnError: true,
  },
  // User-Agent rotation
  userAgents: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  ],
};

const ytdlpWrap = new YTDlpWrap();
ytdlpWrap.setBinaryPath(CONFIG.binaryPath);

const cache = new Map();
let currentUserAgentIndex = 0;

// ---------------------------
// PLATFORM DEFINITIONS
// ---------------------------

const PLATFORMS = {
  youtube: {
    detect: (url) => /youtube\.com|youtu\.be|music\.youtube\.com/i.test(url),
    format: "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
    cookiesFile: "youtube-cookies.txt",
    extraArgs: [
      "--no-playlist",
      "--no-cache-dir",
      "--extractor-args", "youtube:player_client=android,web",
      // Add these to help bypass detection
      "--extractor-args", "youtube:skip=hls,dash",
    ],
    // Fallback to different extractors if main fails
    fallbackFormats: [
      "bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[ext=mp4][height<=720]",
      "worst[ext=mp4]/worst",
    ],
  },

  instagram: {
    detect: (url) => /instagram\.com|instagr\.am/i.test(url),
    format: "best[vcodec^=avc1]/best",
    cookiesFile: "instagram-cookies.txt",
    extraArgs: ["--no-check-certificate"],
  },

  tiktok: {
    detect: (url) => /tiktok\.com/i.test(url),
    format: "best[vcodec^=h264]/best",
    cookiesFile: "tiktok-cookies.txt",
    extraArgs: [],
  },

  facebook: {
    detect: (url) => /facebook\.com|fb\.watch/i.test(url),
    format: "best",
    cookiesFile: "facebook-cookies.txt",
    extraArgs: ["--no-check-certificate"],
  },
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

function getRotatedUserAgent() {
  const ua = CONFIG.userAgents[currentUserAgentIndex];
  currentUserAgentIndex = (currentUserAgentIndex + 1) % CONFIG.userAgents.length;
  return ua;
}

function getPlatformArgs(platform, attempt = 0) {
  const cfg = PLATFORMS[platform];
  if (!cfg) return [];

  const args = [...cfg.extraArgs];
  
  // Add proxy if enabled
  if (CONFIG.proxy.enabled && CONFIG.proxy.url) {
    args.push("--proxy", CONFIG.proxy.url);
  }
  
  // Add rotating user agent
  args.push("--user-agent", getRotatedUserAgent());
  
  // Add cookies if available
  const cookiePath = path.resolve(__dirname, cfg.cookiesFile);
  if (fs.existsSync(cookiePath)) {
    args.push("--cookies", cookiePath);
  }
  
  // Add sleep to avoid rate limiting
  if (platform === "youtube") {
    args.push("--sleep-requests", "1");
  }

  return args;
}

function validateUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function retryOperation(operation, context = {}) {
  let lastErr;
  
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      return await operation(attempt);
    } catch (err) {
      lastErr = err;
      const errMsg = err.message.toLowerCase();
      
      console.log(
        `⚠️ Attempt ${attempt}/${CONFIG.maxRetries} failed: ${err.message.substring(0, 100)}`
      );
      
      // Don't retry on certain errors
      if (
        errMsg.includes("video unavailable") ||
        errMsg.includes("private video") ||
        errMsg.includes("copyright")
      ) {
        console.log("❌ Non-retryable error detected");
        throw err;
      }
      
      if (attempt < CONFIG.maxRetries) {
        const delay = CONFIG.retryDelay * attempt;
        console.log(`⏳ Waiting ${delay}ms before retry...`);
        await sleep(delay);
      }
    }
  }
  
  throw lastErr;
}

function cleanupCache() {
  const now = Date.now();
  let removed = 0;
  
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CONFIG.cacheTTL) {
      cache.delete(key);
      removed++;
    }
  }
  
  if (removed > 0) {
    console.log(`🧹 Cleaned up ${removed} expired cache entries`);
  }
}

// ---------------------------
// CORE EXTRACTION LOGIC
// ---------------------------

async function extractMetadata(videoUrl) {
  const platform = detectPlatform(videoUrl);
  if (!platform) throw new Error("Unsupported platform");

  const cached = cache.get(videoUrl);
  if (cached && Date.now() - cached.timestamp < CONFIG.cacheTTL) {
    console.log(`✅ Cache Hit for: ${videoUrl}`);
    return cached.metadata;
  }

  console.log(`📥 Extracting: ${videoUrl} [${platform}]`);

  const result = await retryOperation(async (attempt) => {
    const platformArgs = getPlatformArgs(platform, attempt);

    const args = [
      videoUrl,
      "--dump-json",
      "--no-warnings",
      "--no-playlist",
      "--skip-download",
      ...platformArgs,
    ];

    console.log(`🔧 Attempt ${attempt} args:`, args.join(" "));

    const stdout = await Promise.race([
      ytdlpWrap.execPromise(args),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Extraction timed out")),
          CONFIG.extractTimeout
        )
      ),
    ]);

    if (!stdout) throw new Error("Empty extractor output");

    return stdout;
  });

  const meta = JSON.parse(result);
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
    format: meta.ext || "mp4",
  };

  const cacheEntry = { 
    metadata, 
    timestamp: Date.now(),
    originalUrl: videoUrl 
  };
  
  cache.set(videoUrl, cacheEntry);
  cache.set(meta.id, cacheEntry);

  return metadata;
}

// ---------------------------
// PREVIEW GENERATION
// ---------------------------

function killProcess(process, name) {
  if (process && !process.killed) {
    process.kill("SIGKILL");
    console.log(`🛑 Killed ${name} process`);
  }
}

async function streamMp4Preview(videoUrl, platform, res, req) {
  const platformArgs = getPlatformArgs(platform);
  const { startTime, duration, width, crf, preset } = CONFIG.preview;

  console.log(`🎬 Generating ${duration}s MP4 preview for ${platform}...`);

  const ytdlpArgs = [
    videoUrl,
    "-o",
    "-",
    "-f",
    "worst[ext=mp4]/worst[height<=480]/worst",
    "--no-playlist",
    "--no-warnings",
    "--force-ipv4",
    ...platformArgs,
  ];

  const ffmpegArgs = [
    "-i",
    "pipe:0",
    "-ss",
    String(startTime),
    "-t",
    String(duration),
    "-vf",
    `scale=${width}:-2`,
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-an",
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
    "pipe:1",
  ];

  const ytdlp = spawn(CONFIG.binaryPath, ytdlpArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const ffmpeg = spawn(CONFIG.ffmpegPath, ffmpegArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  ytdlp.on("error", (err) => {
    console.error("❌ yt-dlp spawn error:", err.message);
    killProcess(ffmpeg, "ffmpeg");
  });

  ffmpeg.on("error", (err) => {
    console.error("❌ ffmpeg spawn error:", err.message);
    killProcess(ytdlp, "yt-dlp");
  });

  ytdlp.stderr.on("data", (data) => {
    const msg = data.toString();
    if (msg.includes("ERROR") || msg.includes("WARNING")) {
      console.error("[yt-dlp]:", msg.trim());
    }
  });

  ffmpeg.stderr.on("data", (data) => {
    const msg = data.toString();
    if (msg.includes("Error") || msg.includes("Invalid")) {
      console.error("[ffmpeg]:", msg.trim());
    }
  });

  ytdlp.stdout.pipe(ffmpeg.stdin);

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("Accept-Ranges", "none");

  ffmpeg.stdout.pipe(res);

  ytdlp.stdout.on("error", (e) => {
    if (e.code !== "EPIPE") console.error("yt-dlp stdout error:", e);
  });

  ffmpeg.stdin.on("error", (e) => {
    if (e.code !== "EPIPE") console.error("ffmpeg stdin error:", e);
  });

  const cleanup = () => {
    killProcess(ytdlp, "yt-dlp");
    killProcess(ffmpeg, "ffmpeg");
  };

  ffmpeg.on("close", cleanup);
  ytdlp.on("close", () => killProcess(ffmpeg, "ffmpeg"));
  req.on("close", cleanup);
}

// ---------------------------
// ROUTES
// ---------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    platform: process.platform,
    cacheSize: cache.size,
    uptime: process.uptime(),
    proxyEnabled: CONFIG.proxy.enabled,
  });
});

app.get("/extract", async (req, res) => {
  const videoUrl = req.query.url;
  
  if (!videoUrl) {
    return res.status(400).json({ error: "Missing 'url' parameter" });
  }

  if (!validateUrl(videoUrl)) {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  try {
    const data = await extractMetadata(videoUrl);

    res.json({
      ...data,
      previewUrl: `/preview?vid=${data.videoId}`,
      downloadUrl: `/download?vid=${data.videoId}`,
      previewType: "video/mp4",
      previewDuration: CONFIG.preview.duration,
    });
  } catch (err) {
    let code = 500;
    const errMsg = err.message.toLowerCase();
    
    if (errMsg.includes("unsupported")) code = 400;
    if (errMsg.includes("timed out")) code = 504;
    if (errMsg.includes("not a bot") || errMsg.includes("sign in")) {
      code = 403;
    }

    console.error("❌ Extraction Error:", err.message);

    res.status(code).json({
      error: "Extraction failed",
      details: err.message,
      suggestion: code === 403 
        ? "YouTube bot detection triggered. Consider using YouTube API or proxy service."
        : null,
    });
  }
});

app.get("/preview", async (req, res) => {
  const videoId = req.query.vid;
  
  if (!videoId) {
    return res.status(400).json({ error: "Missing 'vid' parameter" });
  }

  const cached = cache.get(videoId);
  if (!cached || !cached.originalUrl) {
    return res.status(404).json({ error: "Video ID not found or expired" });
  }

  const { originalUrl } = cached;
  const platform = detectPlatform(originalUrl);
  
  if (!platform) {
    return res.status(400).json({ error: "Unsupported platform" });
  }

  try {
    await streamMp4Preview(originalUrl, platform, res, req);
  } catch (err) {
    console.error("Preview error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Preview generation failed" });
    }
  }
});

app.get("/download", async (req, res) => {
  const videoId = req.query.vid;
  
  if (!videoId) {
    return res.status(400).json({ error: "Missing 'vid' parameter" });
  }

  const cached = cache.get(videoId);
  if (!cached || !cached.originalUrl) {
    return res.status(404).json({ error: "Video ID not found or expired" });
  }

  const { originalUrl, metadata } = cached;
  const platform = detectPlatform(originalUrl);
  const cfg = PLATFORMS[platform];
  const platformArgs = getPlatformArgs(platform);

  console.log(`⬇️ Streaming: ${metadata.title}`);

  const filename = metadata.title
    .replace(/[^a-z0-9]/gi, "_")
    .substring(0, 50);

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}.${metadata.format}"`
  );
  res.setHeader("Content-Type", "video/mp4");

  const streamArgs = [
    originalUrl,
    "-o",
    "-",
    "-f",
    cfg.format,
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    ...platformArgs,
  ];

  try {
    const ytdlpProcess = spawn(CONFIG.binaryPath, streamArgs);

    ytdlpProcess.stdout.pipe(res);

    ytdlpProcess.stderr.on("data", (data) => {
      const msg = data.toString();
      if (msg.includes("ERROR")) {
        console.error("[Stream Error]:", msg);
      }
    });

    ytdlpProcess.on("close", (code) => {
      if (code !== 0) {
        console.log(`Stream closed with code ${code}`);
      }
    });

    ytdlpProcess.on("error", (err) => {
      console.error("❌ Spawn Error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to start download" });
      }
    });

    req.on("close", () => {
      killProcess(ytdlpProcess, "yt-dlp");
    });
  } catch (err) {
    console.error("❌ Download Error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Download failed", details: err.message });
    }
  }
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

    if (!fs.existsSync(CONFIG.ffmpegPath)) {
      console.warn(
        `⚠️ ffmpeg not found at ${CONFIG.ffmpegPath}. Previews will not work.`
      );
    }

    const version = await ytdlpWrap.execPromise(["--version"]);
    console.log(`✅ yt-dlp version: ${version.trim()}`);
    
    if (CONFIG.proxy.enabled) {
      console.log(`🌐 Proxy enabled: ${CONFIG.proxy.url ? 'Configured' : 'Not configured'}`);
    }

    setInterval(cleanupCache, CONFIG.cacheCleanupInterval);
    console.log(`🧹 Cache cleanup scheduled every ${CONFIG.cacheCleanupInterval / 1000}s`);

    console.log("🚀 Server running on port", port);
    app.listen(port);
  } catch (err) {
    console.error("❌ Startup Error:", err.message);
    process.exit(1);
  }
}

initializeApp();