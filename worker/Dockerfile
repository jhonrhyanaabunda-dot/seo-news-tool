# Optional standalone worker (see README → "Scaling beyond Vercel Cron").
#
# Ships Chromium so BROWSER_RENDERING=fallback can read pages a plain HTTP
# request cannot. The official Playwright image bundles Chromium, Firefox and
# WebKit (~5 GB); only Chromium is used here, so it is installed onto a slim
# Node base instead. Keep PLAYWRIGHT_VERSION in step with the "playwright-core"
# version in package.json — the browser must match the client driving it.
#
# Build from the repository root:
#   docker build -f worker/Dockerfile -t a3-seo-worker .
ARG NODE_VERSION=22-bookworm-slim
ARG PLAYWRIGHT_VERSION=1.63.0

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:${NODE_VERSION}
ARG PLAYWRIGHT_VERSION
WORKDIR /app
ENV NODE_ENV=production
# Where Chromium is installed, and where playwright-core looks for it.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Chromium plus the system libraries it needs. Pinned to the playwright-core
# version so the browser and the client that drives it stay compatible.
RUN npx --yes playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# Create the user before copying so ownership is set as files land. A
# `chown -R` afterwards would rewrite every file and duplicate the node_modules
# and Chromium layers — worth over a gigabyte in the final image.
RUN useradd --create-home --uid 1001 crawler

COPY --from=deps --chown=crawler:crawler /app/node_modules ./node_modules
COPY --chown=crawler:crawler . .

# Run unprivileged so Chromium's sandbox stays enabled (no BROWSER_NO_SANDBOX).
# /ms-playwright is left root-owned: the browser only needs read and execute,
# which it already has.
USER crawler

# Uses the same DATABASE_URL, email and API settings as the Vercel app.
CMD ["npm", "run", "worker"]
