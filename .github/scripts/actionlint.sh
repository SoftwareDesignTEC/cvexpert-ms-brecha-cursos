#!/usr/bin/env bash
set -euo pipefail

# Fixed release and independently checked digest: never execute a latest installer.
version=1.7.12
sha256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
archive="${RUNNER_TEMP:?}/actionlint-${version}-linux-amd64.tar.gz"
curl --fail --silent --show-error --location --retry 3 \
  "https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_linux_amd64.tar.gz" \
  --output "$archive"
printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check --strict
tar -xzf "$archive" -C "$RUNNER_TEMP" actionlint
"$RUNNER_TEMP/actionlint" .github/workflows/*.yml
