# HyperFrames episode worker: Node renders, Python speaks RunPod's job protocol.
FROM node:22-bookworm-slim

# Chrome's shared libraries, FFmpeg for encoding, fonts so text renders,
# and Python for the RunPod SDK.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
      ffmpeg \
      ca-certificates \
      fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 \
      libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 \
      libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
      libwayland-client0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
      libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxkbcommon0 \
      libxrandr2 libxrender1 libxshmfence1 libxtst6 \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages runpod==1.12.0

WORKDIR /app

# Chrome is downloaded into the image during npm install, so cold starts don't pay for it.
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Do not rely on puppeteer's postinstall having run: a transitive install can skip it,
# which leaves no browser on disk and every render capturing 0 frames. Install both
# browsers explicitly — HyperFrames resolves the headless shell, but some paths
# (audio FX, HDR) launch full Chrome.
RUN npx --yes puppeteer browsers install chrome-headless-shell \
    && npx --yes puppeteer browsers install chrome

COPY render.mjs handler.py ./
COPY projects ./projects

# Fail the build rather than the first job if a piece is missing. The Chrome checks
# matter most: a missing shared library otherwise shows up only as "0 frames captured".
RUN node -e "import('@hyperframes/producer').then(m=>{if(!m.executeRenderJob)throw new Error('producer missing executeRenderJob')})" \
    && ffmpeg -version > /dev/null \
    && echo "--- puppeteer cache ---" && ls -R /app/.cache/puppeteer | head -60

# ldd is the reliable gate: a missing .so here means every render captures 0 frames.
# Actually launching Chrome is only advisory — BuildKit gives /dev/shm just 64 MB,
# so a crash here does not mean the image is broken.
RUN set -eux; \
    CHROME="$(find /app/.cache/puppeteer -type f \( -name 'chrome-headless-shell' -o -name 'chrome' \) | head -1)"; \
    test -n "$CHROME"; \
    echo "chrome binary: $CHROME"; \
    echo "--- unresolved shared libraries ---"; \
    if ldd "$CHROME" | grep "not found"; then echo "MISSING LIBRARIES ABOVE"; exit 1; fi; \
    echo "all shared libraries resolve"; \
    "$CHROME" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
      --dump-dom about:blank > /dev/null 2>&1 \
      && echo "chrome launched OK" \
      || echo "WARNING: chrome did not launch during build (often just BuildKit /dev/shm)"

CMD ["python3", "-u", "handler.py"]
