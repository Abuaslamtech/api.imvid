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
  extractTimeout: 120000,
  cacheTTL: 1800000, 
  cacheCleanupInterval: 300000, 
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
      "--extractor-args", 
      "youtube:player_client=android,web", 
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

  if (fs.existsSync(cookiePath)) {
    args.push("--cookies", cookiePath);
  }

  return args;
}

// REPLACE your current getAvailableFormats function with this complete version

async function getAvailableFormats(videoUrl, platform) {
  const platformArgs = getPlatformArgs(platform);

  const args = [
    videoUrl,
    "-J",
    "--no-warnings",
    "--no-playlist",
    ...platformArgs,
  ];

  try {
    const stdout = await ytdlpWrap.execPromise(args);
    const data = JSON.parse(stdout);

    if (!data.formats || !Array.isArray(data.formats)) {
      console.warn("⚠️ No formats array found in response");
      return [];
    }

    console.log(`📊 Total formats found: ${data.formats.length}`);

    // Filter for video formats
    const videoFormats = data.formats.filter((format) => {
      return (
        format.vcodec &&
        format.vcodec !== "none" &&
        format.height &&
        format.height > 0
      );
    });

    console.log(`📊 Video formats after filtering: ${videoFormats.length}`);

    if (videoFormats.length === 0) {
      console.warn("⚠️ No suitable video formats found");
      return [];
    }

    // Group by resolution, keeping best quality for each
    const formatMap = new Map();

    for (const format of videoFormats) {
      // Use the SHORTER dimension for quality detection (handles portrait videos)
      const width = format.width || 0;
      const height = format.height || 0;
      const qualityDimension = Math.min(width, height);
      const resolutionKey = `${qualityDimension}p`;

      const hasAudio = format.acodec && format.acodec !== "none";

      const formatInfo = {
        formatId: format.format_id,
        height: format.height,
        width: format.width || null,
        qualityDimension: qualityDimension, // Store for quality naming
        ext: format.ext || "mp4",
        filesize: format.filesize || format.filesize_approx || null,
        hasAudio: hasAudio,
        tbr: format.tbr || null,
        vbr: format.vbr || null,
      };

      if (!formatMap.has(resolutionKey)) {
        formatMap.set(resolutionKey, formatInfo);
      } else {
        const existing = formatMap.get(resolutionKey);

        // Prefer formats WITH audio
        if (hasAudio && !existing.hasAudio) {
          formatMap.set(resolutionKey, formatInfo);
        }
        // If both have same audio status, prefer higher bitrate
        else if (hasAudio === existing.hasAudio) {
          const currentBr = formatInfo.tbr || formatInfo.vbr || 0;
          const existingBr = existing.tbr || existing.vbr || 0;
          if (currentBr > existingBr) {
            formatMap.set(resolutionKey, formatInfo);
          }
        }
      }
    }

    // Convert to array and sort by resolution (highest first)
    const uniqueFormats = Array.from(formatMap.values())
      .sort((a, b) => (b.qualityDimension || 0) - (a.qualityDimension || 0))
      .map((f) => {
        // Use qualityDimension (shorter side) for quality naming
        const dimension = f.qualityDimension;

        let qualityName = "";
        if (dimension >= 2160) qualityName = "4K";
        else if (dimension >= 1440) qualityName = "2K";
        else if (dimension >= 1080) qualityName = "Full HD";
        else if (dimension >= 720) qualityName = "HD";
        else qualityName = "SD";

        return {
          formatId: f.formatId,
          ext: f.ext,
          quality: `${dimension}p`, // Use shorter dimension: "720p", "540p", "480p"
          hasAudio: f.hasAudio,
          filesize: f.filesize,
          label: qualityName,
        };
      });

    console.log(`✅ Final unique formats: ${uniqueFormats.length}`);
    uniqueFormats.forEach((f) => {
      console.log(`   - ${f.label} (${f.quality}) [ID: ${f.formatId}]`);
    });

    return uniqueFormats;
  } catch (err) {
    console.error("❌ Error fetching formats:", err.message);
    console.error("Stack:", err.stack);
    return [];
  }
}

// Helper function to format filesize
function formatFilesize(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  return `${(mb / 1024).toFixed(2)} GB`;
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

  // Get available formats
  const availableFormats = await getAvailableFormats(videoUrl, platform);

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
    availableFormats: availableFormats, // Add this
  };

  const cacheEntry = {
    metadata,
    timestamp: Date.now(),
    originalUrl: videoUrl,
  };

  cache.set(videoUrl, cacheEntry);
  cache.set(meta.id, cacheEntry);

  return metadata;
}

// ADD new endpoint for getting formats (add after /extract route)

app.get("/formats", async (req, res) => {
  const videoId = req.query.vid;

  if (!videoId) {
    return res.status(400).json({ error: "Missing 'vid' parameter" });
  }

  const cached = cache.get(videoId);
  if (!cached || !cached.metadata) {
    return res.status(404).json({ error: "Video ID not found or expired" });
  }

  const { availableFormats } = cached.metadata;

  if (!availableFormats || availableFormats.length === 0) {
    return res.status(404).json({ error: "No formats available" });
  }

  res.json({ formats: availableFormats });
});

// ---------------------------
// PREVIEW GENERATION (WITH CONCURRENCY CONTROL)
// ---------------------------

async function generatePreviewFile(videoUrl, platform, videoId) {
  const platformArgs = getPlatformArgs(platform);
  const { duration } = CONFIG.preview;

  const tempDir = os.tmpdir();
  const previewPath = path.join(
    tempDir,
    `preview_${videoId}_${Date.now()}.mp4`
  );

  const previewFormat =
    "worstvideo[ext=mp4][vcodec^=avc1][height<=480]+worstaudio[ext=m4a]/worst[ext=mp4][height<=480]/worst";

  return new Promise((resolve, reject) => {
    const ytdlpArgs = [
      videoUrl,
      "-o",
      "-",
      "-f",
      previewFormat,
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
      "-t",
      String(duration),
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "-y",
      previewPath,
    ];

    const ytdlp = spawn(CONFIG.binaryPath, ytdlpArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ffmpeg = spawn(CONFIG.ffmpegPath, ffmpegArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let hasErrored = false;
    let errorMsg = "";

    // Pipe + EPIPE protection
    const pipeStream = ytdlp.stdout.pipe(ffmpeg.stdin);

    pipeStream.on("error", (err) => {
      if (err.code === "EPIPE") return; // common when ffmpeg closes early after -t
      console.error("Pipe error:", err);
    });

    ytdlp.stdout.on("error", (err) => {
      if (err.code === "EPIPE") return;
      console.error("yt-dlp stdout error:", err);
    });

    ffmpeg.stdin.on("error", (err) => {
      if (err.code === "EPIPE") return;
      console.error("ffmpeg stdin error:", err);
    });

    ytdlp.stderr.on("data", (d) => (errorMsg += d.toString()));
    ffmpeg.stderr.on("data", (d) => (errorMsg += d.toString()));

    const fail = (err) => {
      if (hasErrored) return;
      hasErrored = true;
      killProcess(ytdlp, "yt-dlp");
      killProcess(ffmpeg, "ffmpeg");
      reject(err);
    };

    ytdlp.on("error", (e) =>
      fail(new Error(`yt-dlp spawn error: ${e.message}`))
    );
    ffmpeg.on("error", (e) =>
      fail(new Error(`ffmpeg spawn error: ${e.message}`))
    );

    ytdlp.on("close", (code) => {
      // If ffmpeg already succeeded and we resolved, don't reject here
      if (hasErrored) return;

      if (code !== 0) {
        fail(new Error(`yt-dlp failed (${code}): ${errorMsg}`));
      }
    });

    ffmpeg.on("close", (code) => {
      if (hasErrored) return;

      if (code === 0 && fs.existsSync(previewPath)) {
        // ✅ IMPORTANT: stop yt-dlp once we have enough preview
        killProcess(ytdlp, "yt-dlp");
        return resolve(previewPath);
      }

      fail(new Error(`ffmpeg failed (${code}): ${errorMsg}`));
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
  if (!videoUrl)
    return res.status(400).json({ error: "Missing 'url' parameter" });
  if (!validateUrl(videoUrl))
    return res.status(400).json({ error: "Invalid URL format" });

  try {
    const data = await extractMetadata(videoUrl);

    // 🔥 Warm preview in background (fast because it's -c copy)
    getOrGeneratePreview(data.videoId, data.originalUrl, data.platform).catch(
      () => {}
    );

    res.json({
      ...data,
      previewUrl: `/preview?vid=${data.videoId}`,
      downloadUrl: `/download?vid=${data.videoId}`,
      previewType: "video/mp4",
      previewDuration: CONFIG.preview.duration,
    });
  } catch (err) {
    res.status(500).json({ error: "Extraction failed", details: err.message });
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
  const formatId = req.query.format;

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

  let formatString;

  if (formatId) {
    // User selected specific format
    // Check if the selected format has audio
    const selectedFormat = metadata.availableFormats?.find(
      (f) => f.formatId === formatId
    );

    if (selectedFormat && selectedFormat.hasAudio) {
      // Format already has audio, use it directly
      formatString = formatId;
      console.log(
        `⬇️ Streaming format ${formatId} (with audio): ${metadata.title}`
      );
    } else {
      // Format is video-only, merge with best audio
      formatString = `${formatId}+bestaudio[ext=m4a]/bestaudio/best`;
      console.log(`⬇️ Streaming format ${formatId} + audio: ${metadata.title}`);
    }
  } else {
    // Use default platform format
    formatString = cfg.format;
    console.log(`⬇️ Streaming (default quality): ${metadata.title}`);
  }

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
    formatString,
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
