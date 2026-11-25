# The fantasy tile worker. Playwright's image carries the Chromium build that
# playwright@1.65.1 drives, so the pixels match what the tests check.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY painter painter
COPY assets assets
COPY src src

# Frozen source data (OpenFreeMap and terrain tiles). Mount a volume here and
# keep it: deleting it lets map changes in at tile edges.
ENV SOURCE_CACHE_DIR=/data/source
RUN mkdir -p /data/source && chown -R pwuser /data
VOLUME /data

USER pwuser
CMD ["node", "src/worker.mjs"]
