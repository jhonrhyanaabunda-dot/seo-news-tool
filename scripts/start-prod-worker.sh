#!/bin/bash
# Runs the SEO crawler worker on this Mac against the PRODUCTION database.
# Vercel can't run Chromium, and the dealership sites only serve pages to a real
# browser, so production scans (CRAWLER_MODE=worker) are crawled here with Chrome.
#
# Normally it runs in the background via ~/Library/LaunchAgents/com.a3brands.seoworker.plist
# (same command, with the same environment). Use this script for a manual run in a terminal.
set -euo pipefail
cd "$(dirname "$0")/.."

# .env.worker wins; scripts/load-env then fills anything unset from .env.local.
export ENV_FILE=.env.worker
# ipv4first: this network has no IPv6 route and Neon publishes AAAA records,
# so Node's default 250 ms per-address attempt times out before IPv4 answers (~280 ms).
export NODE_OPTIONS="--conditions=react-server --dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=3000"
exec "$HOME/.local/node/bin/node" node_modules/tsx/dist/cli.mjs worker/index.ts
