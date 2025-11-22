const express = require('express');
const YTDlpWrap = require('yt-dlp-wrap').default;
const path = require('path');
const fs = require('fs').promises;
const app = express();
const port = 3000;

const ytdlpPath = path.resolve(__dirname, 'yt-dlp');
const ytdlpWrap = new YTDlpWrap();
const downloadDir = path.resolve(__dirname, 'downloads');

// Simple in-memory cache with TTL
const metadataCache = new Map();
const CACHE_TTL = 3600000; // 1 hour

// Platform detection & cookies config
const PLATFORM_CONFIG = {
  youtube: {
    name: 'youtube',
    cookies: null,
    format: '(bestvideo+bestaudio/best)[ext=mp4]'
  },
  instagram: {
    name: 'instagram',
    cookies: ['--cookies-from-browser', 'firefox'], 
    format: 'best'
  },
  tiktok: {
    name: 'tiktok',
    cookies: null,
    format: 'best'
  },
  facebook: {
    name: 'facebook',
    cookies: ['--cookies-from-browser', 'firefox'],
    format: 'best'
  }
};

async function ensureDownloadDir() {
  try {
    await fs.mkdir(downloadDir, { recursive: true });
  } catch (e) {
    console.error('Failed to create download dir:', e);
  }
}

function detectPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
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

function getBestFormat(formats, ext = 'mp4') {
  return formats
    .filter(f => {
      if (ext === 'mp4') {
        return f.acodec !== 'none' && f.vcodec !== 'none' && f.ext === 'mp4';
      }
      return f.acodec !== 'none';
    })
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
}

app.get('/extract', async (req, res) => {
  const videoUrl = req.query.url;
  
  if (!videoUrl) {
    return res.status(400).send({ error: 'URL query parameter is required' });
  }

  try {
    // Detect platform
    const platform = detectPlatform(videoUrl);
    if (!platform) {
      return res.status(400).send({ error: 'Unsupported platform. Supported: YouTube, Instagram, TikTok, Facebook' });
    }

    const platformConfig = PLATFORM_CONFIG[platform];
    
    // Check cache first
    const cached = getCached(videoUrl);
    if (cached) {
      console.log(`✅ Serving ${platform} from cache`);
      return res.send(cached);
    }

    // Build flags for yt-dlp
    const flags = ['--skip-download'];
    
    // Add cookies for platforms that need authentication
    if (platformConfig.cookies) {
      flags.push(...platformConfig.cookies);
    }

    console.log(`📥 Extracting ${platform} metadata...`);
    
    // Fetch metadata only (no download)
    const metadata = await ytdlpWrap.getVideoInfo(videoUrl, flags);
    
    const streamFormat = getBestFormat(metadata.formats, 'mp4');
    const downloadFormat = getBestFormat(metadata.formats, 'mp4');

    if (!streamFormat) {
      return res.status(500).send({ error: 'No suitable format found' });
    }

    const response = {
      title: metadata.title || 'Unknown Title',
      author: metadata.uploader || metadata.channel || 'Unknown Author',
      thumbnail: metadata.thumbnail || null,
      duration: metadata.duration || 0,
      platform: platform,
      videoId: metadata.id || metadata.video_id || generateId(),
      streamUrl: streamFormat.url,
      downloadUrl: `/download?vid=${metadata.id || metadata.video_id || generateId()}`,
      filesize: downloadFormat.filesize || downloadFormat.filesize_approx || null,
      resolution: `${downloadFormat.height || 'unknown'}p`,
      format: downloadFormat.ext || 'mp4'
    };

    setCached(videoUrl, response);
    res.send(response);

    // Predownload in background (non-blocking)
    predownloadVideo(videoUrl, response.videoId, platformConfig).catch(err => 
      console.error(`Background download failed for ${response.videoId}:`, err.message)
    );

  } catch (error) {
    console.error('Extract error:', error);
    
    // Check for Instagram authentication error
    if (error.message.includes('Instagram') && error.message.includes('login')) {
      return res.status(403).send({ 
        error: 'Instagram authentication required', 
        details: 'Please ensure Instagram cookies are available. Run: yt-dlp --cookies-from-browser chrome',
        solution: 'Make sure you are logged into Instagram in your browser'
      });
    }
    
    // Check for Facebook authentication error
    if (error.message.includes('Facebook') && error.message.includes('login')) {
      return res.status(403).send({ 
        error: 'Facebook authentication required', 
        details: 'Please ensure Facebook cookies are available. Run: yt-dlp --cookies-from-browser chrome',
        solution: 'Make sure you are logged into Facebook in your browser'
      });
    }

    res.status(500).send({ 
      error: 'Failed to fetch video information', 
      details: error.message,
      platform: detectPlatform(videoUrl)
    });
  }
});

// Background downloader (non-blocking)
async function predownloadVideo(videoUrl, videoId, platformConfig) {
  const filePath = path.join(downloadDir, `${videoId}.mp4`);
  
  try {
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat) {
      console.log(`✅ Video ${videoId} already downloaded`);
      return;
    }

    console.log(`⬇️ Starting background download: ${videoId}`);
    
    // Build download flags
    const flags = [
      videoUrl,
      '-f', platformConfig.format,
      '-o', filePath,
      '--quiet'
    ];

    // Add cookies if needed
    if (platformConfig.cookies) {
      flags.push(...platformConfig.cookies);
    }

    // Convert to MP4 if necessary
    if (platformConfig.name !== 'youtube') {
      flags.push('--remux-video', 'mp4');
    }

    await ytdlpWrap.execPromise(flags);
    console.log(`✅ Download complete: ${videoId}`);
  } catch (error) {
    console.error(`❌ Download error for ${videoId}:`, error.message);
  }
}

// Serve downloaded files
app.get('/download', async (req, res) => {
  const videoId = req.query.vid;
  
  if (!videoId) {
    return res.status(400).send({ error: 'vid query parameter required' });
  }

  const filePath = path.join(downloadDir, `${videoId}.mp4`);

  try {
    const stat = await fs.stat(filePath);
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp4"`);
    
    const stream = require('fs').createReadStream(filePath);
    stream.pipe(res);
    
    stream.on('error', (err) => {
      console.error('Stream error:', err);
      res.status(500).send({ error: 'Failed to stream file' });
    });
  } catch (error) {
    return res.status(404).send({ 
      error: 'Video not downloaded yet', 
      message: 'Try again in a few moments',
      videoId: videoId
    });
  }
});

// Get download status
app.get('/status', async (req, res) => {
  const videoId = req.query.vid;
  
  if (!videoId) {
    return res.status(400).send({ error: 'vid query parameter required' });
  }

  const filePath = path.join(downloadDir, `${videoId}.mp4`);

  try {
    const stat = await fs.stat(filePath);
    res.send({
      status: 'ready',
      size: stat.size,
      videoId: videoId
    });
  } catch (error) {
    res.send({
      status: 'downloading',
      message: 'File is being prepared',
      videoId: videoId
    });
  }
});

// Cleanup old files
async function cleanupOldFiles() {
  try {
    const files = await fs.readdir(downloadDir);
    const now = Date.now();
    const maxAge = 7 * 24 * 3600 * 1000; // 7 days
    
    for (const file of files) {
      const filePath = path.join(downloadDir, file);
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > maxAge) {
        await fs.unlink(filePath);
        console.log(`🗑️ Deleted old file: ${file}`);
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

function generateId() {
  return `vid_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

async function initializeApp() {
  try {
    // Check if yt-dlp binary already exists in the root folder
    const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const binaryPath = path.join(__dirname, binaryName);
    
    const binaryExists = await fs.stat(binaryPath).catch(() => null);
    
    if (!binaryExists) {
      console.log('📥 Downloading yt-dlp for the first time...');
      await YTDlpWrap.downloadFromGithub(ytdlpPath);
    } else {
      console.log(`✅ yt-dlp already exists, skipping download`);
    }
    
    ytdlpWrap.setBinaryPath(ytdlpPath);
    await ensureDownloadDir();
    
    app.listen(port, () => {
      console.log(`🚀 Multi-Platform Video Extractor running at http://localhost:${port}`);
      console.log(`📺 Supported: YouTube, Instagram, TikTok, Facebook`);
      console.log(`\nEndpoints:`);
      console.log(`  GET /extract?url={videoUrl} - Extract metadata`);
      console.log(`  GET /download?vid={videoId} - Download video`);
      console.log(`  GET /status?vid={videoId} - Check download status`);
    });

    // Cleanup every 6 hours
    setInterval(cleanupOldFiles, 6 * 3600 * 1000);
  } catch (error) {
    console.error('Failed to initialize app:', error);
    process.exit(1);
  }
}

initializeApp();