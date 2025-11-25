const express = require("express");
const YTDlpWrap = require("yt-dlp-wrap").default;
const path = require("path");
const fs = require("fs").promises;
const fsSync = require("fs");
const https = require("https");
const { PassThrough } = require("stream");
const app = express();
const port = process.env.PORT || 3000;

// Fix: Use consistent binary naming
const binaryName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
const ytdlpPath = path.resolve(__dirname, binaryName);
const ytdlpWrap = new YTDlpWrap();
const cookiesPath = path.resolve(__dirname, "youtube-cookies.txt");

// Cache directories
const cacheDir = path.resolve(__dirname, "video_cache");
const metadataDir = path.resolve(__dirname, "metadata_cache");

// Download tracking
const downloadQueue = new Map(); // videoId -> { status, progress, error, filePath, process, streams }
const metadataCache = new Map(); // videoId -> metadata
const CACHE_TTL = 3600000; // 1 hour for metadata
const MAX_CACHE_SIZE_MB = 500; // Max 500MB of cached videos

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

// Initialize cache directories
async function initCacheDirs() {
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.mkdir(metadataDir, { recursive: true });
    console.log("✅ Cache directories initialized");
  } catch (err) {
    console.error("Failed to create cache directories:", err.message);
  }
}

// Clean old cache files
async function cleanCache() {
  try {
    const files = await fs.readdir(cacheDir);
    let totalSize = 0;
    const fileStats = [];

    for (const file of files) {
      const filePath = path.join(cacheDir, file);
      try {
        const stats = await fs.stat(filePath);
        totalSize += stats.size;
        fileStats.push({ path: filePath, size: stats.size, mtime: stats.mtime });
      } catch (err) {
        // Skip files we can't stat
        continue;
      }
    }

    const totalSizeMB = totalSize / (1024 * 1024);
    
    if (totalSizeMB > MAX_CACHE_SIZE_MB) {
      console.log(`🗑️  Cache size (${totalSizeMB.toFixed(2)}MB) exceeds limit. Cleaning...`);
      
      // Sort by oldest first
      fileStats.sort((a, b) => a.mtime - b.mtime);
      
      let removedSize = 0;
      for (const file of fileStats) {
        if (totalSizeMB - (removedSize / (1024 * 1024)) <= MAX_CACHE_SIZE_MB * 0.8) {
          break;
        }
        try {
          await fs.unlink(file.path);
          removedSize += file.size;
        } catch (err) {
          // Skip files we can't delete
          continue;
        }
      }
      
      console.log(`✅ Removed ${(removedSize / (1024 * 1024)).toFixed(2)}MB of old cache`);
    }
  } catch (err) {
    console.error("Cache cleanup error:", err.message);
  }
}

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

// Alternative download method using direct HTTPS request
async function downloadBinaryDirect(downloadPath) {
  const url = process.platform === "win32" 
    ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

  return new Promise((resolve, reject) => {
    console.log(`📥 Downloading from: ${url}`);
    
    const request = https.get(url, {
      headers: {
        'User-Agent': 'Node.js',
        ...(process.env.GITHUB_TOKEN && {
          'Authorization': `token ${process.env.GITHUB_TOKEN}`
        })
      }
    }, (response) => {
      // Handle redirects
      if (response.statusCode === 302 || response.statusCode === 301) {
        https.get(response.headers.location, (redirectResponse) => {
          const chunks = [];
          redirectResponse.on('data', (chunk) => chunks.push(chunk));
          redirectResponse.on('end', async () => {
            try {
              await fs.writeFile(downloadPath, Buffer.concat(chunks), { mode: 0o755 });
              console.log("✅ Download complete");
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        }).on('error', reject);
      } else {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', async () => {
          try {
            await fs.writeFile(downloadPath, Buffer.concat(chunks), { mode: 0o755 });
            console.log("✅ Download complete");
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      }
    });

    request.on('error', reject);
    request.setTimeout(30000, () => {
      request.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

function detectPlatform(url) {
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("tiktok.com")) return "tiktok";
  if (url.includes("facebook.com") || url.includes("fb.watch")) return "facebook";
  return null;
}

function getCachedMetadata(videoId) {
  const cached = metadataCache.get(videoId);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return cached.data;
  }
  metadataCache.delete(videoId);
  return null;
}

function setCachedMetadata(videoId, data) {
  metadataCache.set(videoId, { data, time: Date.now() });
}

// Background video download with streaming support
async function downloadVideoBackground(videoUrl, videoId, platform) {
  const config = PLATFORM_CONFIG[platform];
  const outputPath = path.join(cacheDir, `${videoId}.mp4`);
  const tempPath = path.join(cacheDir, `${videoId}.temp.mp4`);
  
  // Check if already downloaded
  try {
    await fs.access(outputPath);
    console.log(`✅ Video ${videoId} already cached`);
    downloadQueue.set(videoId, {
      status: "completed",
      progress: 100,
      filePath: outputPath,
      error: null,
      process: null,
      streams: [],
    });
    return outputPath;
  } catch {
    // File doesn't exist, proceed with download
  }

  // Create array to hold client streams
  const clientStreams = [];

  downloadQueue.set(videoId, {
    status: "downloading",
    progress: 0,
    filePath: null,
    error: null,
    process: null,
    streams: clientStreams,
  });

  const args = [
    videoUrl,
    "-f", config.format,
    "-o", tempPath,
    "--no-warnings",
    "--newline",
    ...config.extraArgs,
  ];

  return new Promise((resolve, reject) => {
    const ytdlpProcess = ytdlpWrap.exec(args);
    
    // Store process reference
    const queueData = downloadQueue.get(videoId);
    if (queueData) {
      queueData.process = ytdlpProcess;
    }
    
    ytdlpProcess.stdout.on("data", (data) => {
      const output = data.toString();
      
      // Parse progress from yt-dlp output
      const progressMatch = output.match(/(\d+\.\d+)%/);
      if (progressMatch) {
        const progress = parseFloat(progressMatch[1]);
        const queueData = downloadQueue.get(videoId);
        if (queueData) {
          queueData.progress = progress;
        }
      }
    });

    ytdlpProcess.stderr.on("data", (data) => {
      const errorMsg = data.toString();
      if (errorMsg.includes("ERROR")) {
        console.error(`Download error for ${videoId}:`, errorMsg);
      }
    });

    ytdlpProcess.on("close", async (code) => {
      if (code === 0) {
        // Move temp file to final location
        try {
          await fs.rename(tempPath, outputPath);
          console.log(`✅ Video ${videoId} downloaded successfully`);
          
          const queueData = downloadQueue.get(videoId);
          if (queueData) {
            queueData.status = "completed";
            queueData.progress = 100;
            queueData.filePath = outputPath;
            queueData.error = null;
            
            // Close all client streams
            queueData.streams.forEach(stream => {
              if (!stream.destroyed) {
                stream.end();
              }
            });
            queueData.streams = [];
          }
          
          // Clean cache if needed
          await cleanCache();
          
          resolve(outputPath);
        } catch (err) {
          console.error(`Failed to move temp file: ${err.message}`);
          reject(err);
        }
      } else {
        const error = `Download failed with code ${code}`;
        console.error(`❌ ${error}`);
        
        const queueData = downloadQueue.get(videoId);
        if (queueData) {
          queueData.status = "failed";
          queueData.progress = 0;
          queueData.filePath = null;
          queueData.error = error;
          
          // Close all client streams with error
          queueData.streams.forEach(stream => {
            if (!stream.destroyed) {
              stream.destroy(new Error(error));
            }
          });
          queueData.streams = [];
        }
        
        // Clean up temp file
        try {
          await fs.unlink(tempPath);
        } catch {}
        
        reject(new Error(error));
      }
    });

    ytdlpProcess.on("error", (error) => {
      console.error(`Download process error for ${videoId}:`, error.message);
      const queueData = downloadQueue.get(videoId);
      if (queueData) {
        queueData.status = "failed";
        queueData.progress = 0;
        queueData.filePath = null;
        queueData.error = error.message;
        
        // Close all client streams with error
        queueData.streams.forEach(stream => {
          if (!stream.destroyed) {
            stream.destroy(error);
          }
        });
        queueData.streams = [];
      }
      reject(error);
    });
  });
}

// Stream video directly from yt-dlp (for progressive download)
function streamVideoLive(videoUrl, platform, videoId) {
  const config = PLATFORM_CONFIG[platform];
  
  const args = [
    videoUrl,
    "-f", config.format,
    "-o", "-", // Output to stdout
    "--no-warnings",
    "--quiet",
    ...config.extraArgs,
  ];

  const ytdlpProcess = ytdlpWrap.exec(args);
  
  // Store process reference
  const queueData = downloadQueue.get(videoId);
  if (queueData) {
    queueData.process = ytdlpProcess;
  }
  
  return ytdlpProcess.stdout;
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
      apiVersion: "3.0.0",
    });
  } catch (error) {
    res.status(500).json({
      error: "Could not get yt-dlp version",
      details: error.message,
    });
  }
});

// Extract metadata and start background download
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
    let filesize = null;
    let resolution = "unknown";

    if (metadata.requested_formats && metadata.requested_formats.length > 0) {
      const videoFormat = metadata.requested_formats.find(f => f.vcodec && f.vcodec !== "none");
      const audioFormat = metadata.requested_formats.find(f => f.acodec && f.acodec !== "none");
      
      selectedFormat = videoFormat || metadata.requested_formats[0];
      
      filesize = (videoFormat?.filesize || videoFormat?.filesize_approx || 0) + 
                 (audioFormat?.filesize || audioFormat?.filesize_approx || 0) || null;
      
      resolution = videoFormat?.height ? `${videoFormat.height}p` : "unknown";
    } else {
      selectedFormat = metadata;
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
      downloadUrl: `/stream/${videoId}`, // Unified endpoint - always use progressive streaming
      streamUrl: `/stream/${videoId}`,    // Kept for compatibility
      statusUrl: `/status/${videoId}`,
      filesize: filesize,
      resolution: resolution,
      format: metadata.ext || "mp4",
    };

    setCachedMetadata(videoId, { ...response, originalUrl: videoUrl });
    
    // Start background download (non-blocking)
    downloadVideoBackground(videoUrl, videoId, platform).catch(err => {
      console.error(`Background download failed for ${videoId}:`, err.message);
    });
    
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

// Check download status
app.get("/status/:videoId", (req, res) => {
  const videoId = req.params.videoId;
  const status = downloadQueue.get(videoId);

  if (!status) {
    return res.status(404).json({
      error: "Video not found",
      message: "Call /extract first to start the download",
    });
  }

  res.json({
    videoId: videoId,
    status: status.status,
    progress: status.progress,
    error: status.error,
    ready: status.status === "completed",
  });
});

// Progressive stream - Start downloading immediately while yt-dlp is downloading
app.get("/stream/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  const status = downloadQueue.get(videoId);
  const metadata = getCachedMetadata(videoId);

  if (!status || !metadata) {
    return res.status(404).json({
      error: "Video not found",
      message: "Call /extract first to get video metadata",
    });
  }

  if (status.status === "failed") {
    return res.status(500).json({
      error: "Download failed",
      details: status.error,
    });
  }

  const filename = metadata.title 
    ? `${metadata.title.replace(/[^a-z0-9]/gi, "_").substring(0, 50)}.mp4`
    : `video_${videoId}.mp4`;

  // If already cached, serve from cache
  if (status.status === "completed" && status.filePath) {
    try {
      await fs.access(status.filePath);
      const stat = await fs.stat(status.filePath);
      
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      
      console.log(`📤 Serving cached video (stream): ${videoId}`);
      
      const fileStream = fsSync.createReadStream(status.filePath);
      fileStream.pipe(res);
      
      return;
    } catch (err) {
      console.error("Cache read error:", err.message);
      // Fall through to live streaming
    }
  }

  // Stream live from yt-dlp
  console.log(`🌊 Starting progressive stream for: ${videoId}`);
  
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Transfer-Encoding", "chunked");

  try {
    const liveStream = streamVideoLive(metadata.originalUrl, metadata.platform, videoId);
    
    liveStream.pipe(res);
    
    liveStream.on("error", (error) => {
      console.error("Live stream error:", error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Stream failed", details: error.message });
      }
    });

    // Handle client disconnect
    req.on("close", () => {
      console.log("Client disconnected from stream");
      liveStream.destroy();
      
      // Kill the process if no other clients
      const queueData = downloadQueue.get(videoId);
      if (queueData && queueData.process && queueData.streams.length === 0) {
        queueData.process.kill();
      }
    });
    
  } catch (error) {
    console.error("Stream setup error:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to start stream", details: error.message });
    }
  }
});

// Download video (serves from cache when ready)
app.get("/download/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  const status = downloadQueue.get(videoId);

  if (!status) {
    return res.status(404).json({
      error: "Video not found",
      message: "Call /extract first to get video metadata and start download",
    });
  }

  if (status.status === "failed") {
    return res.status(500).json({
      error: "Download failed",
      details: status.error,
    });
  }

  if (status.status === "downloading") {
    return res.status(202).json({
      message: "Video is still downloading. Use /stream endpoint for immediate progressive download.",
      status: status.status,
      progress: status.progress,
      statusUrl: `/status/${videoId}`,
      streamUrl: `/stream/${videoId}`,
      retryAfter: 5,
    });
  }

  if (status.status === "completed" && status.filePath) {
    try {
      await fs.access(status.filePath);
      
      const metadata = getCachedMetadata(videoId);
      const filename = metadata?.title 
        ? `${metadata.title.replace(/[^a-z0-9]/gi, "_").substring(0, 50)}.mp4`
        : `video_${videoId}.mp4`;

      const stat = await fs.stat(status.filePath);
      
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Cache-Control", "public, max-age=31536000");
      
      console.log(`📤 Serving cached video (download): ${videoId}`);
      
      const fileStream = fsSync.createReadStream(status.filePath);
      fileStream.pipe(res);
      
      fileStream.on("error", (error) => {
        console.error("Stream error:", error.message);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to stream video" });
        }
      });
      
    } catch (error) {
      console.error("File access error:", error.message);
      res.status(500).json({
        error: "Video file not found",
        details: error.message,
      });
    }
  } else {
    res.status(500).json({
      error: "Unknown error",
      status: status,
    });
  }
});

// Quick info endpoint
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

    await initCacheDirs();

    console.log("🗑️  Cleaning up old binaries...");
    try {
      await fs.unlink(ytdlpPath);
      console.log("✅ Removed old binary");
    } catch (err) {
      console.log("ℹ️  No existing binary to remove");
    }

    console.log("⬇️  Downloading latest yt-dlp binary...");
    let downloadSuccess = false;
    
    try {
      await YTDlpWrap.downloadFromGithub(
        ytdlpPath,
        undefined,
        undefined,
        process.env.GITHUB_TOKEN || undefined
      );
      downloadSuccess = true;
      console.log("✅ yt-dlp downloaded successfully via yt-dlp-wrap");
    } catch (downloadError) {
      console.warn("⚠️  yt-dlp-wrap download failed:", downloadError.message);
      console.log("🔄 Trying alternative download method...");
      
      try {
        await downloadBinaryDirect(ytdlpPath);
        downloadSuccess = true;
      } catch (directError) {
        console.error("❌ Direct download also failed:", directError.message);
      }
    }

    if (!downloadSuccess) {
      throw new Error(
        "Failed to download yt-dlp binary.\n" +
        "Solutions:\n" +
        "1. Set GITHUB_TOKEN environment variable\n" +
        "2. Check if GitHub API is accessible from your server\n" +
        "3. Wait for GitHub rate limit reset (1 hour)"
      );
    }

    if (process.platform !== "win32") {
      await fs.chmod(ytdlpPath, 0o755);
    }

    ytdlpWrap.setBinaryPath(ytdlpPath);

    try {
      const version = await ytdlpWrap.execPromise(["--version"]);
      console.log(`✅ yt-dlp version: ${version.trim()}`);
    } catch (error) {
      try {
        await fs.unlink(ytdlpPath);
      } catch {}
      throw new Error(`yt-dlp binary test failed: ${error.message}`);
    }

    await checkCookies();

    app.listen(port, () => {
      console.log(`\n🚀 Video Extractor API running on port ${port}`);
      console.log(`📺 Supported: YouTube, Instagram, TikTok, Facebook`);
      console.log(`💾 Video caching enabled (max ${MAX_CACHE_SIZE_MB}MB)`);
      console.log(`\n📍 Endpoints:`);
      console.log(`   GET /health                    - Health check`);
      console.log(`   GET /version                   - yt-dlp version info`);
      console.log(`   GET /extract?url={url}         - Extract metadata & start download`);
      console.log(`   GET /status/{videoId}          - Check download progress`);
      console.log(`   GET /stream/{videoId}          - Progressive stream (start immediately!)⚡`);
      console.log(`   GET /download/{videoId}        - Download from cache (wait until ready)`);
      console.log(`   GET /info?url={url}            - Quick info only`);
      console.log(`\n💡 Recommended Workflow:`);
      console.log(`   1. Call /extract?url={videoUrl} to get videoId`);
      console.log(`   2. Immediately call /stream/{videoId} for instant progressive download`);
      console.log(`   3. Video starts downloading while yt-dlp is still fetching!`);
      console.log(`\n🔧 Alternative (wait for cache):`);
      console.log(`   1. Call /extract?url={videoUrl}`);
      console.log(`   2. Poll /status/{videoId} until ready`);
      console.log(`   3. Call /download/{videoId} for instant cached download`);
      console.log(`\n⚡ Tips:`);
      console.log(`   - Use /stream for immediate downloads (no waiting!)`);
      console.log(`   - Use /download for repeat downloads from cache`);
      console.log(`   - Set GITHUB_TOKEN to avoid rate limits`);
      console.log(`   - Add youtube-cookies.txt for restricted videos\n`);
    });

  } catch (error) {
    console.error("\n❌ Failed to initialize app:", error.message);
    console.error("\n🔍 Troubleshooting:");
    console.error("   1. Check internet connection");
    console.error("   2. Set GITHUB_TOKEN environment variable");
    console.error("   3. Check if GitHub is accessible from your server");
    console.error("   4. Wait for GitHub rate limit reset\n");
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  console.log("\n🛑 Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n🛑 Received SIGINT, shutting down gracefully...");
  process.exit(0);
});

initializeApp();