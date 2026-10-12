# Chess Review

A local, private Chess.com-style game review powered by Stockfish. Runs entirely on your machine.

## Run it
```bash
git clone https://github.com/smallchildbutbetter/chess-review chess-review && cd chess-review
./start.sh            # macOS/Linux. Windows: double-click start.bat
                      # first run installs Python deps + Stockfish, then opens http://localhost:3000
```
Needs Node 18+ and Python 3.9+. `setup.sh` installs Stockfish with Homebrew (macOS) or apt (Linux);
on Windows download Stockfish and place the exe at `engines\stockfish.exe` (`start.bat` tells you); or set `STOCKFISH_PATH`. Or use Docker: `docker compose up --build`.

## Features
- **Review**: paste a PGN, get per-move classification (Brilliant, Great, Best, Excellent, Good, Book,
  Inaccuracy, Miss, Mistake, Blunder), accuracy, eval bar and graph, best-move arrows, opening names.
- **Try moves**: drag or click any piece to explore a variation with live engine eval; click the engine's
  suggested line to watch it play out. Keys: arrows, F flip, A arrow, M mute, Esc leave variation.
- **Import**: pull recent games from Chess.com or Lichess by username (only the username is sent).
- **History**: every review is saved to `data/reviews/` and re-opens instantly.
- **Insights**: set "Me" to your username; stats by phase, piece, position type and opening, plus weak spots.
- **Engine lines**: live top-3 candidate lines beside the board, updating as you step or try moves; click one to play it out.
- **Clock & time**: per-move time spent, clock graph, time-trouble errors (needs a PGN with clock times, e.g. Chess.com or Lichess imports).
- **Game rating**: estimated performance rating per player with a +/- range, calibrated on ~380 real player-games from Lichess and Chess.com (`calibration.json`). It skips book, forced and already-decided moves, uses separate fits per time control, and blends in the rating listed in the PGN. One game is a noisy sample, so treat it as a rough guide. Re-fit with more data using `python calibrate.py all --seed-users 25 --per-band 60 --force`.
- **Tablebases (optional)**: run `./get_tablebases.sh` (~396 MB) for exact win/draw/loss in endings with 5 or fewer pieces.
- **Display**: nine drawn piece sets plus text glyphs, board-size slider, dark theme.
- **Export**: annotated PGN, or a single self-contained HTML file to share a review.

## How scoring works
Evals are converted to win probability (`50 + 50*(2/(1+e^(-0.00368*cp)) - 1)`). A move's loss is the drop
in win% versus the engine's best: <=2 Best/Excellent, <=5 Good, <=10 Inaccuracy, <=20 Mistake, >20 Blunder.
Miss = failing to capitalize on the opponent's mistake. Great = the only move that keeps the position.
Brilliant = a good move that sacrifices material. Book = a known opening line. Accuracy uses the
Lichess-style formula. Mate scores are clamped to +/-10 pawns.
Analysis uses several engine processes in parallel and caches positions in `data/eval_cache.db`.

## Command line
```bash
.venv/bin/python analyze.py game.pgn -d 16     # writes game_report.json
```
`COACH_PROMPT.md` is a prompt for turning `game_report.json` into a written review with Claude.

## Credits
Piece sets come from the Lichess repository (lichess-org/lila, public/piece); each set has its own license, see that repo's COPYING.md before redistributing. Opening names: lichess-org/chess-openings (CC0).
Engine: Stockfish (GPLv3).

## License
MIT for this project's code (see `LICENSE`). Third-party assets keep their own licenses.
