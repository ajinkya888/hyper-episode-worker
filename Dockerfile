# HyperFrames episode worker: Node renders, Python speaks RunPod's job protocol.
FROM node:22-bookworm-slim

# Chrome's shared libraries, FFmpeg for encoding, fonts so text renders,
# and Python for the RunPod SDK.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
      ffmpeg \
      ca-certificates \
      fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 libgtk-3-0 \
      libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 \
      libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages runpod==1.12.0

WORKDIR /app

# Chrome is downloaded into the image during npm install, so cold starts don't pay for it.
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY render.mjs handler.py ./
COPY projects ./projects

# Fail the build rather than the first job if a piece is missing.
RUN node -e "import('@hyperframes/producer').then(m=>{if(!m.executeRenderJob)throw new Error('producer missing executeRenderJob')})" \
    && ffmpeg -version > /dev/null \
    && test -d /app/.cache/puppeteer

CMD ["python3", "-u", "handler.py"]
