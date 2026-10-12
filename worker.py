#!/usr/bin/env python3
"""Long-lived helper for the web UI: applies moves and gives quick live evals.
Reads one JSON request per line on stdin, writes one JSON response per line."""
import json, os, sys

import chess
import chess.engine

from analyze import cp, find_stockfish, MATE_CP


def apply_moves(board, ucis):
    steps = []
    for u in ucis:
        mv = chess.Move.from_uci(u)
        if mv not in board.legal_moves:
            promo = chess.Move.from_uci(u + "q") if len(u) == 4 else None
            if promo and promo in board.legal_moves:
                mv = promo
            else:
                raise ValueError("illegal move " + u)
        san, cap = board.san(mv), board.is_capture(mv)
        board.push(mv)
        steps.append({"uci": mv.uci(), "san": san, "fen": board.fen(),
                      "capture": cap, "check": board.is_check()})
    return steps


def handle(eng, req):
    board = chess.Board(req["fen"]) if req.get("fen") else chess.Board()
    steps = apply_moves(board, req.get("moves", []))
    over = board.is_game_over()
    out = {"fen": board.fen(), "steps": steps, "legal": [m.uci() for m in board.legal_moves],
           "over": over, "result": board.result() if over else None}
    if req.get("eval"):
        if over:
            c = 0 if not board.is_checkmate() else (-MATE_CP if board.turn == chess.WHITE else MATE_CP)
            out["eval"] = {"cp": c, "best_uci": None, "pv_san": [], "depth": 0}
        else:
            info = eng.analyse(board, chess.engine.Limit(time=min(float(req.get("ms", 600)), 5000) / 1000))
            pv, tmp, sans = info.get("pv", []), board.copy(), []
            for m in pv[:6]:
                sans.append(tmp.san(m))
                tmp.push(m)
            out["eval"] = {"cp": cp(info["score"]), "best_uci": pv[0].uci() if pv else None,
                           "pv_san": sans, "depth": info.get("depth")}
    return out


def main():
    eng = chess.engine.SimpleEngine.popen_uci(find_stockfish())
    eng.configure({"Threads": max(1, (os.cpu_count() or 2) // 2), "Hash": 128})
    for line in sys.stdin:
        req = json.loads(line)
        try:
            out = handle(eng, req)
        except Exception as e:
            out = {"error": str(e)}
        out["id"] = req.get("id")
        print(json.dumps(out), flush=True)
    eng.quit()


if __name__ == "__main__":
    main()
