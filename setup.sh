#!/usr/bin/env bash
# Creates .venv, installs deps, and installs Stockfish if missing.
set -e
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
if [ -x engines/stockfish ] || command -v stockfish >/dev/null; then echo "Stockfish found."; exit 0; fi
case "$(uname -s)" in
  Darwin) brew install stockfish ;;
  Linux)  sudo apt-get install -y stockfish || echo "Install stockfish with your package manager." ;;
  *)      echo "Install Stockfish from https://stockfishchess.org/download/ and set STOCKFISH_PATH." ;;
esac
