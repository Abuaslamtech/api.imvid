"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
const port = process.env.PORT || 3000;

// ---------------------------
// CONFIG
// ---------------------------
const CONFIG = {
  ytDlpPath: process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp",
  ffmpegPath: process.env.FFMPEG_PATH || "/usr/bin/ffmpeg",

  extractTimeoutMs: 45_000,
  cacheTTLms: 15 * 60_000,          // 15 min
  cacheCleanupIntervalMs: 2 * 60_000,

  preview: {
    seconds: 4,                     // fastest: fixed first segment
    width: 360,                     // small for fast encode
    crf: 28,
    preset: "veryfast",
  },

  // Basic concurrency protection so your box doesn't melt
  maxConcurrentYtDlp: Number(process.env.MAX_YTDLP || 6),
  maxConcurrentFfmpeg: Number(process.env.MAX_FFMPEG || 4),
};

// ---------------------------
// SIMPLE SEMAPHORE (CONCURRENCY LIMIT)
// ---------------------------
function createSemaphore(max) {
  let current = 0;
  const queue = [];
  return {
    async acquire() {
      if (current < max) {
        current++;
        return;
      }
      await new Promise((resolve) => queue.push(resolve));
      current++;
    },
    release() {
      current--;
      const next = queue.shift();
      if (next) next();
    },
    getCurrent() {
      return current;
    },
    getQueued() {
      return queue.length;
    },
  };
}

const semYtDlp = createSemaphore(CONFIG.maxConcurrentYtDlp);
const semFfmpeg = createSemaphore(CONFIG.maxConcurrentFfmpeg);

// ---------------------------
// PLATFORM DETECTION + ARGS
// ---------------------------
const PLATFORMS = {
  youtube: {
    detect: (url) => /youtube\.com|youtu\.be|music\.youtube\.com/i.test(url),
    cookiesFile: "youtube-cookies.txt",
    extraArgs: ["--no-playlist", "--no-warnings"],
    // You can keep this if you must, but it can add overhead.
    // extraArgs: ["--no-playlist","--no-warnings","--extractor-args","youtube:player_client=android,web"],
  },
  instagram: {
    detect: (url) => /instagram\.com|instagr\.am/i.test(url),
    cookiesFile: "instagram-cookies.txt",
    extraArgs: [
      "--no-warnings",
      "--no-check-certificate",
      "--user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ],
  },
  tiktok: {
    detect: (url) => /tiktok\.com/i.test(url),
    cookiesFile: "tiktok-cookies.txt",
    extraArgs: ["--no-warnings"],
  },
  facebook: {
    detect: (url) => /facebook\.com|fb\.watch/i.test(url),
    cookiesFile: "facebook-cookies.txt",
    extraArgs: ["--no-warnings", "--no-check-certificate"],
  },
};

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
  if (fs.existsSync(cookiePath)) args.push("--cookies", cookiePath);

  return args;
}

function validateUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------
// CACHES
// ---------------------------
// metadata cache: key=url and key=videoId -> { data, timestamp, platform, originalUrl, raw }
// preview cache: videoId -> { path, timestamp }
// in-flight: url -> Promise (dedupe /extract work)
// in-flight preview: videoId -> Promise
const metaCache = new Map();
const previewCache = new Map();
const inflightExtract = new Map();
const inflightPreview = new Map();

// ---------------------------
// RUN yt-dlp (capture stdout/stderr)
// ---------------------------
function runYtDlpJson(args, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    await semYtDlp.acquire();

    const proc = spawn(CONFIG.ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      semYtDlp.release();
      reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    proc.stderr.on("data", (d) => (stderr += d.toString("utf8")));

    proc.on("error", (err) => {
      clearTimeout(t);
      semYtDlp.release();
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(t);
      semYtDlp.release();

      if (code !== 0) {
        // include stderr for real debugging signal
        return reject(new Error(`yt-dlp failed (code ${code}): ${stderr.slice(-4000)}`));
      }
      if (!stdout.trim()) {
        return reject(new Error(`yt-dlp returned empty stdout. stderr: ${stderr.slice(-2000)}`));
      }

      try {
        resolve({ json: JSON.parse(stdout), stderr });
      } catch (e) {
        reject(new Error(`Failed to parse yt-dlp JSON: ${e.message}. stderr: ${stderr.slice(-2000)}`));
      }
    });
  });
}

// ---------------------------
// FORMAT SELECTION + MAPPING
// ---------------------------

function minDimension(format) {
  const w = Number(format.width || 0);
  const h = Number(format.height || 0);
  if (!w || !h) return 0;
  return Math.min(w, h);
}

function hasAudio(format) {
  return format.acodec && format.acodec !== "none";
}

function isVideo(format) {
  return format.vcodec && format.vcodec !== "none";
}

function buildAvailableFormats(raw) {
  const formats = Array.isArray(raw.formats) ? raw.formats : [];
  if (!formats.length) return [];

  // Keep only video formats with some dimension
  const videoFormats = formats.filter((f) => isVideo(f) && (f.height || f.width));

  // Group by "quality bucket" based on shorter dimension
  const byQ = new Map();

  for (const f of videoFormats) {
    const qDim = minDimension(f);
    if (!qDim) continue;

    const key = `${qDim}p`;
    const candidate = {
      formatId: String(f.format_id),
      ext: f.ext || "mp4",
      quality: `${qDim}p`,
      hasAudio: !!hasAudio(f),
      filesize: f.filesize ?? f.filesize_approx ?? null,
      // label: ready-made UI string
      label: `${f.ext || "?"} ${qDim}p ${hasAudio(f) ? "A+V" : "Video-only"}`,
      // keep extra internal info:
      _tbr: f.tbr ?? f.vbr ?? 0,
      _qDim: qDim,
    };

    if (!byQ.has(key)) {
      byQ.set(key, candidate);
      continue;
    }

    const existing = byQ.get(key);

    // Prefer formats with audio; if same, prefer higher bitrate
    if (candidate.hasAudio && !existing.hasAudio) {
      byQ.set(key, candidate);
    } else if (candidate.hasAudio === existing.hasAudio) {
      if ((candidate._tbr || 0) > (existing._tbr || 0)) byQ.set(key, candidate);
    }
  }

  return Array.from(byQ.values())
    .sort((a, b) => (b._qDim || 0) - (a._qDim || 0))
    .map(({ _tbr, _qDim, ...out }) => out);
}

// Choose a direct URL for preview (fastest path for preview generation)
// Prefer mp4 + avc1-ish + <=480p-ish, but fall back gracefully.
function pickPreviewDirectUrl(raw) {
  const formats = Array.isArray(raw.formats) ? raw.formats : [];
  if (!formats.length) return null;

  // Candidates: video formats with a direct URL
  const candidates = formats.filter((f) => isVideo(f) && typeof f.url === "string" && f.url.startsWith("http"));

  if (!candidates.length) return null;

  // Score and pick best for preview speed
  // Lower resolution is faster to fetch/encode
  const scored = candidates.map((f) => {
    const q = minDimension(f) || (f.height || 0) || 9999;
    const ext = (f.ext || "").toLowerCase();
    const vcodec = (f.vcodec || "").toLowerCase();

    let score = 0;
    // prefer mp4
    if (ext === "mp4") score += 50;
    // prefer h264/avc
    if (vcodec.includes("avc") || vcodec.includes("h264")) score += 30;
    // prefer <= 480 (shorter side)
    if (q <= 480) score += 40;
    else if (q <= 720) score += 20;
    else score -= 10;

    // prefer having video bitrate info
    if (f.tbr) score += Math.min(10, f.tbr / 500);

    return { f, score, q };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored[0].f.url;
}

// Choose a "default" format for your VideoInfo top-level fields
function pickDefaultFormat(availableFormats) {
  if (!availableFormats || !availableFormats.length) return null;
  // Prefer highest that has audio; otherwise highest overall.
  const withAudio = availableFormats.filter((f) => f.hasAudio);
  return (withAudio[0] || availableFormats[0]) || null;
}

function pickResolutionFromRaw(raw) {
  const w = raw.width;
  const h = raw.height;
  if (w && h) return `${w}x${h}`;
  // fallback: try to infer from formats
  const formats = Array.isArray(raw.formats) ? raw.formats : [];
  const best = formats
    .filter((f) => isVideo(f) && (f.width || f.height))
    .sort((a, b) => (minDimension(b) || 0) - (minDimension(a) || 0))[0];
  if (best && best.width && best.height) return `${best.width}x${best.height}`;
  if (best && best.height) return `${best.height}p`;
  return "unknown";
}

// ---------------------------
// EXTRACT ONCE: yt-dlp -J
// ---------------------------
async function extractOnce(url) {
  const platform = detectPlatform(url);
  if (!platform) throw new Error("Unsupported platform");

  const cached = metaCache.get(url);
  if (cached && Date.now() - cached.timestamp < CONFIG.cacheTTLms) {
    return cached.data;
  }

  // Dedupe concurrent same-url requests
  if (inflightExtract.has(url)) return inflightExtract.get(url);

  const p = (async () => {
    const args = [
      url,
      "-J",
      "--skip-download",
      "--no-playlist",
      ...getPlatformArgs(platform),
    ];

    const { json: raw } = await runYtDlpJson(args, CONFIG.extractTimeoutMs);

    const availableFormats = buildAvailableFormats(raw);
    const defaultFmt = pickDefaultFormat(availableFormats);

    const videoId = raw.id || crypto.createHash("sha1").update(url).digest("hex");
    const resolution = pickResolutionFromRaw(raw);

    // Your VideoInfo shape (backend response)
    const data = {
      title: raw.title || "Unknown Title",
      author: raw.uploader || raw.channel || "Unknown Author",
      thumbnail: raw.thumbnail || "",
      duration: Number(raw.duration || 0),
      platform,
      videoId,
      originalUrl: url,
      filesize: Number(raw.filesize || raw.filesize_approx || defaultFmt?.filesize || 0),
      resolution,
      format: defaultFmt?.ext || (raw.ext || "mp4"),
      previewUrl: `/api/video/preview?vid=${encodeURIComponent(videoId)}`,
      downloadUrl: `/api/video/download?vid=${encodeURIComponent(videoId)}`,
      previewType: "video/mp4",
      previewDuration: CONFIG.preview.seconds,
      availableFormats,
      // internal-only helpers:
      _raw: raw,
      _previewDirectUrl: pickPreviewDirectUrl(raw),
    };

    // Cache by url and by id
    const entry = { data, timestamp: Date.now(), platform, originalUrl: url };
    metaCache.set(url, entry);
    metaCache.set(videoId, entry);

    return data;
  })().finally(() => {
    inflightExtract.delete(url);
  });

  inflightExtract.set(url, p);
  return p;
}

// ---------------------------
// PREVIEW GENERATION (ffmpeg direct URL)
// ---------------------------
async function generatePreviewMp4(directUrl, videoId) {
  await semFfmpeg.acquire();
  const outPath = path.join(os.tmpdir(), `preview_${videoId}_${Date.now()}.mp4`);

  return new Promise((resolve, reject) => {
    const args = [
  "-y",
  "-ss", "0",
  "-t", String(CONFIG.preview.seconds),
  "-i", directUrl,
  "-vf",
  `scale=${CONFIG.preview.width}:-2:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
  "-an",
  "-c:v", "libx264",
  "-preset", CONFIG.preview.preset,
  "-crf", String(CONFIG.preview.crf),
  "-movflags", "+faststart",
  outPath,
];


    const ff = spawn(CONFIG.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d.toString("utf8")));

    ff.on("error", (err) => {
      semFfmpeg.release();
      reject(err);
    });

    ff.on("close", (code) => {
      semFfmpeg.release();
      if (code === 0 && fs.existsSync(outPath)) return resolve(outPath);
      reject(new Error(`ffmpeg failed (code ${code}): ${stderr.slice(-4000)}`));
    });
  });
}

async function getOrGeneratePreview(videoId) {
  const cached = previewCache.get(videoId);
  if (cached && Date.now() - cached.timestamp < CONFIG.cacheTTLms && fs.existsSync(cached.path)) {
    return cached.path;
  }

  if (inflightPreview.has(videoId)) return inflightPreview.get(videoId);

  const p = (async () => {
    const metaEntry = metaCache.get(videoId);
    if (!metaEntry || !metaEntry.data) throw new Error("Video ID not found or expired");

    const directUrl = metaEntry.data._previewDirectUrl;
    if (!directUrl) throw new Error("No direct format URL available for preview");

    const filePath = await generatePreviewMp4(directUrl, videoId);
    previewCache.set(videoId, { path: filePath, timestamp: Date.now() });
    return filePath;
  })().finally(() => {
    inflightPreview.delete(videoId);
  });

  inflightPreview.set(videoId, p);
  return p;
}

// ---------------------------
// RANGE-AWARE FILE SERVE
// ---------------------------
function serveVideoFile(filePath, req, res) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=3600");

  if (!range) {
    res.setHeader("Content-Length", fileSize);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const parts = range.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

  if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
    res.status(416).end();
    return;
  }

  const chunkSize = end - start + 1;

  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  res.setHeader("Content-Length", chunkSize);

  fs.createReadStream(filePath, { start, end }).pipe(res);
}

// ---------------------------
// CACHE CLEANUP
// ---------------------------
function cleanupCache() {
  const now = Date.now();

  for (const [key, entry] of metaCache.entries()) {
    if (now - entry.timestamp > CONFIG.cacheTTLms) metaCache.delete(key);
  }

  for (const [vid, entry] of previewCache.entries()) {
    if (now - entry.timestamp > CONFIG.cacheTTLms) {
      previewCache.delete(vid);
      if (entry.path && fs.existsSync(entry.path)) {
        fs.unlink(entry.path, () => {});
      }
    }
  }
}

// ---------------------------
// ROUTES
// ---------------------------
app.get("/health", async (req, res) => {
  res.json({
    status: "ok",
    ytDlp: CONFIG.ytDlpPath,
    ffmpeg: CONFIG.ffmpegPath,
    cacheSize: metaCache.size,
    previewCacheSize: previewCache.size,
    inflightExtract: inflightExtract.size,
    inflightPreview: inflightPreview.size,
    semYtDlp: { running: semYtDlp.getCurrent(), queued: semYtDlp.getQueued(), max: CONFIG.maxConcurrentYtDlp },
    semFfmpeg: { running: semFfmpeg.getCurrent(), queued: semFfmpeg.getQueued(), max: CONFIG.maxConcurrentFfmpeg },
    uptime: process.uptime(),
  });
});

// Your main metadata endpoint
app.get("/api/video/info", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing 'url' parameter" });
  if (!validateUrl(url)) return res.status(400).json({ error: "Invalid URL format" });

  try {
    const data = await extractOnce(url);

    // Warm preview in background (non-blocking)
    getOrGeneratePreview(data.videoId).catch(() => {});

    // Return only the fields your Android model expects
    const {
      _raw, _previewDirectUrl, // strip internal fields
      ...publicData
    } = data;

    res.json(publicData);
  } catch (err) {
    res.status(500).json({ error: "Extraction failed", details: err.message });
  }
});

// Preview endpoint (MP4, 4s)
app.get("/api/video/preview", async (req, res) => {
  const vid = req.query.vid;
  if (!vid) return res.status(400).json({ error: "Missing 'vid' parameter" });

  try {
    const filePath = await getOrGeneratePreview(String(vid));
    serveVideoFile(filePath, req, res);
  } catch (err) {
    res.status(500).json({ error: "Preview failed", details: err.message });
  }
});

// Download endpoint: streams yt-dlp output. Optional formatId.
app.get("/api/video/download", async (req, res) => {
  const vid = req.query.vid;
  const formatId = req.query.formatId; // match your Android model naming if you want
  if (!vid) return res.status(400).json({ error: "Missing 'vid' parameter" });

  const entry = metaCache.get(String(vid));
  if (!entry || !entry.data) return res.status(404).json({ error: "Video ID not found or expired" });

  const { originalUrl, platform } = entry;
  const platformArgs = getPlatformArgs(platform);

  // Decide format string:
  // - If user chose a formatId:
  //   - if that format has audio -> use it
  //   - else -> merge with bestaudio
  // - else: choose a sane default best mp4-ish
  let formatString = "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b";
  if (formatId) {
    const selected = entry.data.availableFormats?.find((f) => String(f.formatId) === String(formatId));
    if (selected?.hasAudio) formatString = String(formatId);
    else formatString = `${String(formatId)}+bestaudio[ext=m4a]/bestaudio/best`;
  }

  // Filename (safe-ish)
  const safeName = (entry.data.title || "video").replace(/[^a-z0-9]+/gi, "_").slice(0, 60);
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}.mp4"`);
  res.setHeader("Content-Type", "video/mp4");

  const args = [
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

  const proc = spawn(CONFIG.ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });

  proc.stdout.pipe(res);

  proc.stderr.on("data", (d) => {
    const msg = d.toString("utf8");
    // keep logs low-noise but useful
    if (msg.includes("ERROR") || msg.includes("WARNING")) {
      console.error("[yt-dlp]", msg.trim());
    }
  });

  proc.on("error", (err) => {
    if (!res.headersSent) res.status(500).json({ error: "Failed to start download", details: err.message });
  });

  req.on("close", () => {
    // client disconnected
    if (!proc.killed) proc.kill("SIGKILL");
  });
});

// ---------------------------
// STARTUP
// ---------------------------
function checkBinaryExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

async function startup() {
  if (!checkBinaryExists(CONFIG.ytDlpPath)) {
    console.error(`❌ yt-dlp missing at ${CONFIG.ytDlpPath}`);
    process.exit(1);
  }
  if (!checkBinaryExists(CONFIG.ffmpegPath)) {
    console.warn(`⚠️ ffmpeg missing at ${CONFIG.ffmpegPath} (preview disabled)`);
  }

  setInterval(cleanupCache, CONFIG.cacheCleanupIntervalMs);

  app.listen(port, "0.0.0.0", () => {
    console.log(`🚀 V2 server listening on :${port}`);
  });
}

startup();
