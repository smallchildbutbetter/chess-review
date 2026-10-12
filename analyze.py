#!/usr/bin/env python3
"""Local chess game review: PGN -> Stockfish -> game_report.json."""
import argparse, io, json, math, os, queue, shutil, sqlite3, sys, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import chess
import chess.engine
import chess.pgn

HERE = Path(__file__).resolve().parent
MATE_CP = 1000  # mate scores are clamped to +/-10 pawns
PIECE_VAL = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9}
CLASSES = ("Brilliant", "Great", "Best", "Excellent", "Good", "Book",
           "Inaccuracy", "Miss", "Mistake", "Blunder")


def find_stockfish():
    cands = [os.environ.get("STOCKFISH_PATH"), HERE / "engines" / "stockfish", HERE / "engines" / "stockfish.exe",
             shutil.which("stockfish"), "/opt/homebrew/bin/stockfish",
             "/usr/local/bin/stockfish", "/usr/games/stockfish"]
    for c in cands:
        if c and Path(c).is_file() and os.access(c, os.X_OK):
            return str(c)
    sys.exit("Stockfish not found. Run ./setup.sh, or set STOCKFISH_PATH.")


def load_game(arg):
    text = Path(arg).read_text() if os.path.isfile(arg) else arg
    game = chess.pgn.read_game(io.StringIO(text))
    if game is None or not list(game.mainline_moves()):
        sys.exit("Could not parse any moves from the PGN.")
    return game


def cp(score):
    """PovScore -> centipawns from White's view."""
    return score.white().score(mate_score=MATE_CP)


def pov(cp_white, color):
    return cp_white if color == chess.WHITE else -cp_white


def win_pct(cp_mover):
    """Win probability (0-100) for the side whose centipawns are given."""
    c = max(-MATE_CP, min(MATE_CP, cp_mover))
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * c)) - 1)


# ---------------------------------------------------------------- opening book
def load_openings():
    """EPD -> (eco, name) from the lichess chess-openings TSVs (CC0)."""
    db = {}
    for f in sorted((HERE / "openings").glob("*.tsv")):
        for line in f.read_text().splitlines()[1:]:
            eco, name, pgn = line.split("\t")
            g = chess.pgn.read_game(io.StringIO(pgn))
            b = g.board()
            for mv in g.mainline_moves():
                b.push(mv)
            db[b.epd()] = (eco, name)
    return db


# ------------------------------------------------------------------ eval cache
class Cache:
    def __init__(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False, timeout=30)
        self.db.execute("CREATE TABLE IF NOT EXISTS ev (k TEXT PRIMARY KEY, v TEXT)")
        self.lock = threading.Lock()

    def get(self, k):
        with self.lock:
            row = self.db.execute("SELECT v FROM ev WHERE k=?", (k,)).fetchone()
        return json.loads(row[0]) if row else None

    def put(self, k, v):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO ev VALUES (?,?)", (k, json.dumps(v)))
            self.db.commit()


def terminal_eval(b):
    if b.is_checkmate():
        return [{"cp": -MATE_CP if b.turn == chess.WHITE else MATE_CP, "pv": []}]
    return [{"cp": 0, "pv": []}]


def analyse_all(boards, depth, sf_path, progress):
    """Top-2 lines for every position, using a pool of single-thread engines
    plus an on-disk cache keyed by (position, depth)."""
    cache = Cache(HERE / "data" / "eval_cache.db")
    results, todo = [None] * len(boards), []
    for i, b in enumerate(boards):
        if b.is_game_over():
            results[i] = terminal_eval(b)
            continue
        hit = cache.get(f"{b.epd()}|{depth}")
        if hit:
            results[i] = hit
        else:
            todo.append(i)
    done = len(boards) - len(todo)
    progress(done, len(boards))
    if not todo:
        return results

    n = max(1, min(len(todo), os.cpu_count() or 2, 8))
    pool, engines = queue.Queue(), []
    try:
        for _ in range(n):
            e = chess.engine.SimpleEngine.popen_uci(sf_path)
            e.configure({"Threads": 1, "Hash": 64})
            engines.append(e)
            pool.put(e)

        def work(i):
            e = pool.get()
            try:
                infos = e.analyse(boards[i], chess.engine.Limit(depth=depth), multipv=2)
            finally:
                pool.put(e)
            res = [{"cp": cp(x["score"]), "pv": [m.uci() for m in x.get("pv", [])[:6]]} for x in infos]
            cache.put(f"{boards[i].epd()}|{depth}", res)
            return i, res

        with ThreadPoolExecutor(n) as ex:
            for fut in as_completed([ex.submit(work, i) for i in todo]):
                i, res = fut.result()
                results[i] = res
                done += 1
                progress(done, len(boards))
    finally:
        for e in engines:
            try:
                e.quit()
            except Exception:
                pass
    return results


# -------------------------------------------------------------- classification
def material(board, color):
    return sum(v * len(board.pieces(pt, color)) for pt, v in PIECE_VAL.items())


def mat_diff(board, color):
    return material(board, color) - material(board, not color)


def non_pawn_material(board):
    return sum(v * (len(board.pieces(pt, True)) + len(board.pieces(pt, False)))
               for pt, v in PIECE_VAL.items() if pt != chess.PAWN)


def classify(book, was_best, loss, only_move, sac, w_b, w_a, opp_loss):
    """loss / w_* are win-probability points (0-100) from the mover's view."""
    if book:
        return "Book"
    if loss <= 2:
        if sac and w_b < 85 and w_a >= 45:
            return "Brilliant"
        if was_best and only_move and w_b < 95:
            return "Great"
        return "Best" if was_best else "Excellent"
    if loss <= 5:
        return "Good"
    if opp_loss >= 10 and w_b >= 60 and w_a >= 35:
        return "Miss"
    if loss <= 10:
        return "Inaccuracy"
    if loss <= 20:
        return "Mistake"
    return "Blunder"


def move_accuracy(loss, label):
    if label == "Book":
        return 100.0
    return max(0.0, min(100.0, 103.1668 * math.exp(-0.04354 * loss) - 3.1668))


def accuracy(vals):
    if not vals:
        return None
    arith = sum(vals) / len(vals)
    harm = len(vals) / sum(1 / max(v, 1.0) for v in vals)
    return round((arith + harm) / 2, 1)


def phase_of(board, move_number):
    if move_number <= 10:
        return "opening"
    return "endgame" if non_pawn_material(board) <= 26 else "middlegame"


def build_rows(boards, moves, infos, book):
    rows, opening, prev_loss = [], None, 0.0
    for n, mv in enumerate(moves, 1):
        b, nb = boards[n - 1], boards[n]
        mover = b.turn
        cur, nxt = infos[n - 1], infos[n]
        best_uci = cur[0]["pv"][0] if cur[0]["pv"] else None
        w_b = win_pct(pov(cur[0]["cp"], mover))
        w_a = win_pct(pov(nxt[0]["cp"], mover))
        was_best = mv.uci() == best_uci
        loss = 0.0 if was_best else max(0.0, w_b - w_a)
        gap = (w_b - win_pct(pov(cur[1]["cp"], mover))) if len(cur) > 1 else 0
        last = moves[n - 2] if n > 1 else None
        recapture = bool(last and boards[n - 2].is_capture(last) and mv.to_square == last.to_square)
        only_move = gap >= 15 and w_a >= 35 and b.legal_moves.count() >= 3 and not recapture

        sac = False
        if loss <= 2 and nxt[0]["pv"] and not mv.promotion:
            t = nb.copy()
            t.push_uci(nxt[0]["pv"][0])
            sac = mat_diff(b, mover) - mat_diff(t, mover) >= 3

        hit = book.get(nb.epd())
        label = classify(bool(hit), was_best, loss, only_move, sac, w_b, w_a, prev_loss)
        if hit:
            opening = {"eco": hit[0], "name": hit[1], "ply": n}

        pv_san, tmp = [], b.copy()
        for u in cur[0]["pv"]:
            m = chess.Move.from_uci(u)
            pv_san.append(tmp.san(m))
            tmp.push(m)
        drop = 0.0 if was_best else max(0.0, (pov(cur[0]["cp"], mover) - pov(nxt[0]["cp"], mover)) / 100)
        rows.append({
            "ply": n, "move_number": (n + 1) // 2, "color": "white" if mover else "black",
            "san": b.san(mv), "uci": mv.uci(), "fen_before": b.fen(),
            "legal_before": [m.uci() for m in b.legal_moves],
            "phase": phase_of(b, (n + 1) // 2),
            "eval_before": round(cur[0]["cp"] / 100, 2),          # White's perspective
            "eval_after": round(nxt[0]["cp"] / 100, 2),
            "eval_drop": round(drop, 2),
            "win_before": round(w_b, 1), "win_after": round(w_a, 1), "loss": round(loss, 1),
            "classification": label,
            "accuracy": round(move_accuracy(loss, label), 1),
            "engine_best": pv_san[0] if pv_san else None, "engine_uci": best_uci, "engine_line": pv_san, "engine_line_uci": cur[0]["pv"],
        })
        prev_loss = loss
    return rows, opening


def summarize(rows):
    out = {}
    for color in ("white", "black"):
        mine = [r for r in rows if r["color"] == color]
        counts = {k: 0 for k in CLASSES}
        for r in mine:
            counts[r["classification"]] += 1
        phases = {}
        for ph in ("opening", "middlegame", "endgame"):
            pm = [r for r in mine if r["phase"] == ph]
            phases[ph] = {"moves": len(pm), "accuracy": accuracy([r["accuracy"] for r in pm]),
                          "errors": sum(r["classification"] in ("Miss", "Mistake", "Blunder") for r in pm)}
        out[color] = {"accuracy": accuracy([r["accuracy"] for r in mine]), "counts": counts, "phases": phases}
    return out


def analyze(game, depth, sf_path, progress):
    moves = list(game.mainline_moves())
    boards = [game.board()]
    for mv in moves:
        b = boards[-1].copy()
        b.push(mv)
        boards.append(b)
    infos = analyse_all(boards, depth, sf_path, progress)
    rows, opening = build_rows(boards, moves, infos, load_openings())
    evals = [round(i[0]["cp"] / 100, 2) for i in infos]
    return rows, evals, opening, boards[-1]


def main():
    ap = argparse.ArgumentParser(description="Review a chess game with Stockfish.")
    ap.add_argument("pgn", help="PGN file path or a PGN string")
    ap.add_argument("-d", "--depth", type=int, default=14)
    ap.add_argument("-o", "--out", default=str(HERE / "game_report.json"))
    a = ap.parse_args()

    def progress(done, total):
        print(f"\r{done}/{total}", end="", file=sys.stderr, flush=True)

    game = load_game(a.pgn)
    rows, evals, opening, final = analyze(game, a.depth, find_stockfish(), progress)
    print(file=sys.stderr)
    summary = summarize(rows)
    report = {"version": 2, "final_fen": final.fen(), "final_legal": [m.uci() for m in final.legal_moves],
              "opening": opening, "headers": dict(game.headers), "depth": a.depth,
              "result": game.headers.get("Result", "*"), "eval_series_white_pov": evals,
              "summary": summary, "moves": rows}
    Path(a.out).write_text(json.dumps(report, indent=2))

    for c in ("white", "black"):
        s = summary[c]
        print(f"{c.title():5} accuracy {s['accuracy']}%  " + "  ".join(f"{k}:{v}" for k, v in s["counts"].items() if v))
    if opening:
        print(f"Opening: {opening['eco']} {opening['name']}")
    print(f"Report written to {a.out}")


if __name__ == "__main__":
    main()
