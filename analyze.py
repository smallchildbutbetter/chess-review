#!/usr/bin/env python3
"""Local chess game review: PGN -> Stockfish -> game_report.json."""
import argparse, io, json, math, os, queue, re, shutil, sqlite3, sys, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import chess
import chess.engine
import chess.pgn
import chess.syzygy

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


# ------------------------------------------------------------------ tablebases
TB_CP = {2: 900, 1: 0, 0: 0, -1: 0, -2: -900}   # cursed wins / blessed losses are draws under the 50-move rule


def open_tablebase():
    """Syzygy WDL tables from $SYZYGY_PATH or ./tablebases (None if not installed)."""
    d = Path(os.environ.get("SYZYGY_PATH") or HERE / "tablebases")
    if not d.is_dir() or not any(d.glob("*.rtbw")):
        return None
    try:
        return chess.syzygy.open_tablebase(str(d))
    except Exception:
        return None


def tb_wdl(tb, board):
    """WDL from the side to move's view (-2..2), or None when not in the tables."""
    if tb is None or board.castling_rights or len(board.piece_map()) > tb.largest:
        return None
    try:
        return max(-2, min(2, tb.get_wdl(board)))
    except Exception:
        return None


def tb_label(cp_white):
    return "W" if cp_white > 0 else "L" if cp_white < 0 else "D"


def apply_tablebase(boards, infos, tb):
    """Replace engine evals by exact tablebase results where available."""
    for i, b in enumerate(boards):
        if b.is_game_over() or tb_wdl(tb, b) is None:
            continue
        vals = {}
        for m in b.legal_moves:
            a = b.copy()
            a.push(m)
            if a.is_checkmate():
                vals[m.uci()] = 2
            elif a.is_game_over():
                vals[m.uci()] = 0
            else:
                w = tb_wdl(tb, a)
                if w is None:
                    vals = None
                    break
                vals[m.uci()] = -w
        if not vals:
            continue
        best_v = max(vals.values())
        eng_best = infos[i][0]["pv"][0] if infos[i][0]["pv"] else None
        best = eng_best if vals.get(eng_best) == best_v else next(u for u, v in vals.items() if v == best_v)
        sign = 1 if b.turn == chess.WHITE else -1
        pv = infos[i][0]["pv"] if best == eng_best else [best]
        new = [{"cp": sign * TB_CP[best_v], "pv": pv, "tb": tb_label(sign * TB_CP[best_v])}]
        lower = [v for v in vals.values() if TB_CP[v] != TB_CP[best_v]]
        if lower:
            u2 = next(u for u, v in vals.items() if v == max(lower))
            new.append({"cp": sign * TB_CP[max(lower)], "pv": [u2]})
        infos[i] = new
    return infos


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


def analyse_all(boards, depth, sf_path, progress, workers=None, hash_mb=64):
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

    n = max(1, min(len(todo), workers or os.cpu_count() or 2, 8))
    pool, engines = queue.Queue(), []
    try:
        for _ in range(n):
            e = chess.engine.SimpleEngine.popen_uci(sf_path)
            e.configure({"Threads": 1, "Hash": hash_mb})
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


def parse_tc(tc):
    m = re.match(r"^(\d+)(?:\+(\d+))?$", tc or "")
    return (int(m.group(1)), int(m.group(2) or 0)) if m else (None, 0)


def build_timing(game, moves):
    """Per-move clock info from [%clk] comments: remaining, time spent, time-trouble flag."""
    base, inc = parse_tc(game.headers.get("TimeControl", ""))
    clocks = [n.clock() for n in game.mainline()]
    if not any(c is not None for c in clocks):
        return None
    thresh = min(60, max(15, 0.1 * base)) if base else 30
    prev, out = {True: base, False: base}, []
    for i, c in enumerate(clocks):
        color = (i % 2 == 0)
        spent = None
        if c is not None and prev[color] is not None:
            spent = max(0.0, prev[color] + inc - c)
        out.append({"clock": c, "time_spent": None if spent is None else round(spent, 1),
                    "time_trouble": c is not None and c <= thresh})
        if c is not None:
            prev[color] = c
    return {"moves": out, "base": base, "inc": inc, "trouble_at": thresh}


def build_rows(boards, moves, infos, book, timing=None):
    rows, opening, prev_loss = [], None, 0.0
    for n, mv in enumerate(moves, 1):
        b, nb = boards[n - 1], boards[n]
        mover = b.turn
        cur, nxt = infos[n - 1], infos[n]
        best_uci = cur[0]["pv"][0] if cur[0]["pv"] else None
        w_b = win_pct(pov(cur[0]["cp"], mover))
        w_a = win_pct(pov(nxt[0]["cp"], mover))
        loss0 = max(0.0, w_b - w_a)
        was_best = mv.uci() == best_uci or (bool(cur[0].get("tb")) and loss0 < 0.5)
        loss = 0.0 if was_best else loss0
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
            "tb": cur[0].get("tb"), "tb_after": nxt[0].get("tb"),
            "engine_best": pv_san[0] if pv_san else None, "engine_uci": best_uci, "engine_line": pv_san, "engine_line_uci": cur[0]["pv"],
        })
        if timing:
            t = timing["moves"][n - 1]
            rows[-1].update(t)
        prev_loss = loss
    return rows, opening


def est_rating(acpl):
    """Rough strength estimate from average centipawn loss (heuristic, not Elo-calibrated)."""
    return int(max(300, min(2900, round(3100 * math.exp(-0.01 * acpl) / 50) * 50)))


def time_summary(mine):
    ts = [r for r in mine if r.get("time_spent") is not None]
    if not ts:
        return None
    err = lambda r: r["classification"] in ("Miss", "Mistake", "Blunder")
    tr = [r for r in mine if r.get("time_trouble")]
    ok = [r for r in mine if not r.get("time_trouble") and r.get("clock") is not None]
    longest = max(ts, key=lambda r: r["time_spent"])
    return {"avg": round(sum(r["time_spent"] for r in ts) / len(ts), 1),
            "trouble_moves": len(tr), "errors_in_trouble": sum(map(err, tr)),
            "normal_moves": len(ok), "errors_normal": sum(map(err, ok)),
            "rushed_errors": sum(1 for r in ts if err(r) and r["time_spent"] <= 2),
            "longest": {"ply": longest["ply"], "san": longest["san"], "secs": longest["time_spent"]}}


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
        drops = [min(r["eval_drop"] * 100, 500) for r in mine if r["classification"] != "Book"]
        acpl = round(sum(drops) / len(drops), 1) if drops else 0.0
        out[color] = {"accuracy": accuracy([r["accuracy"] for r in mine]), "counts": counts, "phases": phases,
                      "acpl": acpl, "rating": est_rating(acpl), "time": time_summary(mine)}
    return out


def analyze(game, depth, sf_path, progress, workers=None, hash_mb=64):
    moves = list(game.mainline_moves())
    boards = [game.board()]
    for mv in moves:
        b = boards[-1].copy()
        b.push(mv)
        boards.append(b)
    infos = analyse_all(boards, depth, sf_path, progress, workers, hash_mb)
    tb = open_tablebase()
    if tb:
        infos = apply_tablebase(boards, infos, tb)
        tb.close()
    timing = build_timing(game, moves)
    rows, opening = build_rows(boards, moves, infos, load_openings(), timing)
    evals = [round(i[0]["cp"] / 100, 2) for i in infos]
    return rows, evals, opening, boards[-1], timing, bool(tb)


def main():
    ap = argparse.ArgumentParser(description="Review a chess game with Stockfish.")
    ap.add_argument("pgn", help="PGN file path or a PGN string")
    ap.add_argument("-d", "--depth", type=int, default=14)
    ap.add_argument("-w", "--workers", type=int, default=None, help="parallel engine processes (default: all cores, max 8)")
    ap.add_argument("--hash", type=int, default=64, help="hash MB per engine")
    ap.add_argument("--nice", type=int, default=0, help="lower CPU priority (0-19)")
    ap.add_argument("-o", "--out", default=str(HERE / "game_report.json"))
    a = ap.parse_args()

    def progress(done, total):
        print(f"\r{done}/{total}", end="", file=sys.stderr, flush=True)

    if a.nice and hasattr(os, "nice"):
        os.nice(a.nice)
    game = load_game(a.pgn)
    rows, evals, opening, final, timing, tb_on = analyze(game, a.depth, find_stockfish(), progress, a.workers, a.hash)
    print(file=sys.stderr)
    summary = summarize(rows)
    report = {"version": 3, "tablebase": tb_on, "clocks": timing and {"base": timing["base"], "inc": timing["inc"], "trouble_at": timing["trouble_at"]}, "final_fen": final.fen(), "final_legal": [m.uci() for m in final.legal_moves],
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
