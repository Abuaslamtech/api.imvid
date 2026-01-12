FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 \
    python3-venv \
    python3-pip \
    pipx \
    ffmpeg \
    aria2 \
    curl \
    ca-certificates \
    dumb-init \
    unzip \
  && rm -rf /var/lib/apt/lists/*

# Install Deno (optional — only if you really need it)
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# Install yt-dlp via pipx (avoids PEP 668 issue)
RUN pipx ensurepath && pipx install "yt-dlp[default]" \
  && ln -s /root/.local/bin/yt-dlp /usr/local/bin/yt-dlp \
  && yt-dlp --version

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

EXPOSE 3000
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "index.js"]
