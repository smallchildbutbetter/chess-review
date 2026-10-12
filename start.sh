#!/usr/bin/env bash
# One command: sets things up on first run, then starts the site.
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js 18+ is required: https://nodejs.org"; exit 1; }
[ -d .venv ] && { [ -x engines/stockfish ] || command -v stockfish >/dev/null || [ -x /opt/homebrew/bin/stockfish ] || [ -x /usr/games/stockfish ]; } || ./setup.sh
URL="http://localhost:${PORT:-3000}"
(sleep 1; { command -v open >/dev/null && open "$URL"; } || { command -v xdg-open >/dev/null && xdg-open "$URL"; }) >/dev/null 2>&1 &
exec node server.js
