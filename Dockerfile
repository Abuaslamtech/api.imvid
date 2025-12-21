# Use a lightweight Debian-based Node image
FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    aria2 \
    curl \
    ca-certificates \
    dumb-init \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Deno system-wide
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Verify installations
RUN deno --version && yt-dlp --version

# App setup
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

# Render assigns PORT dynamically
EXPOSE 3000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "index.js"]