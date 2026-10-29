#!/usr/bin/env bash
set -euo pipefail

zip_file="${1:?Pass an absolute path for the output ZIP}"
[[ "$zip_file" = /* ]] || { echo 'ZIP path must be absolute.' >&2; exit 1; }
release_dir="$(mktemp -d)"
trap 'rm -rf -- "$release_dir"' EXIT
repository_dir="$PWD"

# Allowlist, not zip-the-workspace: never copy .env, SQL, tests or runner credentials.
cp -R "${RUNNER_TEMP:?}/release/dist" "$release_dir/dist"
cp package.json package-lock.json "$release_dir/"
# Administrative CLIs are not part of the deployed HTTP application.
rm -f -- "$release_dir/dist/db/cli.js" "$release_dir/dist/db/migrate.js" "$release_dir/dist/db/seed.js"
npm ci --omit=dev --ignore-scripts --prefix "$release_dir"
(
  cd "$release_dir"
  zip -q -r "$zip_file" dist node_modules package.json package-lock.json
)
node "$repository_dir/.github/scripts/verify-package.mjs" "$zip_file"
