const express = require("express");
const YTDlpWrap = require("yt-dlp-wrap").default;
const path = require("path");
const fs = require("fs").promises;
const app = express();
const port = process.env.PORT || 3000;

// Fix: Use consistent binary naming
const binaryName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
const ytdlpPath = path.resolve(__dirname, binaryName);
const ytdlpWrap = new YTDlpWrap();
const cookiesPath = path.resolve(__dirname, "youtube-cookies.txt");

// Simple metadata cache (no URLs - they expire)
const metadataCache = new Map();
const urlToIdCache = new Map(); // Map videoId back to URL for downloads
const CACHE_TTL = 1800000; // 30 minutes (shorter for metadata)

// Simplified platform config
const PLATFORM_CONFIG = {
  youtube: {
    format: "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    extraArgs: [
      "--no-check-certificate",
      "--extractor-retries", "5",
      "--fragment-retries", "5",
      "--retry-sleep", "3",
    ],
  },
  instagram: {
    format: "best",
    extraArgs: [],
  },
  tiktok: {
    format: "best",
    extraArgs: [],
  },
  facebook: {
    format: "best",
    extraArgs: [],
  },
};

async function checkCookies() {
  try {
    await fs.access(cookiesPath);
    console.log("✅ YouTube cookies file found");
    PLATFORM_CONFIG.youtube.extraArgs.push("--cookies", cookiesPath);
    return true;
  } catch {
    console.warn("⚠️  No YouTube cookies found");
    console.warn("   For age-restricted videos, export cookies to youtube-cookies.txt");
    return false;
  }
}

function detectPlatform(url) {
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("tiktok.com")) return "tiktok";
  if (url.includes("facebook.com") || url.includes("fb.watch")) return "facebook";
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
      apiVersion: "2.0.0",
    });
  } catch (error) {
    res.status(500).json({
      error: "Could not get yt-dlp version",
      details: error.message,
    });
  }
});

// Extract metadata with stream URLs
app.get("/extract", async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl) {
    return res.status(400).json({ error: "URL query parameter is required" });
  }

  try {
    const platform = detectPlatform(videoUrl);
    if (!platform) {
      return res.status(400).json({
        error: "Unsupported platform. Supported: YouTube, Instagram, TikTok, Facebook",
      });
    }

    // Check cache first
    const cached = getCached(videoUrl);
    if (cached) {
      console.log(`✅ Serving ${platform} metadata from cache`);
      return res.json(cached);
    }

    console.log(`📥 Extracting ${platform} metadata...`);

    const config = PLATFORM_CONFIG[platform];
    const args = [
      videoUrl,
      "-f", config.format,
      "--dump-json",
      "--no-warnings",
      ...config.extraArgs,
    ];

    const stdout = await ytdlpWrap.execPromise(args);
    const metadata = JSON.parse(stdout);

    // Get the selected format info
    let selectedFormat = null;
    let streamUrl = null;
    let filesize = null;
    let resolution = "unknown";

    // Check if this is a merged format (requested_formats exists)
    if (metadata.requested_formats && metadata.requested_formats.length > 0) {
      // For merged formats, get video component for quality info
      const videoFormat = metadata.requested_formats.find(f => f.vcodec && f.vcodec !== "none");
      const audioFormat = metadata.requested_formats.find(f => f.acodec && f.acodec !== "none");
      
      selectedFormat = videoFormat || metadata.requested_formats[0];
      streamUrl = metadata.url || selectedFormat?.url || null;
      
      // Sum filesizes if both video and audio present
      filesize = (videoFormat?.filesize || videoFormat?.filesize_approx || 0) + 
                 (audioFormat?.filesize || audioFormat?.filesize_approx || 0) || null;
      
      resolution = videoFormat?.height ? `${videoFormat.height}p` : "unknown";
    } else {
      // Single format
      selectedFormat = metadata;
      streamUrl = metadata.url || null;
      filesize = metadata.filesize || metadata.filesize_approx || null;
      resolution = metadata.height ? `${metadata.height}p` : "unknown";
    }

    const videoId = metadata.id || metadata.video_id || `vid_${Date.now()}`;

    const response = {
      title: metadata.title || "Unknown Title",
      author: metadata.uploader || metadata.channel || metadata.uploader_id || "Unknown Author",
      thumbnail: metadata.thumbnail || null,
      duration: metadata.duration || 0,
      platform: platform,
      videoId: videoId,
      streamUrl: streamUrl,
      downloadUrl: `/download?vid=${videoId}`,
      filesize: filesize,
      resolution: resolution,
      format: metadata.ext || "mp4",
    };

    setCached(videoUrl, response);
    
    // Store videoId to URL mapping for downloads
    urlToIdCache.set(videoId, videoUrl);
    
    res.json(response);
  } catch (error) {
    console.error("Extract error:", error.message);

    let errorMsg = "Failed to fetch video information";
    if (error.message.includes("Sign in") || error.message.includes("bot")) {
      errorMsg = "Video may be age-restricted or require authentication. Add cookies file.";
    } else if (error.message.includes("Private video")) {
      errorMsg = "This video is private and cannot be accessed.";
    } else if (error.message.includes("Video unavailable") || error.message.includes("not available")) {
      errorMsg = "Video is unavailable or has been removed.";
    } else if (error.message.includes("429") || error.message.includes("Too Many Requests")) {
      errorMsg = "Rate limited. Please try again in a few moments.";
    }

    res.status(500).json({
      error: errorMsg,
      details: error.message,
      platform: detectPlatform(videoUrl),
    });
  }
});

// Stream video directly to client using videoId
app.get("/download", async (req, res) => {
  const videoId = req.query.vid;

  if (!videoId) {
    return res.status(400).json({ error: "vid query parameter required" });
  }

  try {
    // Get URL from videoId cache
    const videoUrl = urlToIdCache.get(videoId);

    if (!videoUrl) {
      return res.status(404).json({ 
        error: "Video not found. Please call /extract first to get video metadata.",
        videoId: videoId 
      });
    }

    const platform = detectPlatform(videoUrl);
    const cachedData = getCached(videoUrl);
    
    console.log(`⬇️  Streaming ${platform} video: ${videoId}`);

    const config = PLATFORM_CONFIG[platform];
    const args = [
      videoUrl,
      "-f", config.format,
      "-o", "-", // Output to stdout
      "--no-warnings",
      "--quiet",
      ...config.extraArgs,
    ];

    const filename = `${(cachedData?.title || "video").replace(/[^a-z0-9]/gi, "_").substring(0, 50)}.mp4`;

    // Set headers
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    // Start yt-dlp process
    const ytdlpProcess = ytdlpWrap.exec(args);

    // Pipe stdout to response
    ytdlpProcess.stdout.pipe(res);

    // Handle errors
    ytdlpProcess.on("error", (error) => {
      console.error("Download process error:", error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Download failed", details: error.message });
      }
    });

    ytdlpProcess.stderr.on("data", (data) => {
      const errorMsg = data.toString();
      if (errorMsg.includes("ERROR") || errorMsg.includes("WARNING")) {
        console.error("yt-dlp stderr:", errorMsg);
      }
    });

    ytdlpProcess.on("close", (code) => {
      if (code !== 0) {
        console.error(`yt-dlp process exited with code ${code}`);
        if (!res.headersSent) {
          res.status(500).json({ error: "Download failed" });
        }
      } else {
        console.log("✅ Stream completed successfully");
      }
    });

    // Handle client disconnect
    req.on("close", () => {
      if (!ytdlpProcess.killed) {
        console.log("Client disconnected, killing yt-dlp process");
        ytdlpProcess.kill();
      }
    });

  } catch (error) {
    console.error("Download error:", error.message);
    
    if (!res.headersSent) {
      res.status(500).json({
        error: "Failed to download video",
        details: error.message,
      });
    }
  }
});

// Quick info endpoint (faster than extract, less data)
app.get("/info", async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl) {
    return res.status(400).json({ error: "URL query parameter is required" });
  }

  try {
    const args = [
      videoUrl,
      "--get-title",
      "--get-duration",
      "--get-thumbnail",
      "--no-warnings",
    ];

    const output = await ytdlpWrap.execPromise(args);
    const lines = output.trim().split("\n");

    res.json({
      title: lines[0] || "Unknown",
      duration: lines[1] || "Unknown",
      thumbnail: lines[2] || null,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch video info",
      details: error.message,
    });
  }
});

async function initializeApp() {
  try {
    console.log("🔧 Initializing Video Extractor API...");

    // Always download latest yt-dlp for YouTube compatibility
    console.log("⬇️  Downloading latest yt-dlp binary...");
    try {
      await YTDlpWrap.downloadFromGithub(
        ytdlpPath,
        process.env.GITHUB_TOKEN || undefined
      );
      console.log("✅ yt-dlp downloaded successfully");
    } catch (downloadError) {
      console.error("❌ Failed to download yt-dlp:", downloadError.message);

      // Check for existing binary
      try {
        await fs.access(ytdlpPath);
        console.warn("⚠️  Using existing yt-dlp binary (may be outdated)");
        console.warn("⚠️  YouTube downloads may fail with old versions");
        console.warn("⚠️  Set GITHUB_TOKEN env var to avoid rate limits");
      } catch {
        throw new Error(
          "No yt-dlp binary found and download failed.\n" +
          "Solutions:\n" +
          "1. Set GITHUB_TOKEN environment variable\n" +
          "2. Download yt-dlp manually to: " + ytdlpPath + "\n" +
          "3. Wait for GitHub rate limit reset (1 hour)"
        );
      }
    }

    // Make executable on Unix
    if (process.platform !== "win32") {
      await fs.chmod(ytdlpPath, 0o755).catch(() => {});
    }

    // Set binary path
    ytdlpWrap.setBinaryPath(ytdlpPath);

    // Verify yt-dlp works
    try {
      const version = await ytdlpWrap.execPromise(["--version"]);
      console.log(`✅ yt-dlp version: ${version.trim()}`);
    } catch (error) {
      throw new Error(`yt-dlp binary test failed: ${error.message}`);
    }

    // Check for cookies
    await checkCookies();

    // Start server
    app.listen(port, () => {
      console.log(`\n🚀 Video Extractor API running on port ${port}`);
      console.log(`📺 Supported: YouTube, Instagram, TikTok, Facebook`);
      console.log(`\n📍 Endpoints:`);
      console.log(`   GET /health              - Health check`);
      console.log(`   GET /version             - yt-dlp version info`);
      console.log(`   GET /extract?url={url}   - Full video metadata`);
      console.log(`   GET /info?url={url}      - Quick info only`);
      console.log(`   GET /download?url={url}  - Stream/download video`);
      console.log(`\n💡 Tips:`);
      console.log(`   - Set GITHUB_TOKEN to avoid download rate limits`);
      console.log(`   - Add youtube-cookies.txt for restricted videos`);
      console.log(`   - Videos stream directly (no disk storage needed)\n`);
    });

  } catch (error) {
    console.error("\n❌ Failed to initialize app:", error.message);
    console.error("\n🔍 Troubleshooting:");
    console.error("   1. Check internet connection");
    console.error("   2. Set GITHUB_TOKEN environment variable");
    console.error("   3. Manually download yt-dlp to:", ytdlpPath);
    console.error("   4. Wait for GitHub rate limit reset\n");
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("\n🛑 Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n🛑 Received SIGINT, shutting down gracefully...");
  process.exit(0);
});

initializeApp();