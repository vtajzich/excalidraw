#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/yctimlin/mcp_excalidraw.git"
TARGET_DIR="mcp_excalidraw"

cd "$(dirname "$0")/.."

if [ -d "$TARGET_DIR" ]; then
  echo "Directory '$TARGET_DIR' already exists — skipping clone."
else
  echo "Cloning $REPO_URL into $TARGET_DIR..."
  git clone "$REPO_URL" "$TARGET_DIR"
fi

cd "$TARGET_DIR"

echo "Installing dependencies..."
npm ci

echo "Building..."
npm run build

echo "Done. Run scripts/run_canvas.sh to start the canvas server."
