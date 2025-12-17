<!-- Copilot / AI Agent instructions for contributors working on `api.imvid` -->

# Quick orientation

This repo is a small Node/Express backend that exposes endpoints to extract video metadata and stream/download content from multiple platforms using `yt-dlp` and `ffmpeg`.

- Entry point: `index.js` (single-file service) — read this first to understand routing, extraction, preview, and download flows.
- Build / run: `npm start` (or `node index.js`). A `Dockerfile` is provided for production images.

# Big-picture architecture (what matters to an AI agent)

- Single process Express server that performs three primary roles:
  - Metadata extraction (`/extract`) using `yt-dlp` in JSON mode
  - Streaming a short MP4 preview (`/preview`) by piping `yt-dlp` -> `ffmpeg` -> HTTP response
  - Streaming/download full content (`/download`) by spawning `yt-dlp` and piping stdout to the client
- Platform detection and per-platform args are defined in the `PLATFORMS` object at the top of `index.js`. Platform cookies are loaded from files at repo root (e.g. `instagram-cookies.txt`).
- Caching: an in-memory `Map` named `cache` stores metadata entries keyed by both original URL and video `id`. Entries include `{ metadata, timestamp, originalUrl }`.

# Important files and places to edit

- `index.js` — core logic. Key sections:
  - `CONFIG` object (binary paths, timeouts, preview settings, cache TTLs)
  - `PLATFORMS` object (detection regex, `format`, `cookiesFile`, `extraArgs`)
  - `extractMetadata()` — JSON extraction and cache population
  - `streamMp4Preview()` — pipes `yt-dlp` → `ffmpeg` for previews
  - `/extract`, `/preview`, `/download` routes and error handling
- `Dockerfile` — how production images install system deps and `yt-dlp`.
- `package.json` — start script and dependencies (`yt-dlp-wrap`, `express`, etc.).
- Cookie files at repo root (e.g. `instagram-cookies.txt`, `facebook-cookies.txt`) — used automatically if present.

# Developer workflows / commands

- Local dev: `npm install` then `npm start` (or `node index.js`). Use `nodemon` if you want fast restarts.
- Docker build & run (recommended for parity with system deps):
  - Build: `docker build -t api.imvid .`
  - Run: `docker run --rm -p 3000:3000 -e PORT=3000 api.imvid`
- Ensure `yt-dlp` and `ffmpeg` are present in the image or on the host. `index.js` expects `yt-dlp` at `CONFIG.binaryPath` (default `/usr/local/bin/yt-dlp`) and `ffmpeg` at `CONFIG.ffmpegPath` (default `/usr/bin/ffmpeg`). The `Dockerfile` installs these.

# Project-specific conventions and gotchas

- Single-file service: prefer small, focused changes inside `index.js` rather than adding many files, unless extracting a module improves clarity.
- CONFIG is hard-coded — to change binary paths, timeouts, or preview settings, update the `CONFIG` object in `index.js` (or refactor to read from env vars if you add that feature).
- Cookies: platform-specific cookie files are optional; presence is detected via `fs.existsSync` and added to `yt-dlp` args. Keep cookie filenames in `PLATFORMS[].cookiesFile`.
- Caching: in-memory only (process-local). If you plan to add persistence (Redis), follow the `cache` API shape: entries are objects with `metadata`, `timestamp`, `originalUrl`.
- Streaming: preview and download streams use `child_process.spawn` directly — always check for `EPIPE` handling and kill child processes on client disconnect.

# Common edit patterns the AI should follow

- When changing `PLATFORMS`, preserve `detect`, `format`, `cookiesFile`, and `extraArgs` keys — they are read by `getPlatformArgs()` and other helpers.
- Preserve cache shape (`{ metadata, timestamp, originalUrl }`) so `/preview` and `/download` keep working.
- Keep `--no-playlist` and `--no-warnings` flags on extraction/streaming unless there is a specific reason to remove them.
- When adding new errors or status codes, follow existing style: map message substrings (e.g. `Unsupported`, `timed out`) to HTTP codes in routes.

# Useful examples for prompts to the agent

- "Add a new platform entry for example.com in `PLATFORMS` using the same structure as `tiktok`." (AI should add `detect`, `format`, `cookiesFile`, `extraArgs`.)
- "Refactor `CONFIG` to read `binaryPath` and `ffmpegPath` from environment variables with fallbacks." (AI should update `CONFIG` and usage sites.)
- "Add logging around cache hits and misses consistent with current console logging patterns." (AI should use the same emoji/log style, e.g. `✅ Cache Hit`.)

# Safety and tests

- There are no automated tests. Any change that touches the streaming code should be validated by running the container locally and hitting `/extract`, `/preview`, `/download` with known URLs.

# Where to look for more context

- Start with `index.js`, then `Dockerfile`, then `package.json`. The `README.md` contains basic run instructions but is not exhaustive.

---
If anything here is unclear or you want deeper detail (e.g. split `index.js` into modules, or add env var configuration), tell me which area to expand and I'll update this file.
