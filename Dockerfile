# Use a lightweight Debian-based Node image (Alpine often breaks Python/FFmpeg)
FROM node:20-slim

# 1. Install System Dependencies
# aria2: Multi-connection download accelerator (CRITICAL FOR SPEED)
# dumb-init: Prevents zombie processes
# python3/ffmpeg: Required for yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    aria2 \
    curl \
    ca-certificates \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# 2. Install yt-dlp globally
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# 3. Dependencies
COPY package*.json ./
RUN npm ci --only=production

# 4. Copy Code
COPY . .

# 5. Start with dumb-init to handle signals correctly
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "index.js"]