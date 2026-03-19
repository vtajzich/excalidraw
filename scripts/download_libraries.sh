#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

CACHE_DIR="library_cache"
mkdir -p "$CACHE_DIR"

URLS=(
  # Cloud & infra
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/youritjang/cloud.excalidrawlib"
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/diegolramirez/aws-serverless-icons-v2.excalidrawlib"
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/pclavier92/gcp-icons.excalidrawlib"
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/nicknisi/microsoft-365-icons.excalidrawlib"
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/ajsmth/hashicorp.excalidrawlib"
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/lowess/kubernetes-icons-set.excalidrawlib"

  # Dev tools & languages (includes git, shell, GitHub, DevOps icons)
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/maeddes/technology-logos.excalidrawlib"
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/xxxdeveloper/icons.excalidrawlib"
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/mwc360/microsoft-fabric-architecture-icons.excalidrawlib"
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/pclainchard/it-logos.excalidrawlib"
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/drwnio/drwnio.excalidrawlib"
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/ipedrazas/go-icons.excalidrawlib"

  # Architecture & diagramming
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/corlaez/hexagonal-architecture.excalidrawlib"
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/https-github-com-papacrispy/uml-library-activity-diagram.excalidrawlib"
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/wmartzh/data-flow.excalidrawlib"

  # Data & observability
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/farisology/data-science.excalidrawlib"
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/oehrlis/db-eng.excalidrawlib"
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/mikhailredis/redis-grafana.excalidrawlib"
)

for url in "${URLS[@]}"; do
  filename="${url##*/}"
  if [ -f "$CACHE_DIR/$filename" ]; then
    echo "Already cached: $filename"
  else
    echo "Downloading: $filename"
    curl -sL -o "$CACHE_DIR/$filename" "$url"
  fi
done

echo "All libraries cached in $CACHE_DIR/"
