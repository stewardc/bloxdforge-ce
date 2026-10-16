#!/bin/sh
# Unpacks the asset archives in public/ (see public/README.md). Requires 7-Zip:
#   brew install sevenzip
set -e
cd "$(dirname "$0")/../public"
SEVENZIP=$(command -v 7zz || command -v 7z || true)
if [ -z "$SEVENZIP" ]; then
  echo "7-Zip not found. Install it with: brew install sevenzip" >&2
  exit 1
fi
for f in environment fonts lib textures vb; do
  "$SEVENZIP" x -y "$f.7z" >/dev/null
  echo "Unpacked $f.7z"
done

# The texture name index behind the New File autocomplete (/api/data/textures.txt).
mkdir -p ../data
ls textures/default/textures | sed -n 's/\.png$//p' | sort > ../data/textures.txt
echo "Wrote data/textures.txt"
