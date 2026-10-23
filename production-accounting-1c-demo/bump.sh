#!/usr/bin/env bash
set -euo pipefail
version="$(date +%Y%m%d%H%M%S)"
sed -i -E "s/(styles\.css|data\.js|app\.js|lam-flow\.js|conveyors\.js|conveyors\.css|users\.js)\?v=[0-9]+/\1?v=$version/g" index.html
echo "Версия ресурсов: $version"
