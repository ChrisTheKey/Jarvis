#!/usr/bin/env bash
# Builds dist/jarvis-netlify.zip — a package for Netlify's manual deploy
# (drag & drop or `netlify deploy`), which does NOT run a build step. The site
# is therefore assembled here rather than on Netlify.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/dist"
stage="$out/jarvis-netlify"

rm -rf "$stage" "$out/jarvis-netlify.zip"
mkdir -p "$stage/site" "$stage/functions"

cp "$root/standalone/jarvis.html" "$stage/site/index.html"
cp "$root"/netlify/functions/*.mjs "$stage/functions/"

cat > "$stage/netlify.toml" <<'TOML'
# Manual deploy: Netlify runs no build here, so `site/` is already built.
[build]
  publish = "site"
  functions = "functions"

[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/:splat"
  status = 200

[[headers]]
  for = "/*"
  [headers.values]
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
    Permissions-Policy = "microphone=(self), camera=(), geolocation=()"
TOML

cp "$root/scripts/PACKAGE_README.md" "$stage/LIESMICH.md"

cd "$out"
zip -qr jarvis-netlify.zip jarvis-netlify
echo "dist/jarvis-netlify.zip"
unzip -l jarvis-netlify.zip | tail -n +4 | head -n -2
