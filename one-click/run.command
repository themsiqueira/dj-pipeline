#!/bin/bash
set -e

cd "$(dirname "$0")/.."

PLAYLIST_URL="$1"
if [ -z "$PLAYLIST_URL" ]; then
  echo "Paste playlist URL:"
  read PLAYLIST_URL
fi

npm run run -- "$PLAYLIST_URL"

echo
echo "Done. Files are in ./output/audio and Rekordbox XML in ./output/rekordbox"
read -p "Press Enter to close..."

