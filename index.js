const express = require("express");
const YTDlpWrap = require("yt-dlp-wrap").default;
const path = require("path");
const fs = require("fs").promises;
const app = express();
const port = process.env.PORT || 3000;

const ytdlpPath = path.resolve(__dirname, "yt-dlp");
const ytdlpWrap = new YTDlpWrap();
const downloadDir = path.resolve(__dirname, "downloads");
const cookiesPath = path.resolve(__dirname, "youtube-cookies.txt");

// Simple in-memory cache with TTL
const metadataCache = new Map();
const CACHE_TTL = 3600000; // 1 hour

// Updated platform config with better YouTube handling
const PLATFORM_CONFIG = {
  youtube: {
    extraArgs: [
      "--extractor-args",
      "youtube:player_client=android,web,ios",
      "--user-agent",
      "com.google.android.youtube/19.09.37 (Linux; U; Android 13) gzip",
      "--no-check-certificate",
      "--extractor-retries",
      "3",
      "--fragment-retries",
      "3",
    ],
  },
  instagram: { format: "best", extraArgs: [] },
  tiktok: { format: "best", extraArgs: [] },
  facebook: { format: "best", extraArgs: [] },
};

async function ensureDownloadDir() {
  try {
    await fs.mkdir(downloadDir, { recursive: true });
  } catch (e) {
    console.error("Failed to create download dir:", e);
  }
}

async function checkCookies() {
  try {
    await fs.access(cookiesPath);
    console.log("✅ YouTube cookies file found");
    // Add cookies to YouTube config
    PLATFORM_CONFIG.youtube.extraArgs.push("--cookies", cookiesPath);
    return true;
  } catch {
    console.warn("⚠️ No YouTube cookies found. YouTube downloads may fail for age-restricted/private videos.");
    console.warn("   To fix: Export cookies to youtube-cookies.txt");
    return false;
  }
}

function detectPlatform(url) {
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("tiktok.com")) return "tiktok";
  if (url.includes("facebook.com") || url.includes("fb.watch"))
    return "facebook";
  return null;
}

function getCached(key) {
  const cached = metadataCache.get(key);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return cached.data;
  }
  metadataCache.delete(key);
  return null;
}

function setCached(key, data) {
  metadataCache.set(key, { data, time: Date.now() });
}

function getBestFormat(formats) {
  // Find best MP4 format with both audio and video
  return (
    formats
      .filter(
        (f) => f.ext === "mp4" && f.acodec !== "none" && f.vcodec !== "none"
      )
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0] ||
    formats.find((f) => f.ext === "mp4") || // Fallback to any MP4
    formats[0]
  ); // Last resort
}

function generateId() {
  return `vid_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Version check endpoint
app.get("/version", async (req, res) => {
  try {
    const version = await ytdlpWrap.execPromise(["--version"]);
    res.json({ 
      status: "ok",
      ytdlpVersion: version.trim(),
      apiVersion: "1.0.0"
    });
  } catch (error) {
    res.status(500).json({ 
      error: "Could not get yt-dlp version",
      details: error.message 
    });
  }
});

app.get("/extract", async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl) {
    return res.status(400).json({ error: "URL query parameter is required" });
  }

  try {
    const platform = detectPlatform(videoUrl);
    if (!platform) {
      return res.status(400).json({
        error:
          "Unsupported platform. Supported: YouTube, Instagram, TikTok, Facebook",
      });
    }

    // Check cache first
    const cached = getCached(videoUrl);
    if (cached) {
      console.log(`✅ Serving ${platform} from cache`);
      return res.json(cached);
    }

    console.log(`📥 Extracting ${platform} metadata...`);

    // Build args with platform-specific options
    const config = PLATFORM_CONFIG[platform];
    const args = [
      videoUrl,
      "--dump-json",
      "--no-warnings",
      ...config.extraArgs,
    ];

    // Fetch metadata using execPromise for better control
    const stdout = await ytdlpWrap.execPromise(args);
    const metadata = JSON.parse(stdout);

    const bestFormat = getBestFormat(metadata.formats || []);

    if (!bestFormat) {
      return res.status(500).json({ error: "No suitable format found" });
    }

    const videoId = metadata.id || metadata.video_id || generateId();

    const response = {
      title: metadata.title || "Unknown Title",
      author: metadata.uploader || metadata.channel || "Unknown Author",
      thumbnail: metadata.thumbnail || null,
      duration: metadata.duration || 0,
      platform: platform,
      videoId: videoId,
      streamUrl: bestFormat.url,
      downloadUrl: `/download?vid=${videoId}`,
      filesize: bestFormat.filesize || bestFormat.filesize_approx || null,
      resolution: `${bestFormat.height || "unknown"}p`,
      format: bestFormat.ext || "mp4",
    };

    setCached(videoUrl, response);
    res.json(response);

    // Pre-download in background (non-blocking)
    predownloadVideo(videoUrl, videoId, config).catch((err) =>
      console.error(`Background download failed for ${videoId}:`, err.message)
    );
  } catch (error) {
    console.error("Extract error:", error);

    // Provide more helpful error messages
    let errorMsg = "Failed to fetch video information";
    if (error.message.includes("bot")) {
      errorMsg =
        "YouTube bot detection triggered. Try using cookies or wait a moment.";
    } else if (error.message.includes("Sign in")) {
      errorMsg = "Video requires authentication or may be age-restricted. Add cookies file.";
    } else if (error.message.includes("Private video")) {
      errorMsg = "This video is private and cannot be accessed.";
    } else if (error.message.includes("Video unavailable")) {
      errorMsg = "Video is unavailable or has been removed.";
    }

    res.status(500).json({
      error: errorMsg,
      details: error.message,
      platform: detectPlatform(videoUrl),
    });
  }
});

// Background downloader (non-blocking)
async function predownloadVideo(videoUrl, videoId, platformConfig) {
  const filePath = path.join(downloadDir, `${videoId}.mp4`);

  try {
    // Check if already exists
    const exists = await fs.stat(filePath).catch(() => null);
    if (exists) {
      console.log(`✅ Video ${videoId} already downloaded`);
      return;
    }

    console.log(`⬇️ Starting background download: ${videoId}`);

    const args = [
      videoUrl,
      "-f",
      platformConfig.format || "bestvideo+bestaudio/best",
      "-o",
      filePath,
      "--quiet",
      "--no-warnings",
      ...platformConfig.extraArgs,
    ];

    await ytdlpWrap.execPromise(args);

    console.log(`✅ Download complete: ${videoId}`);
  } catch (error) {
    console.error(`❌ Download error for ${videoId}:`, error.message);
  }
}

// Serve downloaded files
app.get("/download", async (req, res) => {
  const videoId = req.query.vid;

  if (!videoId) {
    return res.status(400).json({ error: "vid query parameter required" });
  }

  const filePath = path.join(downloadDir, `${videoId}.mp4`);

  try {
    const stat = await fs.stat(filePath);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${videoId}.mp4"`
    );

    const stream = require("fs").createReadStream(filePath);
    stream.pipe(res);

    stream.on("error", (err) => {
      console.error("Stream error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream file" });
      }
    });
  } catch (error) {
    res.status(404).json({
      error: "Video not downloaded yet",
      message: "Try again in a few moments",
      videoId: videoId,
    });
  }
});

// Get download status
app.get("/status", async (req, res) => {
  const videoId = req.query.vid;

  if (!videoId) {
    return res.status(400).json({ error: "vid query parameter required" });
  }

  const filePath = path.join(downloadDir, `${videoId}.mp4`);

  try {
    const stat = await fs.stat(filePath);
    res.json({
      status: "ready",
      size: stat.size,
      videoId: videoId,
    });
  } catch (error) {
    res.json({
      status: "downloading",
      message: "File is being prepared",
      videoId: videoId,
    });
  }
});

// Cleanup old files (runs on startup and every 6 hours)
async function cleanupOldFiles() {
  try {
    const files = await fs.readdir(downloadDir);
    const now = Date.now();
    const maxAge = 24 * 3600 * 1000; // 24 hours

    let deletedCount = 0;
    for (const file of files) {
      const filePath = path.join(downloadDir, file);
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > maxAge) {
        await fs.unlink(filePath);
        deletedCount++;
      }
    }
    if (deletedCount > 0) {
      console.log(`🗑️ Deleted ${deletedCount} old file(s)`);
    }
  } catch (error) {
    console.error("Cleanup error:", error);
  }
}

async function initializeApp() {
  try {
    const binaryName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
    const binaryPath = path.join(__dirname, binaryName);

    // ALWAYS download latest version to handle YouTube policy changes
    console.log("⬇️  Downloading latest yt-dlp binary...");
    try {
      await YTDlpWrap.downloadFromGithub(
        ytdlpPath,
        process.env.GITHUB_TOKEN || undefined
      );
      console.log("✅ yt-dlp updated successfully");
    } catch (downloadError) {
      console.error("❌ Failed to download yt-dlp:", downloadError.message);
      
      // Check if we have existing binary as fallback
      const binaryExists = await fs.stat(binaryPath).catch(() => null);
      if (binaryExists) {
        console.warn("⚠️  Using existing yt-dlp binary (may be outdated)");
        console.warn("⚠️  Set GITHUB_TOKEN environment variable to avoid rate limits");
      } else {
        throw new Error(
          "Failed to download yt-dlp and no existing binary found. " +
          "Please set GITHUB_TOKEN environment variable or wait for GitHub rate limit reset."
        );
      }
    }

    // Make executable on Unix
    if (process.platform !== "win32") {
      await fs.chmod(binaryPath, 0o755).catch(() => {});
    }

    ytdlpWrap.setBinaryPath(ytdlpPath);
    await ensureDownloadDir();
    await checkCookies();

    // Cleanup old files on startup
    await cleanupOldFiles();

    app.listen(port, () => {
      console.log(`🚀 Video Extractor API running on port ${port}`);
      console.log(`📺 Supported: YouTube, Instagram, TikTok, Facebook`);
      console.log(`\nEndpoints:`);
      console.log(`  GET /health - Health check`);
      console.log(`  GET /version - Check yt-dlp version`);
      console.log(`  GET /extract?url={videoUrl} - Extract metadata`);
      console.log(`  GET /download?vid={videoId} - Download video`);
      console.log(`  GET /status?vid={videoId} - Check download status`);
      console.log(`\n💡 Tip: Set GITHUB_TOKEN env var to avoid rate limits`);
    });

    // Cleanup every 6 hours
    setInterval(cleanupOldFiles, 6 * 3600 * 1000);
  } catch (error) {
    console.error("❌ Failed to initialize app:", error.message);
    console.error("\nTroubleshooting:");
    console.error("1. Set GITHUB_TOKEN environment variable");
    console.error("2. Wait for GitHub rate limit reset");
    console.error("3. Check your internet connection");
    process.exit(1);
  }
}

initializeApp();