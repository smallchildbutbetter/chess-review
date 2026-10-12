FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv stockfish && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir -r requirements.txt
COPY . .
ENV HOST=0.0.0.0 PORT=3000 STOCKFISH_PATH=/usr/games/stockfish
EXPOSE 3000
VOLUME /app/data
CMD ["node", "server.js"]
