const express = require("express");
const YTDlpWrap = require("yt-dlp-wrap").default;
const path = require("path");
const fs = require("fs").promises;
const https = require("https");
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

    console.log(`📥 Extracting ${platform} metadata for: ${videoUrl.substring(0, 50)}...`);

    const config = PLATFORM_CONFIG[platform];
    const args = [
      videoUrl,
      "-f", config.format,
      "--dump-json",
      "--no-warnings",
      "--no-playlist",
      "--skip-download",
      ...config.extraArgs,
    ];

    console.log(`🔧 Running yt-dlp with args:`, args.join(' '));

    // Increase timeout to 60 seconds for slower servers
    const stdout = await Promise.race([
      ytdlpWrap.execPromise(args),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Extraction timeout after 60s')), 60000)
      )
    ]);

    // Validate output
    if (!stdout || typeof stdout !== 'string' || stdout.trim().length === 0) {
      console.error("❌ yt-dlp returned empty output");
      throw new Error("yt-dlp returned empty output. Video may be unavailable.");
    }

    console.log(`✅ Received ${stdout.length} bytes of data`);

    // Parse JSON
    let metadata;
    try {
      metadata = JSON.parse(stdout);
    } catch (parseError) {
      console.error("❌ JSON Parse Error:", parseError.message);
      console.error("📄 First 300 chars:", stdout.substring(0, 300));
      throw new Error(`Invalid JSON from yt-dlp: ${parseError.message}`);
    }

    console.log(`✅ Successfully parsed metadata for: ${metadata.title || 'Unknown'}`);

    // Get the selected format info (your existing code)
    let selectedFormat = null;
    let streamUrl = null;
    let filesize = null;
    let resolution = "unknown";

    if (metadata.requested_formats && metadata.requested_formats.length > 0) {
      const videoFormat = metadata.requested_formats.find(f => f.vcodec && f.vcodec !== "none");
      const audioFormat = metadata.requested_formats.find(f => f.acodec && f.acodec !== "none");
      
      selectedFormat = videoFormat || metadata.requested_formats[0];
      streamUrl = metadata.url || selectedFormat?.url || null;
      
      filesize = (videoFormat?.filesize || videoFormat?.filesize_approx || 0) + 
                 (audioFormat?.filesize || audioFormat?.filesize_approx || 0) || null;
      
      resolution = videoFormat?.height ? `${videoFormat.height}p` : "unknown";
    } else {
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
    urlToIdCache.set(videoId, videoUrl);
    
    console.log(`✅ Metadata extraction complete for: ${videoId}`);
    res.json(response);

  } catch (error) {
    console.error("❌ Extract error:", error.message);

    let errorMsg = "Failed to fetch video information";
    let statusCode = 500;

    if (error.message.includes("timeout")) {
      errorMsg = "Request timed out. Try again or the video may be too large.";
      statusCode = 504;
    } else if (error.message.includes("empty output")) {
      errorMsg = "Video unavailable or access denied.";
      statusCode = 404;
    }

    res.status(statusCode).json({
      error: errorMsg,
      details: error.message,
      platform: detectPlatform(videoUrl),
    });
  }
});

// Debug endpoint to test yt-dlp
app.get("/debug", async (req, res) => {
  const testUrl = req.query.url || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  
  try {
    console.log("🔍 Testing yt-dlp with:", testUrl);
    
    // Test 1: Version
    const version = await ytdlpWrap.execPromise(["--version"]);
    console.log("✅ Version:", version.trim());
    
    // Test 2: Simple extraction
    const simpleArgs = [
      testUrl,
      "--dump-json",
      "--no-playlist",
      "--skip-download"
    ];
    
    const output = await Promise.race([
      ytdlpWrap.execPromise(simpleArgs),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Test timeout')), 20000)
      )
    ]);
    
    let isValidJson = false;
    let parsedData = null;
    
    try {
      parsedData = JSON.parse(output);
      isValidJson = true;
    } catch (e) {
      console.error("JSON parse failed:", e.message);
    }
    
    res.json({
      status: "ok",
      ytdlpVersion: version.trim(),
      binaryPath: ytdlpPath,
      binaryExists: require('fs').existsSync(ytdlpPath),
      testUrl: testUrl,
      outputLength: output?.length || 0,
      isValidJson: isValidJson,
      videoTitle: parsedData?.title || "Parse failed",
      outputPreview: output?.substring(0, 500) || "No output",
      platform: process.platform,
      node: process.version
    });
    
  } catch (error) {
    console.error("❌ Debug test failed:", error.message);
    res.status(500).json({
      error: error.message,
      stack: error.stack,
      binaryPath: ytdlpPath,
      binaryExists: require('fs').existsSync(ytdlpPath)
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

    // ALWAYS delete any existing binary first
    console.log("🗑️  Cleaning up old binaries...");
    try {
      await fs.unlink(ytdlpPath);
      console.log("✅ Removed old binary");
    } catch (err) {
      // File doesn't exist, that's fine
      console.log("ℹ️  No existing binary to remove");
    }

    // Try downloading with yt-dlp-wrap first
    console.log("⬇️  Downloading latest yt-dlp binary...");
    let downloadSuccess = false;
    
    try {
      await YTDlpWrap.downloadFromGithub(
        ytdlpPath,
        undefined, // version (latest)
        undefined, // platform (auto-detect)
        process.env.GITHUB_TOKEN || undefined
      );
      downloadSuccess = true;
      console.log("✅ yt-dlp downloaded successfully via yt-dlp-wrap");
    } catch (downloadError) {
      console.warn("⚠️  yt-dlp-wrap download failed:", downloadError.message);
      console.log("🔄 Trying alternative download method...");
      
      // Try direct download
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

    // Make executable on Unix
    if (process.platform !== "win32") {
      await fs.chmod(ytdlpPath, 0o755);
    }

    // Set binary path
    ytdlpWrap.setBinaryPath(ytdlpPath);

    // Verify yt-dlp works
    try {
      const version = await ytdlpWrap.execPromise(["--version"]);
      console.log(`✅ yt-dlp version: ${version.trim()}`);
    } catch (error) {
      // If binary test fails, delete it
      try {
        await fs.unlink(ytdlpPath);
      } catch {}
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
      console.log(`   GET /download?vid={vid}  - Stream/download video`);
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
    console.error("   3. Check if GitHub is accessible from your server");
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