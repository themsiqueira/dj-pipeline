FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip3 install --no-cache-dir yt-dlp

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

COPY src ./src

CMD ["node", "src/run.js"]

