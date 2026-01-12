FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    aria2 \
    curl \
    ca-certificates \
    dumb-init \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Deno system-wide
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# Install yt-dlp with recommended optional dependency groups
# - default: recommended for PyPI users for YouTube JS components
# - curl-cffi: provides impersonation support if available for your platform
RUN pip3 install --no-cache-dir -U "yt-dlp[default,curl-cffi]"

# Ensure a stable yt-dlp path
RUN which yt-dlp && yt-dlp --version && deno --version

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

EXPOSE 3000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "index.js"]
