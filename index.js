const express = require("express");
const YTDlpWrap = require("yt-dlp-wrap").default;
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const os = require("os");
const { promisify } = require("util");
const unlinkAsync = promisify(fs.unlink);

const app = express();
const port = process.env.PORT || 3000;

// ---------------------------
// CONFIGURATION
// ---------------------------

const CONFIG = {
  binaryPath: "/usr/local/bin/yt-dlp",
  ffmpegPath: "/usr/bin/ffmpeg",
  extractTimeout: 30000,
  cacheTTL: 1800000, // 30 minutes
  cacheCleanupInterval: 300000, // 5 minutes
  maxRetries: 2,
  retryDelay: 2000,
  preview: {
    duration: 5,
    startTime: 0,
    width: 480,
    crf: 23,
    preset: "veryfast",
  },
};

const ytdlpWrap = new YTDlpWrap();
ytdlpWrap.setBinaryPath(CONFIG.binaryPath);

const cache = new Map(); // videoId/url -> { metadata, timestamp, originalUrl }
const previewCache = new Map(); // videoId -> { path, timestamp }
const pendingPreviews = new Map(); // videoId -> Promise (prevents concurrent generation)

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
      "--extractor-args",
      "youtube:player_client=android",
    ],
  },

  instagram: {
    detect: (url) => /instagram\.com|instagr\.am/i.test(url),
    format: "best[vcodec^=avc1]/best",
    cookiesFile: "instagram-cookies.txt",
    extraArgs: [
      "--no-check-certificate",
      "--user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ],
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

function getPlatformArgs(platform) {
  const cfg = PLATFORMS[platform];
  if (!cfg) return [];

  const args = [...cfg.extraArgs];
  const cookiePath = path.resolve(__dirname, cfg.cookiesFile);

  // if (fs.existsSync(cookiePath)) {
  //   args.push("--cookies", cookiePath);
  // }

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

async function retryOperation(operation) {
  let lastErr;
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      console.log(
        `⚠️ Attempt ${attempt}/${CONFIG.maxRetries} failed: ${err.message}`
      );
      if (attempt < CONFIG.maxRetries) await sleep(CONFIG.retryDelay * attempt);
    }
  }
  throw lastErr;
}

function killProcess(process, name) {
  if (process && !process.killed) {
    process.kill("SIGKILL");
    console.log(`🛑 Killed ${name} process`);
  }
}

// ---------------------------
// CACHE CLEANUP (SINGLE DEFINITION)
// ---------------------------

function cleanupCache() {
  const now = Date.now();
  let removed = 0;

  // Clean metadata cache
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CONFIG.cacheTTL) {
      cache.delete(key);
      removed++;
    }
  }

  // Clean preview files
  for (const [videoId, value] of previewCache.entries()) {
    if (now - value.timestamp > CONFIG.cacheTTL) {
      // Delete the file (async, non-blocking)
      if (fs.existsSync(value.path)) {
        fs.unlink(value.path, (err) => {
          if (err && err.code !== "ENOENT") {
            console.error(`Failed to delete preview: ${err.message}`);
          }
        });
      }
      previewCache.delete(videoId);
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

  const platformArgs = getPlatformArgs(platform);

  const args = [
    videoUrl,
    "--dump-json",
    "--no-warnings",
    "--no-playlist",
    "--skip-download",
    "--js-runtime",
    "deno",
    ...platformArgs,
  ];

  const stdout = await retryOperation(() =>
    Promise.race([
      ytdlpWrap.execPromise(args),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Extraction timed out (30s)")),
          CONFIG.extractTimeout
        )
      ),
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
    format: meta.ext || "mp4",
  };

  // Cache by both URL and ID with consistent structure
  const cacheEntry = {
    metadata,
    timestamp: Date.now(),
    originalUrl: videoUrl,
  };

  cache.set(videoUrl, cacheEntry);
  cache.set(meta.id, cacheEntry);

  return metadata;
}

// ---------------------------
// PREVIEW GENERATION (WITH CONCURRENCY CONTROL)
// ---------------------------

async function generatePreviewFile(videoUrl, platform, videoId) {
  const platformArgs = getPlatformArgs(platform);
  const { startTime, duration, width, crf, preset } = CONFIG.preview;

  // Use system temp directory with unique filename
  const tempDir = os.tmpdir();
  const previewPath = path.join(
    tempDir,
    `preview_${videoId}_${Date.now()}.mp4`
  );

  console.log(`🎬 Generating preview file for ${platform}...`);

  return new Promise((resolve, reject) => {
    const ytdlpArgs = [
      videoUrl,
      "-o",
      "-",
      "-f",
      "worst[ext=mp4]/worst[height<=480]/worst",
      "--no-playlist",
      "--no-warnings",
      "--force-ipv4",
      "--js-runtime",
      "deno",
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
      "-profile:v",
      "baseline",
      "-level",
      "3.0",
      "-an",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "-y", // Overwrite if exists
      previewPath,
    ];

    const ytdlp = spawn(CONFIG.binaryPath, ytdlpArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const ffmpeg = spawn(CONFIG.ffmpegPath, ffmpegArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Track process state
    let ytdlpExited = false;
    let ffmpegExited = false;
    let errorMsg = "";
    let hasErrored = false;

    // Pipe with EPIPE error handling
    const pipeStream = ytdlp.stdout.pipe(ffmpeg.stdin);

    pipeStream.on("error", (err) => {
      if (err.code === "EPIPE") {
        console.warn("⚠️ EPIPE detected (ffmpeg stdin closed early)");
        // Don't reject on EPIPE, wait for process exit
      } else {
        console.error("Pipe error:", err);
      }
    });

    // Handle ytdlp stdout errors (like EPIPE when ffmpeg dies)
    ytdlp.stdout.on("error", (err) => {
      if (err.code !== "EPIPE") {
        console.error("yt-dlp stdout error:", err);
      }
    });

    // Handle ffmpeg stdin errors
    ffmpeg.stdin.on("error", (err) => {
      if (err.code !== "EPIPE") {
        console.error("ffmpeg stdin error:", err);
      }
    });

    // Collect error messages
    ytdlp.stderr.on("data", (data) => {
      const msg = data.toString();
      console.log("[yt-dlp]:", msg.trim());
      if (msg.includes("ERROR")) {
        errorMsg += `[yt-dlp] ${msg}\n`;
      }
    });

    ffmpeg.stderr.on("data", (data) => {
      const msg = data.toString();
      // Only log actual errors, not ffmpeg progress
      if (msg.includes("Error") || msg.includes("Invalid")) {
        console.error("[ffmpeg]:", msg.trim());
        errorMsg += `[ffmpeg] ${msg}\n`;
      }
    });

    // yt-dlp exit handler
    ytdlp.on("close", (code) => {
      ytdlpExited = true;
      console.log(`yt-dlp exited with code: ${code}`);

      if (code !== 0 && !hasErrored) {
        hasErrored = true;
        killProcess(ffmpeg, "ffmpeg");
        reject(
          new Error(
            `yt-dlp failed with code ${code}: ${errorMsg || "Unknown error"}`
          )
        );
      }
    });

    ytdlp.on("error", (err) => {
      if (!hasErrored) {
        hasErrored = true;
        console.error("yt-dlp spawn error:", err);
        killProcess(ffmpeg, "ffmpeg");
        reject(new Error(`yt-dlp error: ${err.message}`));
      }
    });

    // ffmpeg exit handler
    ffmpeg.on("close", (code) => {
      ffmpegExited = true;
      console.log(`ffmpeg exited with code: ${code}`);

      if (hasErrored) return; // Already rejected

      if (code === 0 && fs.existsSync(previewPath)) {
        console.log(`✅ Preview generated: ${previewPath}`);
        resolve(previewPath);
      } else {
        killProcess(ytdlp, "yt-dlp");
        const fileExists = fs.existsSync(previewPath);
        reject(
          new Error(
            `Preview generation failed (code ${code}, file exists: ${fileExists}): ${
              errorMsg || "Unknown error"
            }`
          )
        );
      }
    });

    ffmpeg.on("error", (err) => {
      if (!hasErrored) {
        hasErrored = true;
        console.error("ffmpeg spawn error:", err);
        killProcess(ytdlp, "yt-dlp");
        reject(new Error(`ffmpeg error: ${err.message}`));
      }
    });
  });
}

// ---------------------------
// CONCURRENT-SAFE PREVIEW GETTER
// ---------------------------

async function getOrGeneratePreview(videoId, originalUrl, platform) {
  // Check if preview already exists and is valid
  const cachedPreview = previewCache.get(videoId);
  if (cachedPreview && fs.existsSync(cachedPreview.path)) {
    console.log(`✅ Using cached preview for ${videoId}`);
    return cachedPreview.path;
  }

  // Check if preview is already being generated
  if (pendingPreviews.has(videoId)) {
    console.log(`⏳ Waiting for ongoing preview generation: ${videoId}`);
    return await pendingPreviews.get(videoId);
  }

  // Start new preview generation
  const generationPromise = (async () => {
    try {
      const previewPath = await generatePreviewFile(
        originalUrl,
        platform,
        videoId
      );
      previewCache.set(videoId, {
        path: previewPath,
        timestamp: Date.now(),
      });
      return previewPath;
    } finally {
      // Clean up pending flag
      pendingPreviews.delete(videoId);
    }
  })();

  pendingPreviews.set(videoId, generationPromise);
  return await generationPromise;
}

// ---------------------------
// ROUTES
// ---------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    platform: process.platform,
    cacheSize: cache.size,
    previewCacheSize: previewCache.size,
    pendingPreviews: pendingPreviews.size,
    uptime: process.uptime(),
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
    if (err.message.includes("Unsupported")) code = 400;
    if (err.message.includes("timed out")) code = 504;

    res.status(code).json({
      error: "Extraction failed",
      details: err.message,
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

  console.log(`🎥 Preview request for ${videoId} (${platform})`);

  try {
    // Get or generate preview (concurrency-safe)
    const previewPath = await getOrGeneratePreview(
      videoId,
      originalUrl,
      platform
    );

    // Verify file still exists (serverless/Render safety check)
    if (!fs.existsSync(previewPath)) {
      console.warn(`⚠️ Preview file vanished: ${previewPath}. Regenerating...`);
      previewCache.delete(videoId);
      const newPath = await getOrGeneratePreview(
        videoId,
        originalUrl,
        platform
      );
      return serveVideoFile(newPath, req, res);
    }

    console.log(`📤 Serving preview: ${previewPath}`);
    serveVideoFile(previewPath, req, res);
  } catch (err) {
    console.error("❌ Preview error:", err.message);
    console.error("Stack:", err.stack);

    if (!res.headersSent) {
      res.status(500).json({
        error: "Preview generation failed",
        details: err.message,
        platform: platform,
        videoId: videoId,
      });
    }
  }
});

// Helper function to serve video with range support
function serveVideoFile(filePath, req, res) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunksize,
      "Content-Type": "video/mp4",
      "Cache-Control": "public, max-age=3600",
    });

    const stream = fs.createReadStream(filePath, { start, end });
    stream.pipe(res);

    stream.on("error", (err) => {
      console.error("Stream error:", err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);

    stream.on("error", (err) => {
      console.error("Stream error:", err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
  }
}

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

  const filename = metadata.title.replace(/[^a-z0-9]/gi, "_").substring(0, 50);

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

    // Start cache cleanup interval
    setInterval(cleanupCache, CONFIG.cacheCleanupInterval);
    console.log(
      `🧹 Cache cleanup scheduled every ${CONFIG.cacheCleanupInterval / 1000}s`
    );

    console.log("🚀 Server running on port", port);
    app.listen(port);
  } catch (err) {
    console.error("❌ Startup Error:", err.message);
    process.exit(1);
  }
}

initializeApp();
