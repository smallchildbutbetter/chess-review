#!/usr/bin/env python3
"""Long-lived helper for the web UI: applies moves and gives quick live evals.
Reads one JSON request per line on stdin, writes one JSON response per line."""
import json, os, sys

import chess
import chess.engine

from analyze import cp, find_stockfish, MATE_CP, open_tablebase, tb_wdl, tb_label, TB_CP

TB = open_tablebase()


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
    if req.get("cmd") == "status":
        return {"tb": TB.largest if TB else 0}
    board = chess.Board(req["fen"]) if req.get("fen") else chess.Board()
    steps = apply_moves(board, req.get("moves", []))
    over = board.is_game_over()
    out = {"fen": board.fen(), "steps": steps, "legal": [m.uci() for m in board.legal_moves],
           "over": over, "result": board.result() if over else None}
    tbw = tb_wdl(TB, board) if not over else None
    if tbw is not None:
        sign = 1 if board.turn == chess.WHITE else -1
        out["tb"] = tb_label(sign * TB_CP[tbw])
    if req.get("eval"):
        if over:
            c = 0 if not board.is_checkmate() else (-MATE_CP if board.turn == chess.WHITE else MATE_CP)
            out["eval"] = {"cp": c, "best_uci": None, "pv_san": [], "depth": 0}
        else:
            k = max(1, min(int(req.get("multipv", 1)), 5))
            infos = eng.analyse(board, chess.engine.Limit(time=min(float(req.get("ms", 600)), 5000) / 1000), multipv=k)
            if not isinstance(infos, list):
                infos = [infos]
            lines = []
            for info in infos:
                pv, tmp, sans = info.get("pv", []), board.copy(), []
                for m in pv[:8]:
                    sans.append(tmp.san(m))
                    tmp.push(m)
                lines.append({"cp": cp(info["score"]), "pv_san": sans, "pv_uci": [m.uci() for m in pv[:8]], "depth": info.get("depth")})
            first = lines[0]
            out["lines"] = lines
            out["eval"] = {"cp": first["cp"], "best_uci": first["pv_uci"][0] if first["pv_uci"] else None,
                           "pv_san": first["pv_san"][:6], "depth": first["depth"]}
            if "tb" in out:
                out["eval"]["cp"] = {"W": 900, "D": 0, "L": -900}[out["tb"]]
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
