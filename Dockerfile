# HyperFrames episode worker: Node renders, Python speaks RunPod's job protocol.
FROM node:22-bookworm-slim

# Chrome's shared libraries, FFmpeg for encoding, fonts so text renders,
# and Python for the RunPod SDK.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
      ffmpeg \
      ca-certificates \
      unzip xz-utils \
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
# leaving no browser on disk and every render capturing 0 frames. Call puppeteer's own
# installer by path — `npx puppeteer` has to resolve a package name and fails here.
# Every line is non-fatal: a build that dies hides its own diagnostics, and the
# `diagnose` job input reports what actually landed.
# puppeteer's install.mjs swallows its own failures ("Browser download failed" then
# exit 0), so the build can succeed with empty browser folders. Capture every attempt
# into the image: build logs are awkward to reach, but `diagnose` can read a file.
RUN { \
      echo "== install.mjs =="; \
      node node_modules/puppeteer/install.mjs 2>&1; echo "exit=$?"; \
      echo "== puppeteer cli: chrome-headless-shell =="; \
      node node_modules/puppeteer/lib/puppeteer/node/cli.js browsers install chrome-headless-shell 2>&1; echo "exit=$?"; \
      echo "== @puppeteer/browsers direct =="; \
      node node_modules/@puppeteer/browsers/lib/main-cli.js install chrome-headless-shell@stable --path /app/.cache/puppeteer 2>&1; echo "exit=$?"; \
      node node_modules/@puppeteer/browsers/lib/main-cli.js install chrome@stable --path /app/.cache/puppeteer 2>&1; echo "exit=$?"; \
      echo "== resulting tree =="; \
      find /app/.cache/puppeteer -maxdepth 5 2>&1 | head -40; \
    } > /app/install-log.txt 2>&1; \
    cat /app/install-log.txt; \
    exit 0

COPY render.mjs voice.mjs upload.mjs handler.py ./
COPY projects ./projects

# Fail the build rather than the first job if a piece is missing. The Chrome checks
# matter most: a missing shared library otherwise shows up only as "0 frames captured".
RUN node -e "import('@hyperframes/producer').then(m=>{if(!m.executeRenderJob)throw new Error('producer missing executeRenderJob')})" \
    && ffmpeg -version > /dev/null \
    && echo "--- puppeteer cache ---" && ls -R /app/.cache/puppeteer | head -60

# Report, never fail. Build-time failures are invisible from here; the `diagnose`
# job input returns the same facts at runtime, where the output is readable.
RUN set +e; \
    CHROME="$(find /app/.cache/puppeteer -type f \( -name 'chrome-headless-shell' -o -name 'chrome' \) | head -1)"; \
    echo "chrome binary: ${CHROME:-NONE FOUND}"; \
    if [ -n "$CHROME" ]; then \
      echo "--- unresolved shared libraries (empty is good) ---"; \
      ldd "$CHROME" | grep "not found" || echo "all shared libraries resolve"; \
    fi; \
    exit 0

CMD ["python3", "-u", "handler.py"]
