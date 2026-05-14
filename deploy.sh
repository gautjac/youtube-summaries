#!/bin/bash
# Deploy YouTube summaries to Netlify.
# Requires a local .env (gitignored) with:
#   NETLIFY_AUTH_TOKEN=...
#   NETLIFY_SITE_ID=...
#   FIREBASE_API_KEY=...   (used by npm run fetch)
set -e

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "❌ .env not found. Create one with NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

: "${NETLIFY_AUTH_TOKEN:?NETLIFY_AUTH_TOKEN missing from .env}"
: "${NETLIFY_SITE_ID:?NETLIFY_SITE_ID missing from .env}"

echo "Building..."
npm run build

echo "Deploying to Netlify..."
npx netlify-cli deploy --prod --dir=dist --site="$NETLIFY_SITE_ID"

echo "✅ Deployed to https://yt-jac.netlify.app"
