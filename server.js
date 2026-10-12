// Zero-dependency local server.
//  - serves public/
//  - POST /api/analyze  -> runs analyze.py (streams progress, saves to history)
//  - POST /api/pos      -> live move/eval through a persistent Stockfish worker
//  - GET  /api/games    -> import recent games from chess.com / lichess by username
//  - GET  /api/history, /api/history/:id, DELETE /api/history/:id
//  - GET  /api/insights?user=
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const REVIEWS = path.join(ROOT, "data", "reviews");
const VERSION = 3;
const PY = fs.existsSync(path.join(ROOT, ".venv")) ? path.join(ROOT, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python") : "python3";
const PROFILES = {   // depth, parallel engines, hash MB each, CPU niceness
  light: { depth: 10, workers: 2, hash: 16, nice: 10 },
  balanced: { depth: 14, workers: 4, hash: 64, nice: 0 },
  deep: { depth: 18, workers: 8, hash: 128, nice: 0 },
};
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
fs.mkdirSync(REVIEWS, { recursive: true });

const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok, no) => {
  let b = ""; req.on("data", (c) => { b += c; if (b.length > 2e6) { req.destroy(); no(new Error("too big")); } });
  req.on("end", () => ok(b)); req.on("error", no);
});

// ---------------------------------------------------------------- history
const reviewPath = (id) => path.join(REVIEWS, id + ".json");
const validId = (id) => /^[a-f0-9]{12}$/.test(id);
const loadReview = (id) => JSON.parse(fs.readFileSync(reviewPath(id), "utf8"));
function allReviews() {
  return fs.readdirSync(REVIEWS).filter((f) => f.endsWith(".json")).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(REVIEWS, f), "utf8")); } catch { return null; }
  }).filter(Boolean);
}
const sortKey = (r) => ((r.headers.Date || "").replace(/\?/g, "0") + " " + (r.headers.UTCTime || "") + " " + (r.saved_at || ""));
function summaryOf(r) {
  const h = r.headers;
  return { id: r.id, white: h.White, black: h.Black, whiteElo: h.WhiteElo, blackElo: h.BlackElo, result: r.result, date: h.Date,
    opening: r.opening && r.opening.name, depth: r.depth, saved_at: r.saved_at, moves: r.moves.length,
    wAcc: r.summary.white.accuracy, bAcc: r.summary.black.accuracy };
}

// ----------------------------------------------------------- analyze (CLI)
async function analyze(req, res) {
  let pgn, depth, profile;
  try { ({ pgn, depth, profile } = JSON.parse(await readBody(req))); } catch { return send(res, 400, { error: "bad json" }); }
  const pf = PROFILES[profile] || PROFILES.balanced;
  depth = Math.min(Math.max(parseInt(depth) || pf.depth, 8), 22);
  pgn = String(pgn || "").trim();
  if (!pgn) return send(res, 400, { error: "empty PGN" });
  const id = crypto.createHash("sha1").update(VERSION + "|" + depth + "|" + pgn.replace(/\s+/g, " ")).digest("hex").slice(0, 12);
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  if (fs.existsSync(reviewPath(id))) return res.end(JSON.stringify({ report: loadReview(id), cached: true }) + "\n");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chess-"));
  const inFile = path.join(dir, "game.pgn"), outFile = path.join(dir, "report.json");
  fs.writeFileSync(inFile, pgn);
  const p = spawn(PY, [path.join(ROOT, "analyze.py"), inFile, "-d", String(depth), "-w", String(pf.workers), "--hash", String(pf.hash), "--nice", String(pf.nice), "-o", outFile]);
  let err = "";
  p.stderr.on("data", (d) => {
    err += d;
    const m = [...d.toString().matchAll(/(\d+)\/(\d+)/g)].pop();
    if (m) res.write(JSON.stringify({ progress: +m[1], total: +m[2] }) + "\n");
  });
  p.on("close", (code) => {
    try {
      if (code !== 0) throw new Error(err.split(/[\r\n]/).filter(Boolean).pop() || "analysis failed");
      const report = JSON.parse(fs.readFileSync(outFile, "utf8"));
      report.id = id; report.saved_at = new Date().toISOString();
      fs.writeFileSync(reviewPath(id), JSON.stringify(report));
      res.end(JSON.stringify({ report }) + "\n");
    } catch (e) { res.end(JSON.stringify({ error: e.message }) + "\n"); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  res.on("close", () => p.kill());
}

// --------------------------------------------------------- live worker
let worker = null, wbuf = "", wid = 0;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = spawn(PY, [path.join(ROOT, "worker.py")], { cwd: ROOT });
  worker.stdout.on("data", (d) => {
    wbuf += d; let i;
    while ((i = wbuf.indexOf("\n")) >= 0) {
      const line = wbuf.slice(0, i); wbuf = wbuf.slice(i + 1);
      try { const o = JSON.parse(line); const p = pending.get(o.id); if (p) { pending.delete(o.id); o.error ? p.no(new Error(o.error)) : p.ok(o); } } catch {}
    }
  });
  worker.stderr.on("data", () => {});
  worker.on("close", () => { for (const p of pending.values()) p.no(new Error("engine stopped")); pending.clear(); worker = null; wbuf = ""; });
  return worker;
}
const workerCall = (req) => new Promise((ok, no) => {
  const id = ++wid; pending.set(id, { ok, no });
  setTimeout(() => { if (pending.delete(id)) no(new Error("engine timeout")); }, 15000);
  getWorker().stdin.write(JSON.stringify({ ...req, id }) + "\n");
});

// --------------------------------------------------------- game import
async function getJson(url, headers) {
  const r = await fetch(url, { headers: { "User-Agent": "chess-review-local", ...headers }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(r.status === 404 ? "user not found" : `${new URL(url).host} returned ${r.status}`);
  return r;
}
async function importGames(site, user) {
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(user)) throw new Error("invalid username");
  if (site === "lichess") {
    const r = await getJson(`https://lichess.org/api/games/user/${user}?max=40&pgnInJson=true&opening=true&clocks=true&evals=false`, { Accept: "application/x-ndjson" });
    return (await r.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((g) => g.variant === "standard" && g.pgn).map((g) => ({
      white: g.players.white.user ? g.players.white.user.name : "Anonymous", black: g.players.black.user ? g.players.black.user.name : "Anonymous",
      whiteElo: g.players.white.rating, blackElo: g.players.black.rating,
      result: g.winner === "white" ? "1-0" : g.winner === "black" ? "0-1" : "1/2-1/2", speed: g.speed, time: g.createdAt, url: "https://lichess.org/" + g.id, pgn: g.pgn }));
  }
  if (site === "chesscom") {
    const arch = await (await getJson(`https://api.chess.com/pub/player/${user.toLowerCase()}/games/archives`)).json();
    const urls = (arch.archives || []).slice(-3).reverse(), out = [];
    for (const u of urls) {
      const month = await (await getJson(u)).json();
      for (const g of (month.games || []).reverse()) {
        if (g.rules !== "chess" || !g.pgn) continue;
        out.push({ white: g.white.username, black: g.black.username, whiteElo: g.white.rating, blackElo: g.black.rating,
          result: g.white.result === "win" ? "1-0" : g.black.result === "win" ? "0-1" : "1/2-1/2", speed: g.time_class, time: g.end_time * 1000, url: g.url, pgn: g.pgn });
      }
      if (out.length >= 40) break;
    }
    return out.slice(0, 40);
  }
  throw new Error("unknown site");
}

// ----------------------------------------------------------- insights
const BAD = new Set(["Miss", "Mistake", "Blunder"]);
function mine(r, user) {
  const u = user.toLowerCase();
  if ((r.headers.White || "").toLowerCase() === u) return "white";
  if ((r.headers.Black || "").toLowerCase() === u) return "black";
  return null;
}
function insights(user) {
  const reviews = allReviews().sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const phases = {}, pieces = {}, bucket = { ahead: [0, 0], even: [0, 0], behind: [0, 0] }, tb = { trouble: [0, 0], normal: [0, 0] }, openings = {}, classTotals = {}, trend = [];
  let games = 0, W = 0, D = 0, L = 0, moves = 0, bad = 0;
  const bump = (o, k, f) => { o[k] = o[k] || { moves: 0, bad: 0, loss: 0 }; f(o[k]); };
  for (const r of reviews) {
    const c = mine(r, user); if (!c) continue;
    games++;
    const res = r.result, won = (res === "1-0" && c === "white") || (res === "0-1" && c === "black");
    const draw = res === "1/2-1/2"; won ? W++ : draw ? D++ : (res === "*" ? 0 : L++);
    const fam = r.opening ? r.opening.name.split(":")[0] : "Unknown";
    const o = (openings[fam] = openings[fam] || { games: 0, w: 0, d: 0, l: 0, acc: 0 });
    o.games++; o.acc += r.summary[c].accuracy || 0; won ? o.w++ : draw ? o.d++ : o.l++;
    trend.push({ date: r.headers.Date, acc: r.summary[c].accuracy, result: won ? "W" : draw ? "D" : "L", id: r.id });
    for (const m of r.moves) {
      if (m.color !== c) continue;
      moves++; const isBad = BAD.has(m.classification); if (isBad) bad++;
      classTotals[m.classification] = (classTotals[m.classification] || 0) + 1;
      bump(phases, m.phase, (x) => { x.moves++; x.bad += isBad; x.loss += m.loss; });
      bump(pieces, /^[KQRBN]/.test(m.san) ? m.san[0] : /^O/.test(m.san) ? "K" : "P", (x) => { x.moves++; x.bad += isBad; x.loss += m.loss; });
      const b = m.win_before >= 65 ? "ahead" : m.win_before <= 35 ? "behind" : "even";
      bucket[b][0]++; bucket[b][1] += isBad;
      if (m.clock != null) { const t = m.time_trouble ? tb.trouble : tb.normal; t[0]++; t[1] += isBad; }
    }
  }
  const rate = (x) => (x.moves ? +(100 * x.bad / x.moves).toFixed(1) : 0);
  const fin = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { moves: v.moves, errors: v.bad, errorRate: rate(v), avgLoss: v.moves ? +(v.loss / v.moves).toFixed(1) : 0 }]));
  const tips = [], ph = fin(phases), pc = fin(pieces), names = { P: "pawn", N: "knight", B: "bishop", R: "rook", Q: "queen", K: "king" };
  const phNames = Object.entries(ph).filter(([, v]) => v.moves >= 10).sort((a, b) => b[1].errorRate - a[1].errorRate);
  if (phNames.length) tips.push(`Most errors happen in the ${phNames[0][0]} (${phNames[0][1].errorRate}% of your moves there are Miss/Mistake/Blunder).`);
  const pcs = Object.entries(pc).filter(([, v]) => v.moves >= 10).sort((a, b) => b[1].errorRate - a[1].errorRate);
  if (pcs.length) tips.push(`${names[pcs[0][0]][0].toUpperCase() + names[pcs[0][0]].slice(1)} moves are your weakest: ${pcs[0][1].errorRate}% errors.`);
  const rb = (k) => (bucket[k][0] ? 100 * bucket[k][1] / bucket[k][0] : 0);
  if (bucket.ahead[0] >= 10 && rb("ahead") > rb("even")) tips.push(`You err more when ahead (${rb("ahead").toFixed(1)}%) than in equal positions (${rb("even").toFixed(1)}%): work on converting advantages.`);
  if (bucket.behind[0] >= 10 && rb("behind") > rb("even") * 1.3) tips.push(`When worse you err ${rb("behind").toFixed(1)}% of the time: practice defending.`);
  const rt = (k) => (tb[k][0] ? 100 * tb[k][1] / tb[k][0] : 0);
  if (tb.trouble[0] >= 10 && rt("trouble") > rt("normal") * 1.3) tips.push(`In time trouble you err ${rt("trouble").toFixed(1)}% of the time vs ${rt("normal").toFixed(1)}% otherwise: manage the clock earlier.`);
  const ops = Object.entries(openings).filter(([, v]) => v.games >= 2).sort((a, b) => (a[1].w - a[1].l) / a[1].games - (b[1].w - b[1].l) / b[1].games);
  if (ops.length && ops[0][1].l > ops[0][1].w) tips.push(`Struggling opening: ${ops[0][0]} (${ops[0][1].w}W-${ops[0][1].d}D-${ops[0][1].l}L).`);
  return { user, games, record: { W, D, L }, moves, errorRate: moves ? +(100 * bad / moves).toFixed(1) : 0,
    avgAccuracy: games ? +(trend.reduce((s, t) => s + (t.acc || 0), 0) / games).toFixed(1) : null, trend, phases: ph, pieces: pc,
    situation: Object.fromEntries(Object.entries(bucket).map(([k, v]) => [k, { moves: v[0], errors: v[1], errorRate: v[0] ? +(100 * v[1] / v[0]).toFixed(1) : 0 }])),
    openings: Object.entries(openings).map(([name, v]) => ({ name, games: v.games, w: v.w, d: v.d, l: v.l, avgAcc: +(v.acc / v.games).toFixed(1) })).sort((a, b) => b.games - a.games),
    time: Object.fromEntries(Object.entries(tb).map(([k, x]) => [k, { moves: x[0], errors: x[1], errorRate: x[0] ? +(100 * x[1] / x[0]).toFixed(1) : 0 }])),
    classTotals, tips };
}
// ------------------------------------------------------------ routing
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"), p = url.pathname;
  try {
    if (req.method === "POST" && p === "/api/analyze") return await analyze(req, res);
    if (req.method === "POST" && p === "/api/pos") return send(res, 200, await workerCall(JSON.parse(await readBody(req))));
    if (p === "/api/games") return send(res, 200, { games: await importGames(url.searchParams.get("site"), url.searchParams.get("user") || "") });
    if (p === "/api/history") return send(res, 200, { reviews: allReviews().sort((a, b) => (b.saved_at || "").localeCompare(a.saved_at || "")).map(summaryOf) });
    const hm = p.match(/^\/api\/history\/([a-f0-9]{12})$/);
    if (hm) {
      if (!fs.existsSync(reviewPath(hm[1]))) return send(res, 404, { error: "not found" });
      if (req.method === "DELETE") { fs.unlinkSync(reviewPath(hm[1])); return send(res, 200, { ok: true }); }
      return send(res, 200, loadReview(hm[1]));
    }
    if (p === "/api/status") return send(res, 200, await workerCall({ cmd: "status" }));
    if (p === "/api/insights") {
      const u = url.searchParams.get("user") || ""; if (!u) return send(res, 400, { error: "username required" });
      return send(res, 200, insights(u));
    }
    if (p.startsWith("/api/")) return send(res, 404, { error: "unknown endpoint" });
    const f = p === "/" ? "index.html" : decodeURIComponent(p).replace(/^\/+/, "");
    const file = path.join(PUBLIC, f);
    if (!file.startsWith(PUBLIC + path.sep)) return res.writeHead(403).end();
    fs.readFile(file, (e, data) => {
      if (e) return res.writeHead(404).end("not found");
      res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" }).end(data);
    });
  } catch (e) { if (!res.headersSent) send(res, 500, { error: e.message }); else res.end(); }
}).listen(PORT, HOST, () => console.log(`Chess Review running at http://localhost:${PORT}`));
