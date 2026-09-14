#!/usr/bin/env bash
# exit on error
set -o errexit

# 1. Install regular node packages
npm install

# 2. Tell Puppeteer where to store and download Chrome on Render's Linux system
PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
mkdir -p $PUPPETEER_CACHE_DIR

# 3. Explicitly install the Linux Chrome browser
npx puppeteer browsers install chrome