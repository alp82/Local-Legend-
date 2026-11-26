# The Legend map tile worker. Playwright's image (pinned by digest) carries the Chromium build that
# playwright@1.65.1 drives, so the pixels match what the tests check.
FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579

WORKDIR /app
# The Dockerfile itself and package-lock.json are painter fingerprint inputs (src/fingerprint.mjs): the base
# image digest and the Playwright version fix the Chromium build, so the worker reads them at start-up.
COPY Dockerfile package.json package-lock.json ./
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
