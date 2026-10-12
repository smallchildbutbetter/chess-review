#!/usr/bin/env python3
"""Build calibration.json: fits "skill accuracy" -> player rating from public Lichess / Chess.com games.

  python calibrate.py collect   # download a stratified sample of public rated games (resumable)
  python calibrate.py analyze   # run them through the same Stockfish pipeline (resumable)
  python calibrate.py fit       # write calibration.json
  python calibrate.py all

Only public game data from the sites' official APIs is used. Be gentle: requests are throttled."""
import argparse, io, json, math, random, sys, time, urllib.error, urllib.request
from pathlib import Path

import chess.pgn

import analyze as A

DATA = A.HERE / "data" / "calib"
DEPTH = 12
BANDS = [0, 900, 1200, 1500, 1800, 2100, 2400, 9999]
UA = {"User-Agent": "chess-review-calibration (personal project, low volume)"}


def get(url, accept=None, retries=4):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={**UA, **({"Accept": accept} if accept else {})})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print("  rate limited, waiting 65s", file=sys.stderr)
                time.sleep(65)
            elif e.code in (404, 410):
                return None
            else:
                time.sleep(3)
        except Exception:
            time.sleep(3)
    return None


def band(r):
    for i in range(len(BANDS) - 1):
        if BANDS[i] <= r < BANDS[i + 1]:
            return i
    return 0


def good_game(pgn):
    """Rated standard game with both ratings and a decent length."""
    g = chess.pgn.read_game(io.StringIO(pgn))
    if g is None:
        return None
    h = g.headers
    try:
        w, b = int(h.get("WhiteElo", "")), int(h.get("BlackElo", ""))
    except ValueError:
        return None
    if h.get("Variant", "Standard") != "Standard" or "FEN" in h:
        return None
    n = len(list(g.mainline_moves()))
    if n < 30 or n > 160:
        return None
    return w, b


# ------------------------------------------------------------------ collection
def lichess_seeds(per_band):
    seeds = {}
    idx = get("https://lichess.org/api/tournament", "application/json")
    ts = json.loads(idx).get("finished", []) if idx else []
    ts = [t for t in ts if t.get("nbPlayers", 0) >= 150 and t.get("variant", {}).get("key") == "standard"][:6]
    for t in ts:
        res = get(f"https://lichess.org/api/tournament/{t['id']}/results?nb=400", "application/x-ndjson")
        time.sleep(1.5)
        for line in (res or "").splitlines():
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if o.get("rating") and o.get("username"):
                seeds.setdefault(band(o["rating"]), set()).add(o["username"])
    top = get("https://lichess.org/api/player/top/20/blitz", "application/json")
    for u in (json.loads(top).get("users", []) if top else []):
        seeds.setdefault(band(u["perfs"]["blitz"]["rating"]), set()).add(u["username"])
    return {b: random.sample(sorted(s), min(per_band, len(s))) for b, s in seeds.items()}


def collect_lichess(per_band, per_user):
    out, seen = [], set()
    for b, users in sorted(lichess_seeds(per_band).items()):
        print(f"lichess band {BANDS[b]}+: {len(users)} seed users")
        for u in users:
            txt = get(f"https://lichess.org/api/games/user/{u}?max={per_user}&rated=true&perfType=bullet,blitz,rapid&pgnInJson=true&clocks=true",
                      "application/x-ndjson")
            time.sleep(1.6)
            for line in (txt or "").splitlines():
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if o["id"] in seen or not o.get("pgn"):
                    continue
                seen.add(o["id"])
                out.append({"site": "lichess", "id": o["id"], "pgn": o["pgn"]})
    return out


def collect_chesscom(n_users, per_user):
    users = []
    lb = get("https://api.chess.com/pub/leaderboards", "application/json")
    if lb:
        d = json.loads(lb)
        for k in ("live_blitz", "live_rapid", "live_bullet"):
            users += [p["username"] for p in d.get(k, [])[:6]]
    for title in ("FM", "NM", "CM", "IM"):
        t = get(f"https://api.chess.com/pub/titled/{title}", "application/json")
        if t:
            users += random.sample(json.loads(t)["players"], 6)
    for c in ("MT", "IS", "LU", "CY"):
        t = get(f"https://api.chess.com/pub/country/{c}/players", "application/json")
        if t:
            users += random.sample(json.loads(t)["players"], n_users // 4)
    out, seen = [], set()
    for u in dict.fromkeys(users):
        arch = get(f"https://api.chess.com/pub/player/{u}/games/archives", "application/json")
        time.sleep(0.4)
        urls = json.loads(arch).get("archives", []) if arch else []
        if not urls:
            continue
        mon = get(urls[-1], "application/json")
        time.sleep(0.4)
        games = [g for g in (json.loads(mon).get("games", []) if mon else [])
                 if g.get("rules") == "chess" and g.get("rated") and g.get("pgn") and g.get("time_class") in ("bullet", "blitz", "rapid")]
        random.shuffle(games)
        for g in games[:per_user]:
            if g["url"] in seen:
                continue
            seen.add(g["url"])
            out.append({"site": "chesscom", "id": g["url"].rsplit("/", 1)[-1], "pgn": g["pgn"]})
    return out


def stratify(games, per_band):
    """Keep at most per_band games per average-rating band, valid games only."""
    bands, keep = {}, []
    random.shuffle(games)
    for g in games:
        r = good_game(g["pgn"])
        if not r:
            continue
        b = band((r[0] + r[1]) // 2)
        if len(bands.setdefault(b, [])) < per_band:
            bands[b].append(g)
    for b in sorted(bands):
        print(f"  band {BANDS[b]}+: {len(bands[b])} games")
        keep += bands[b]
    return keep


def cmd_collect(a):
    DATA.mkdir(parents=True, exist_ok=True)
    random.seed(7)
    for site, fn in (("lichess", lambda: collect_lichess(a.seed_users, a.per_user)),
                     ("chesscom", lambda: collect_chesscom(a.seed_users * 3, a.per_user))):
        f = DATA / f"games_{site}.json"
        if f.exists() and not a.force:
            print(f"{site}: already collected ({f.name}); use --force to redo")
            continue
        print(f"collecting {site} ...")
        games = fn()
        print(f"  {len(games)} candidate games")
        f.write_text(json.dumps(stratify(games, a.per_band)))


# ------------------------------------------------------------------- analysis
def cmd_analyze(a):
    sf = A.find_stockfish()
    sf_out = DATA / "samples.json"
    done = json.loads(sf_out.read_text()) if sf_out.exists() else {}
    todo = []
    for site in ("lichess", "chesscom"):
        f = DATA / f"games_{site}.json"
        if f.exists():
            todo += [g for g in json.loads(f.read_text()) if f"{g['site']}:{g['id']}" not in done]
    print(f"{len(todo)} games to analyse at depth {DEPTH}")
    t0 = time.time()
    for i, g in enumerate(todo, 1):
        try:
            game = chess.pgn.read_game(io.StringIO(g["pgn"]))
            rows, *_ = A.analyze(game, DEPTH, sf, lambda d, t: None, a.workers, 64)
        except Exception as e:
            print("  skip", g["id"], e)
            done[f"{g['site']}:{g['id']}"] = []
            continue
        h, samples = game.headers, []
        for color, key in (("white", "WhiteElo"), ("black", "BlackElo")):
            f = A.skill_features(rows, color)
            if f and f["n"] >= 12:
                samples.append({"site": g["site"], "cls": A.time_class(h), "rating": int(h[key]), **f})
        done[f"{g['site']}:{g['id']}"] = samples
        if i % 5 == 0 or i == len(todo):
            sf_out.write_text(json.dumps(done))
            el = time.time() - t0
            print(f"  {i}/{len(todo)}  {el / 60:.1f} min elapsed, ~{el / i * (len(todo) - i) / 60:.1f} min left", flush=True)
    sf_out.write_text(json.dumps(done))


# ------------------------------------------------------------------------- fit
def solve(A_, b_):
    """Gaussian elimination for small normal equations."""
    n = len(b_)
    M = [row[:] + [b_[i]] for i, row in enumerate(A_)]
    for i in range(n):
        p = max(range(i, n), key=lambda r: abs(M[r][i]))
        M[i], M[p] = M[p], M[i]
        for r in range(n):
            if r != i:
                f = M[r][i] / M[i][i]
                M[r] = [x - f * y for x, y in zip(M[r], M[i])]
    return [M[i][n] / M[i][i] for i in range(n)]


def ols(X, ys):
    """Least squares rating ~ a + w.x"""
    n, k = len(X), len(X[0]) + 1
    D = [[1.0] + list(x) for x in X]
    XtX = [[sum(d[i] * d[j] for d in D) for j in range(k)] for i in range(k)]
    Xty = [sum(d[i] * y for d, y in zip(D, ys)) for i in range(k)]
    beta = solve(XtX, Xty)
    res = [y - sum(b * v for b, v in zip(beta, d)) for d, y in zip(D, ys)]
    sse, my = sum(r * r for r in res), sum(ys) / n
    sst = sum((y - my) ** 2 for y in ys)
    return {"a": round(beta[0], 2), "w": [round(b, 3) for b in beta[1:]], "sd": round(math.sqrt(sse / max(1, n - k)), 1),
            "r2": round(1 - sse / sst, 3), "n": n}


def cmd_fit(a):
    done = json.loads((DATA / "samples.json").read_text())
    samples = [s for v in done.values() for s in v]
    print(f"{len(samples)} player-games")
    groups = {}
    for s in samples:
        cls = "rapid" if s["cls"] == "classical" else s["cls"]
        for key in (f"{s['site']}:{cls}", f"{s['site']}:all", f"all:{cls}", "all:all"):
            groups.setdefault(key, []).append(s)
    fit = {}
    for key, ss in sorted(groups.items()):
        if len(ss) < a.min_samples:
            print(f"  {key}: only {len(ss)} samples, skipped")
            continue
        fit[key] = ols([A.feature_vector(s) for s in ss], [s["rating"] for s in ss])
        f = fit[key]
        print(f"  {key:16} n={f['n']:4}  w={f['w']}  sd={f['sd']:.0f}  R2={f['r2']}")
    ref = round(sum(s["n"] for s in samples) / len(samples))
    (A.HERE / "calibration.json").write_text(json.dumps(
        {"version": 1, "depth": DEPTH, "ref_moves": ref, "samples": len(samples), "fit": fit}, indent=1))
    print("wrote calibration.json")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["collect", "analyze", "fit", "all"])
    ap.add_argument("--seed-users", type=int, default=10, help="seed users per rating band (lichess)")
    ap.add_argument("--per-user", type=int, default=4, help="games taken per seed user")
    ap.add_argument("--per-band", type=int, default=24, help="max games kept per rating band and site")
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--min-samples", type=int, default=40)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    steps = ["collect", "analyze", "fit"] if a.step == "all" else [a.step]
    for s in steps:
        {"collect": cmd_collect, "analyze": cmd_analyze, "fit": cmd_fit}[s](a)


if __name__ == "__main__":
    main()
