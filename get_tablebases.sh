#!/usr/bin/env bash
# Optional: downloads the Syzygy 3-4-5 piece WDL tablebases (145 files, ~396 MB) into ./tablebases
# Source: https://tablebase.lichess.ovh/tables/standard/3-4-5-wdl/
set -e
cd "$(dirname "$0")"
BASE=https://tablebase.lichess.ovh/tables/standard/3-4-5-wdl
mkdir -p tablebases
curl -s "$BASE/" | grep -o 'href="[^"]*\.rtbw"' | sed 's/href="//;s/"//' > tablebases/.files
echo "Downloading $(wc -l < tablebases/.files | tr -d ' ') files (~396 MB)..."
xargs -P 6 -I{} sh -c '[ -s tablebases/{} ] || curl -sf -o tablebases/{} '"$BASE"'/{} || echo "failed: {}"' < tablebases/.files
rm tablebases/.files
echo "Done. Restart the server; the page will show \"Tablebases: 5-piece\"."
