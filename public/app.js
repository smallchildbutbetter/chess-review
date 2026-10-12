"use strict";
// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const api = async (path, opt) => {
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
};
const post = (p, b) => api(p, { method: "POST", body: JSON.stringify(b) });
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const FILES = "abcdefgh";
const CL = {
  Brilliant: ["#1baca6", "!!"], Great: ["#5c8bb0", "!"], Best: ["#81b64c", "★"], Excellent: ["#96bc4b", "✓"], Good: ["#9fa58f", "✓"],
  Book: ["#a88865", "B"], Inaccuracy: ["#f7c631", "?!"], Miss: ["#ee6b55", "×"], Mistake: ["#e58f2a", "?"], Blunder: ["#ca3431", "??"],
};
const BAD = ["Miss", "Mistake", "Blunder"];
const tag = (c) => `<span class="tag ${c}" style="background:${CL[c][0]}">${CL[c][1]} ${c}</span>`;
const fmtEval = (v) => (Math.abs(v) >= 10 ? (v > 0 ? "+M" : "-M") : (v > 0 ? "+" : "") + v.toFixed(2));
const me = () => ($("me").value || "").trim();

// ------------------------------------------------------------------ sound
let ac;
function beep(kind) {
  if (!$("snd").checked) return;
  try {
    ac = ac || new AudioContext();
    const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
    o.type = "triangle"; o.frequency.value = kind === "cap" ? 170 : kind === "chk" ? 520 : 260;
    g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + (kind === "cap" ? 0.16 : 0.09));
    o.connect(g); g.connect(ac.destination); o.start(); o.stop(t + 0.2);
  } catch {}
}
const soundFor = (san) => (/[+#]/.test(san) ? "chk" : /x/.test(san) ? "cap" : "mv");

// ------------------------------------------------------------------ board
function parseFen(fen) {
  const m = {};
  fen.split(" ")[0].split("/").forEach((row, r) => {
    let f = 0;
    for (const ch of row) { if (/\d/.test(ch)) f += +ch; else { m[FILES[f] + (8 - r)] = ch; f++; } }
  });
  return m;
}

const SETS = [["cburnett", "Classic"], ["merida", "Merida"], ["alpha", "Alpha"], ["california", "California"], ["pirouetti", "Pirouetti"],
  ["kosal", "Kosal"], ["anarcandy", "Anarcandy"], ["fantasy", "Fantasy"], ["mpchess", "MP Chess"], ["bold", "Classic bold"], ["glyph", "Text glyphs"]];
let PSET = LS.get("pset", "cburnett");
if (!SETS.some((s) => s[0] === PSET)) PSET = "cburnett";
const setDir = () => (PSET === "bold" ? "cburnett" : PSET);
const GLYPH = { K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟" };
function pieceHtml(p) {
  const w = p === p.toUpperCase() ? "w" : "b", u = p.toUpperCase();
  return PSET === "glyph" ? `<span class="pc g ${w}">${GLYPH[u]}\uFE0E</span>` : `<img class="pc" draggable="false" src="pieces/${setDir()}/${w}${u}.svg">`;
}

class Board {
  constructor(el, onMove) {
    this.el = el; this.onMove = onMove;
    this.s = { fen: "8/8/8/8/8/8/8/8 w - - 0 1", flip: false, last: null, legal: [], badge: null, arrows: [], interactive: false, hint: null, sel: null };
    el.innerHTML = '<div class="grid"></div><svg class="ov" viewBox="0 0 8 8"></svg><div class="badge"></div>';
    [this.grid, this.svg, this.badge] = el.children;
    el.addEventListener("pointerdown", (e) => this.down(e));
  }
  name(c, r) { const f = this.s.flip ? 7 - c : c, rk = this.s.flip ? r : 7 - r; return FILES[f] + (rk + 1); }
  pos(n) { const f = FILES.indexOf(n[0]), rk = +n[1] - 1; return this.s.flip ? [7 - f, rk] : [f, 7 - rk]; }
  set(opts, animate) { Object.assign(this.s, opts); this.render(animate); }
  render(animate) {
    const s = this.s, pcs = parseFen(s.fen), lf = {};
    for (const u of s.legal) (lf[u.slice(0, 2)] = lf[u.slice(0, 2)] || new Set()).add(u.slice(2, 4));
    this.lf = lf;
    let h = "";
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const n = this.name(c, r), p = pcs[n], cls = ["sq", (r + c) % 2 === 0 ? "l" : "d"];
      if (s.last && s.last.includes(n)) cls.push("hl");
      if (s.sel === n) cls.push("sel");
      if (s.hint === n) cls.push("hint");
      let inner = "";
      if (c === 0) inner += `<i class="r">${n[1]}</i>`;
      if (r === 7) inner += `<i class="f">${n[0]}</i>`;
      if (p) inner += pieceHtml(p);
      if (s.sel && lf[s.sel] && lf[s.sel].has(n)) inner += p ? '<div class="ring"></div>' : '<div class="dot"></div>';
      h += `<div class="${cls.join(" ")}" data-n="${n}">${inner}</div>`;
    }
    this.grid.className = "grid set-" + PSET;
    this.grid.innerHTML = h;
    // arrows
    let a = '<defs><marker id="ah" markerWidth="3" markerHeight="3" refX="1.6" refY="1.5" orient="auto"><path d="M0,0 L3,1.5 L0,3z" fill="#81b64c"/></marker></defs>';
    for (const ar of s.arrows) {
      const [x1, y1] = this.pos(ar.from), [x2, y2] = this.pos(ar.to);
      a += `<line x1="${x1 + .5}" y1="${y1 + .5}" x2="${x2 + .5}" y2="${y2 + .5}" stroke="${ar.color || "#81b64c"}" stroke-width=".16" opacity=".85" marker-end="url(#ah)"/>`;
    }
    this.svg.innerHTML = a;
    // badge
    const b = this.badge;
    if (s.badge) {
      const [x, y] = this.pos(s.badge.sq);
      b.style.display = "block"; b.style.left = x * 12.5 + "%"; b.style.top = y * 12.5 + "%";
      b.style.background = s.badge.color; b.textContent = s.badge.label;
    } else b.style.display = "none";
    // slide animation for the piece that just moved
    if (animate && s.last) {
      const [f, t] = s.last, img = this.grid.querySelector(`[data-n="${t}"] .pc`);
      if (img) {
        const [fc, fr] = this.pos(f), [tc, tr] = this.pos(t);
        img.style.transition = "none"; img.style.transform = `translate(${(fc - tc) * 100}%,${(fr - tr) * 100}%)`;
        requestAnimationFrame(() => requestAnimationFrame(() => { img.style.transition = "transform .14s ease-out"; img.style.transform = "none"; }));
      }
    }
  }
  sqAt(e) {
    const r = this.grid.getBoundingClientRect();
    const c = Math.floor((e.clientX - r.left) / r.width * 8), rw = Math.floor((e.clientY - r.top) / r.height * 8);
    return c < 0 || c > 7 || rw < 0 || rw > 7 ? null : this.name(c, rw);
  }
  down(e) {
    if (!this.s.interactive || e.button > 0) return;
    const n = this.sqAt(e); if (!n) return;
    const s = this.s, lf = this.lf || {};
    if (s.sel && s.sel !== n && lf[s.sel] && lf[s.sel].has(n)) return this.commit(s.sel, n);
    const pcs = parseFen(s.fen);
    if (pcs[n] && lf[n]) {
      s.sel = n; this.render();
      const img = this.grid.querySelector(`[data-n="${n}"] .pc`);
      const ghost = img.cloneNode(true); ghost.className = img.className + " drag"; ghost.style.width = img.clientWidth + "px"; ghost.style.fontSize = getComputedStyle(img).fontSize;
      document.body.appendChild(ghost); img.style.opacity = 0.35;
      const mv = (ev) => { ghost.style.left = ev.clientX + "px"; ghost.style.top = ev.clientY + "px"; };
      mv(e);
      const up = (ev) => {
        removeEventListener("pointermove", mv); removeEventListener("pointerup", up); ghost.remove(); img.style.opacity = 1;
        const t = this.sqAt(ev);
        if (t && t !== n && lf[n].has(t)) this.commit(n, t);
        else if (t !== n) { s.sel = null; this.render(); }
      };
      addEventListener("pointermove", mv); addEventListener("pointerup", up);
    } else { s.sel = null; this.render(); }
  }
  commit(from, to) {
    const u = from + to, L = this.s.legal;
    const m = L.includes(u) ? u : (L.find((x) => x.startsWith(u)) || u);
    this.s.sel = null; this.render(); this.onMove(m);
  }
}

// ------------------------------------------------------------------ themes
const THEMES = [["#ebecd0", "#739552"], ["#dee3e6", "#8ca2ad"], ["#f0d9b5", "#b58863"], ["#e8e0f0", "#7b61a8"]];
function setTheme(i) {
  document.documentElement.style.setProperty("--light", THEMES[i][0]);
  document.documentElement.style.setProperty("--dark", THEMES[i][1]);
  [...$("themes").children].forEach((e, k) => e.classList.toggle("on", k === i));
  LS.set("theme", i);
}
$("themes").innerHTML = THEMES.map((t, i) => `<span style="background:linear-gradient(135deg,${t[0]} 50%,${t[1]} 50%)" data-i="${i}"></span>`).join("");
$("themes").onclick = (e) => { if (e.target.dataset.i) setTheme(+e.target.dataset.i); };

// ------------------------------------------------------------------- tabs
function showTab(t) {
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  document.querySelectorAll("section.tab").forEach((s) => s.classList.toggle("on", s.id === "tab-" + t));
  LS.set("tab", t);
  if (t === "history") loadHistory();
  if (t === "insights") loadInsights();
}
$("nav").onclick = (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); };
const curTab = () => document.querySelector("section.tab.on").id.slice(4);

// ----------------------------------------------------------------- review
let R = null, cur = 0, X = null, timer = null;
const board = new Board($("board"), (uci) => tryMove(uci));

function mainPos(i) {
  const n = R.moves.length, m = i > 0 ? R.moves[i - 1] : null;
  return { fen: i < n ? R.moves[i].fen_before : R.final_fen, legal: i < n ? R.moves[i].legal_before : R.final_legal,
    last: m ? [m.uci.slice(0, 2), m.uci.slice(2, 4)] : null, row: m, ev: m ? m.eval_after : R.eval_series_white_pov[0] };
}
const curPos = () => (X ? X.steps[X.idx] : mainPos(cur));

$("go").onclick = analyze;
async function analyze() {
  $("err").textContent = ""; const pgn = $("pgn").value.trim(); if (!pgn) return;
  $("go").disabled = true; $("bar").style.display = "block"; $("bar").firstChild.style.width = "0";
  try {
    const r = await fetch("/api/analyze", { method: "POST", body: JSON.stringify({ pgn, profile: $("profile").value }) });
    if (!r.ok) throw new Error((await r.json()).error);
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l) continue;
        const j = JSON.parse(l);
        if (j.progress != null) $("bar").firstChild.style.width = (100 * j.progress / j.total) + "%";
        if (j.error) throw new Error(j.error);
        if (j.report) showReport(j.report);
      }
    }
  } catch (e) { $("err").textContent = e.message; }
  $("go").disabled = false; $("bar").style.display = "none";
}

const ORDER = ["Brilliant", "Great", "Best", "Excellent", "Good", "Book", "Inaccuracy", "Mistake", "Miss", "Blunder"];
const TBTXT = { W: "White wins", D: "Draw", L: "Black wins" };
const fmtClock = (s) => (s == null ? "–" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`);
function summaryCard() {
  const s = R.summary, h = R.headers, nm = (n) => `<div class="nm" title="${esc(n)}">${esc(n)}</div>`;
  let g = `<div class="sumcard"><div></div>${nm(h.White || "White")}<div></div>${nm(h.Black || "Black")}`;
  g += `<div>Accuracy</div><div class="tile w">${s.white.accuracy}</div><div></div><div class="tile b">${s.black.accuracy}</div>`;
  if (s.white.rating) g += `<div title="Rough estimate from average centipawn loss, not an official rating">Est. game rating</div><div class="tile w" style="font-size:15px">${s.white.rating}</div><div></div><div class="tile b" style="font-size:15px">${s.black.rating}</div>`;
  g += "<hr>";
  for (const k of ORDER.filter((k) => s.white.counts[k] || s.black.counts[k]))
    g += `<div>${k}</div><div class="v" style="color:${CL[k][0]}">${s.white.counts[k]}</div><div class="ic" style="background:${CL[k][0]}">${CL[k][1]}</div><div class="v" style="color:${CL[k][0]}">${s.black.counts[k]}</div>`;
  g += "<hr>";
  for (const p of ["opening", "middlegame", "endgame"]) {
    const a = (c) => (s[c].phases[p].accuracy == null ? "–" : s[c].phases[p].accuracy);
    g += `<div class="mut">${p} accuracy</div><div class="v mut">${a("white")}</div><div></div><div class="v mut">${a("black")}</div>`;
  }
  return g + "</div>";
}
function timePanel() {
  const ok = R.clocks && R.moves.some((m) => m.time_spent != null);
  $("timepanel").style.display = ok ? "block" : "none";
  if (!ok) return;
  const n = R.moves.length, base = R.clocks.base || Math.max(...R.moves.map((m) => m.clock || 0)) || 1;
  const x = (i) => (i + 0.5) / n * 400, cy = (c) => 52 - Math.min(1, c / base) * 46;
  const line = (col) => R.moves.map((m, i) => (m.color === col && m.clock != null ? `${x(i)},${cy(m.clock)}` : null)).filter(Boolean).join(" ");
  const maxT = Math.max(5, ...R.moves.map((m) => m.time_spent || 0)), bw = Math.max(1.5, 400 / n * 0.7);
  let bars = "";
  R.moves.forEach((m, i) => {
    if (m.time_spent == null) return;
    const hgt = Math.sqrt(m.time_spent / maxT) * 48, bad = BAD.includes(m.classification);
    bars += `<rect x="${x(i) - bw / 2}" y="${118 - hgt}" width="${bw}" height="${Math.max(hgt, 0.8)}" fill="${bad ? CL[m.classification][0] : m.color === "white" ? "#ddd" : "#777"}"><title>${m.move_number}${m.color === "white" ? "." : "..."} ${m.san}: ${m.time_spent}s</title></rect>`;
  });
  const idx = X ? X.base : cur;
  $("tgraph").innerHTML = `<rect width="400" height="120" style="fill:var(--bg)"/><line x1="0" x2="400" y1="${cy(R.clocks.trouble_at)}" y2="${cy(R.clocks.trouble_at)}" stroke="#ca3431" stroke-dasharray="3 3" opacity=".6"/>
    <polyline fill="none" stroke="#eee" stroke-width="1.6" points="${line("white")}"/><polyline fill="none" stroke="#888" stroke-width="1.6" points="${line("black")}"/>${bars}
    ${idx > 0 ? `<line x1="${x(idx - 1)}" x2="${x(idx - 1)}" y1="0" y2="120" stroke="#f6f669" stroke-width="2"/>` : ""}`;
  const t = (c) => R.summary[c].time;
  if (t("white") && t("black")) {
    const er = (q) => `${q.errors}/${q.moves}`;
    const row = (l, f) => `<tr><td>${l}</td><td>${f(t("white"))}</td><td>${f(t("black"))}</td></tr>`;
    $("tsum").innerHTML = `<table><tr><th></th><th>White</th><th>Black</th></tr>` +
      row("Avg time / move", (x) => x.avg + "s") + row("Longest think", (x) => `${esc(x.longest.san)} (${x.longest.secs}s)`) +
      row("Moves in time trouble", (x) => x.trouble_moves) + row("Errors in time trouble", (x) => er({ errors: x.errors_in_trouble, moves: x.trouble_moves })) +
      row("Errors otherwise", (x) => er({ errors: x.errors_normal, moves: x.normal_moves })) + row("Rushed errors (≤2s)", (x) => x.rushed_errors) + "</table>" +
      '<div class="mut" style="font-size:12px;margin-top:4px">Lines: clock remaining (dashed = time-trouble line). Bars: time spent; coloured bars are Miss/Mistake/Blunder.</div>';
  }
}
$("tgraph").onclick = (ev) => { const b = ev.currentTarget.getBoundingClientRect(); go(Math.round((ev.clientX - b.left) / b.width * R.moves.length)); };

function showReport(rep) {
  R = rep; X = null; cur = 0; clearInterval(timer);
  showTab("review");
  $("review").style.display = "grid";
  $("opening").textContent = R.opening ? `📖 ${R.opening.eco} · ${R.opening.name}` : "";
  const h = R.headers, u = me().toLowerCase();
  $("flip").checked = !!u && (h.Black || "").toLowerCase() === u;
  $("sum").innerHTML = summaryCard();
  timePanel();
  let mh = "";
  R.moves.forEach((m, i) => {
    if (m.color === "white") mh += `<span class="n">${m.move_number}.</span>`;
    mh += `<span class="m" data-i="${i + 1}"><span class="dotc" style="background:${CL[m.classification][0]}"></span>${esc(m.san)}</span>`;
  });
  $("moves").innerHTML = mh;
  draw(false);
}
$("moves").onclick = (e) => { const m = e.target.closest(".m"); if (m) go(+m.dataset.i); };

function draw(animate) {
  if (!R) return;
  const P = curPos(), row = X ? null : P.row, arrows = [];
  let badge = null;
  if (row) {
    badge = { sq: row.uci.slice(2, 4), label: CL[row.classification][1], color: CL[row.classification][0] };
    if ($("arrow").checked && ["Inaccuracy", "Miss", "Mistake", "Blunder"].includes(row.classification) && row.engine_uci)
      arrows.push({ from: row.engine_uci.slice(0, 2), to: row.engine_uci.slice(2, 4) });
  } else if (X && P.best && $("arrow").checked) arrows.push({ from: P.best.slice(0, 2), to: P.best.slice(2, 4) });
  board.set({ fen: P.fen, flip: $("flip").checked, last: P.last, legal: P.legal, interactive: true, badge, arrows, sel: null, hint: null }, animate);
  evalbar(P.ev);
  players(); info(); graph(); if (R.clocks) timePanel(); refreshLines();
  document.querySelectorAll("#moves .m").forEach((e) => e.classList.toggle("cur", !X && +e.dataset.i === cur));
  const c = document.querySelector("#moves .cur"); if (c) c.scrollIntoView({ block: "nearest" });
}

function evalbar(v) {
  const fl = $("flip").checked, t = $("evaltxt");
  if (v == null) { t.textContent = "…"; return; }
  const p = 50 + 50 * (2 / (1 + Math.exp(-0.4 * v)) - 1);
  $("evalfill").style.height = (fl ? 100 - p : p) + "%"; $("evalfill").style.background = fl ? "#222" : "#fff";
  $("evalbar").style.background = fl ? "#fff" : "#403d39";
  const atTop = (v >= 0) === fl;
  t.textContent = (v > 0 ? "+" : "") + (Math.abs(v) >= 10 ? "M" : v.toFixed(1));
  t.style.top = atTop ? "2px" : "auto"; t.style.bottom = atTop ? "auto" : "2px"; t.style.color = atTop ? "#fff" : "#222";
  if (!fl) { t.style.color = v >= 0 ? "#222" : "#fff"; t.style.top = v >= 0 ? "auto" : "2px"; t.style.bottom = v >= 0 ? "2px" : "auto"; }
}
function players() {
  const h = R.headers, fl = $("flip").checked;
  const w = [h.White || "White", h.WhiteElo ? `(${h.WhiteElo})` : ""], b = [h.Black || "Black", h.BlackElo ? `(${h.BlackElo})` : ""];
  const [t, bt] = fl ? [w, b] : [b, w];
  $("ptop").textContent = (fl ? "○ " : "● ") + t[0]; $("rtop").textContent = t[1];
  $("pbot").textContent = (fl ? "● " : "○ ") + bt[0]; $("rbot").textContent = bt[1];
}
function info() {
  const P = curPos(), box = $("info");
  if (X) {
    const sans = X.steps.slice(1, X.idx + 1).map((s) => s.san).join(" ");
    let h = `<div class="expbanner"><b>${X.line ? "Engine line" : "Variation"}</b> <span>${esc(sans) || "start"}</span><button class="sec sm" id="xexit">Back to game (Esc)</button>${X.line ? '<button class="sec sm" id="xplay">▶ Replay</button>' : ""}</div>`;
    if (P.tb) h += `<span class="tag" style="background:#8d6fd1;color:#fff">Tablebase: ${TBTXT[P.tb]}</span>`;
    else if (P.ev != null) h += `Eval <b>${fmtEval(P.ev)}</b>${P.over ? ` · game over ${esc(P.result || "")}` : ""}`;
    else h += '<span class="mut">engine thinking…</span>';
    if (P.pv && P.pv.length) h += `<br><span class="mut">Engine: ${esc(P.pv.join(" "))}</span>`;
    box.innerHTML = h;
    $("xexit").onclick = exitX; if ($("xplay")) $("xplay").onclick = () => playLine(X.src);
    return;
  }
  const m = P.row;
  if (!m) { box.innerHTML = `<b class="big">${esc(R.headers.White || "White")} vs ${esc(R.headers.Black || "Black")}</b><br><span class="mut">${esc(R.result)} · depth ${R.depth}</span>`; return; }
  let h = `<b class="big">${m.move_number}${m.color === "white" ? "." : "..."} ${esc(m.san)}</b> ${tag(m.classification)}<br>${m.tb_after ? `<span class="tag" style="background:#8d6fd1;color:#fff">Tablebase: ${TBTXT[m.tb_after]}</span>` : `Eval ${fmtEval(m.eval_after)}`} · win chance lost ${m.loss}%` +
    (m.time_spent != null ? `<br><span class="mut">⏱ ${m.time_spent}s · ${fmtClock(m.clock)} left${m.time_trouble ? " · time trouble" : ""}</span>` : "");
  if (!["Best", "Brilliant", "Great", "Book", "Excellent"].includes(m.classification) && m.engine_best)
    h += `<br>Engine preferred <b>${esc(m.engine_best)}</b>: <span class="line" id="engline">${esc(m.engine_line.slice(1, 5).join(" ")) || "▶ play"} ▶</span>`;
  box.innerHTML = h;
  if ($("engline")) $("engline").onclick = () => playLine({ fen: m.fen_before, legal: m.legal_before, ucis: (m.engine_line_uci || [m.engine_uci]).slice(0, 5), ev: m.eval_before, base: Math.max(cur - 1, 0) });
}
function graph() {
  const e = R.eval_series_white_pov, n = e.length - 1 || 1, y = (v) => 40 - Math.max(-5, Math.min(5, v)) * 8, x = (i) => i / n * 400;
  const pts = e.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  let d = "";
  R.moves.forEach((m, i) => { if (["Brilliant", "Great", ...BAD].includes(m.classification)) d += `<circle cx="${x(i + 1)}" cy="${y(m.eval_after)}" r="2.6" fill="${CL[m.classification][0]}"/>`; });
  const idx = X ? X.base : cur;
  $("graph").innerHTML = `<rect width="400" height="80" style="fill:var(--bg)"/><polygon points="0,40 ${pts} 400,40" style="fill:var(--gfill)" opacity=".85"/><line x1="0" x2="400" y1="40" y2="40" style="stroke:var(--gline)"/>${d}<line x1="${x(idx)}" x2="${x(idx)}" y1="0" y2="80" stroke="#f6f669" stroke-width="2"/>`;
}
$("graph").onclick = (ev) => { const b = ev.currentTarget.getBoundingClientRect(); go(Math.round((ev.clientX - b.left) / b.width * R.moves.length)); };

function go(i, animate) {
  if (!R) return;
  clearInterval(timer); X = null;
  const prev = cur; cur = Math.max(0, Math.min(R.moves.length, i));
  if (cur !== prev && cur > 0 && animate !== false) beep(soundFor(R.moves[cur - 1].san));
  draw(animate !== false && Math.abs(cur - prev) === 1 && cur > prev);
}
function step(d) {
  if (!R) return;
  if (X) {
    clearInterval(timer); X.idx += d;
    if (X.idx < 0) return exitX();
    X.idx = Math.min(X.idx, X.steps.length - 1);
    const s = X.steps[X.idx]; if (s.san) beep(soundFor(s.san));
    return draw(d > 0);
  }
  go(cur + d);
}
function exitX() { clearInterval(timer); if (X) { cur = X.base; X = null; draw(false); } }

async function tryMove(uci) {
  if (!R) return;
  const P = curPos();
  if (!X) { const nx = R.moves[cur]; if (nx && nx.uci === uci) return go(cur + 1); }
  let res; try { res = await post("/api/pos", { fen: P.fen, moves: [uci] }); } catch { return; }
  const st = res.steps[0];
  if (!X) X = { base: cur, steps: [{ ...P, row: null }], idx: 0 };
  X.steps = X.steps.slice(0, X.idx + 1);
  const ns = { fen: st.fen, legal: res.legal, last: [st.uci.slice(0, 2), st.uci.slice(2, 4)], san: st.san, uci: st.uci, ev: null, over: res.over, result: res.result };
  X.steps.push(ns); X.idx++;
  beep(soundFor(st.san)); draw(true); evalStep(ns);
}
async function evalStep(s) {
  try {
    const r = await getEngine(s.fen);
    s.ev = r.eval.cp / 100; s.best = r.eval.best_uci; s.pv = r.eval.pv_san; if (r.tb) s.tb = r.tb;
  } catch { s.ev = s.ev == null ? 0 : s.ev; }
  if (X && curPos() === s) draw(false);
}
async function playLine(src) {
  clearInterval(timer);
  let res; try { res = await post("/api/pos", { fen: src.fen, moves: src.ucis }); } catch { return; }
  const base = { fen: src.fen, legal: src.legal || [], last: null, row: null, ev: src.ev };
  X = { base: src.base == null ? cur : src.base, line: true, src, idx: 0,
    steps: [base, ...res.steps.map((st) => ({ fen: st.fen, legal: [], last: [st.uci.slice(0, 2), st.uci.slice(2, 4)], san: st.san, uci: st.uci, ev: src.ev }))] };
  draw(false);
  timer = setInterval(() => {
    if (!X || X.idx >= X.steps.length - 1) return clearInterval(timer);
    X.idx++; beep(soundFor(X.steps[X.idx].san)); draw(true);
  }, 850);
}

// ----------------------------------------------------- live engine lines
const PROFILE_LIVE = { light: { ms: 450, threads: 1, hash: 16 }, balanced: { ms: 900, threads: 2, hash: 64 }, deep: { ms: 1600, threads: 4, hash: 128 } };
function applyProfile() {
  const p = $("profile").value; LS.set("profile", p); engCache.clear();
  post("/api/pos", { cmd: "config", threads: PROFILE_LIVE[p].threads, hash: PROFILE_LIVE[p].hash }).catch(() => {});
  if (R) refreshLines();
}
const engCache = new Map();
let linesTok = 0, linesTimer = null;
function getEngine(fen) {
  if (engCache.has(fen)) return engCache.get(fen);
  const p = post("/api/pos", { fen, moves: [], eval: true, multipv: 3, ms: PROFILE_LIVE[$("profile").value].ms }).catch((e) => { engCache.delete(fen); throw e; });
  engCache.set(fen, p);
  if (engCache.size > 300) engCache.delete(engCache.keys().next().value);
  return p;
}
function refreshLines() {
  const box = $("lines"), P = curPos(), fen = P.fen;
  if (!$("linesOn").checked) { box.textContent = "Engine lines are off."; $("tbnote").style.display = "none"; return; }
  const tok = ++linesTok; clearTimeout(linesTimer);
  const cached = engCache.has(fen);
  if (!cached) box.innerHTML = '<span class="mut">thinking…</span>';
  linesTimer = setTimeout(async () => {
    let r; try { r = await getEngine(fen); } catch { if (tok === linesTok) box.textContent = "Engine unavailable."; return; }
    if (tok !== linesTok) return;
    const tn = $("tbnote");
    if (r.tb) { tn.style.display = ""; tn.textContent = "Tablebase: " + TBTXT[r.tb]; } else tn.style.display = "none";
    if (!r.lines) { box.innerHTML = `<span class="mut">Game over${r.result ? " · " + esc(r.result) : ""}</span>`; return; }
    box.innerHTML = r.lines.map((l, i) => {
      const v = l.cp / 100;
      return `<div class="eline" data-i="${i}"><span class="ev ${v >= 0 ? "pos" : "neg"}">${fmtEval(v)}</span><span class="mv"><b>${esc(l.pv_san[0] || "")}</b> ${esc(l.pv_san.slice(1, 7).join(" "))}</span></div>`;
    }).join("") + `<div class="mut" style="font-size:11px;margin-top:2px">depth ${r.lines[0].depth || "?"} · click a line to play it</div>`;
    box._lines = r.lines; box._P = P;
  }, cached ? 0 : 250);
}
$("lines").onclick = (e) => {
  const el = e.target.closest(".eline"); if (!el || !$("lines")._lines) return;
  const l = $("lines")._lines[+el.dataset.i], P = $("lines")._P;
  playLine({ fen: P.fen, legal: P.legal, ucis: l.pv_uci.slice(0, 8), ev: l.cp / 100, base: X ? X.base : cur });
};
$("linesOn").checked = LS.get("linesOn", true);
$("linesOn").onchange = () => { LS.set("linesOn", $("linesOn").checked); if (R) refreshLines(); };

$("first").onclick = () => go(0); $("prev").onclick = () => step(-1); $("next").onclick = () => step(1); $("last").onclick = () => go(1e9);
$("flip").onchange = () => draw(false); $("arrow").onchange = () => draw(false);
$("snd").checked = LS.get("snd", true); $("snd").onchange = () => LS.set("snd", $("snd").checked);
$("dlpgn").onclick = () => {
  if (!R) return;
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(R, null, 2)], { type: "application/json" }));
  a.download = "game_report.json"; a.click();
};

addEventListener("keydown", (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "m") { $("snd").checked = !$("snd").checked; LS.set("snd", $("snd").checked); return; }
  if (curTab() !== "review" || !R) return;
  if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
  else if (e.key === "ArrowUp" || e.key === "Home") { e.preventDefault(); go(0); }
  else if (e.key === "ArrowDown" || e.key === "End") { e.preventDefault(); go(1e9); }
  else if (e.key === "Escape") exitX();
  else if (k === "f") { $("flip").checked = !$("flip").checked; draw(false); }
  else if (k === "a") { $("arrow").checked = !$("arrow").checked; draw(false); }
});

// ----------------------------------------------------------------- import
$("load").onclick = loadGames;
async function loadGames() {
  const u = $("impuser").value.trim(); $("imperr").textContent = ""; if (!u) return;
  LS.set("impuser", u); LS.set("site", $("site").value);
  $("gamelist").innerHTML = '<span class="mut">Loading…</span>';
  try {
    const { games } = await api(`/api/games?site=${$("site").value}&user=${encodeURIComponent(u)}`);
    if (!me()) { $("me").value = u; LS.set("me", u); }
    $("gamelist").innerHTML = games.length ? games.map((g, i) => {
      const mine = g.white.toLowerCase() === u.toLowerCase() ? "w" : "b";
      const r = g.result === "1/2-1/2" ? "draw" : (g.result === "1-0") === (mine === "w") ? "win" : "loss";
      const opp = mine === "w" ? `${g.black} (${g.blackElo || "?"})` : `${g.white} (${g.whiteElo || "?"})`;
      return `<div class="it"><span class="res ${r}">${r === "win" ? "Won" : r === "loss" ? "Lost" : "Draw"}</span>
        <div class="grow">${mine === "w" ? "⚪" : "⚫"} vs <b>${esc(opp)}</b><br><span class="mut" style="font-size:12px">${esc(g.speed)} · ${new Date(g.time).toLocaleDateString()}</span></div>
        <button class="sm" data-i="${i}">Review</button></div>`;
    }).join("") : '<span class="mut">No standard games found.</span>';
    $("gamelist")._games = games;
  } catch (e) { $("gamelist").innerHTML = ""; $("imperr").textContent = e.message; }
}
$("gamelist").onclick = (e) => {
  const b = e.target.closest("button[data-i]"); if (!b) return;
  $("pgn").value = $("gamelist")._games[+b.dataset.i].pgn; showTab("review"); analyze();
};

// ----------------------------------------------------------------- history
async function loadHistory() {
  const box = $("histlist");
  try {
    const { reviews } = await api("/api/history");
    box.innerHTML = reviews.length ? reviews.map((r) => `<div class="it">
      <span class="res">${esc(r.result)}</span>
      <div class="grow"><b>${esc(r.white)}</b> vs <b>${esc(r.black)}</b><br><span class="mut" style="font-size:12px">${esc(r.date || "")} · ${esc(r.opening || "unknown opening")} · ${r.moves} plies · depth ${r.depth}</span></div>
      <span class="mut">${r.wAcc}% / ${r.bAcc}%</span>
      <button class="sm" data-open="${r.id}">Open</button><button class="sm sec" data-del="${r.id}">✕</button></div>`).join("")
      : '<span class="mut">No reviews yet. Analyze a game and it is saved here automatically.</span>';
  } catch (e) { box.textContent = e.message; }
}
$("histlist").onclick = async (e) => {
  const o = e.target.closest("[data-open]"), d = e.target.closest("[data-del]");
  if (o) showReport(await api("/api/history/" + o.dataset.open));
  if (d && confirm("Delete this saved review?")) { await api("/api/history/" + d.dataset.del, { method: "DELETE" }); loadHistory(); }
};

// ---------------------------------------------------------------- insights
$("insgo").onclick = loadInsights;
async function loadInsights() {
  $("insuser").textContent = me() || "(set “Me” above)";
  const box = $("insbody");
  if (!me()) { box.innerHTML = '<div class="panel mut">Enter your username in the “Me” box (top right). Games are matched by player name.</div>'; return; }
  let d; try { d = await api("/api/insights?user=" + encodeURIComponent(me())); } catch (e) { box.textContent = e.message; return; }
  if (!d.games) { box.innerHTML = '<div class="panel mut">No saved games where a player is named “' + esc(me()) + '”. Import and review a few games first.</div>'; return; }
  const card = (v, l) => `<div class="card"><b>${v}</b><span>${l}</span></div>`;
  const tbl = (obj, label, names) => `<table><tr><th>${label}</th><th>moves</th><th>errors</th><th>error rate</th><th>avg win% lost</th></tr>` +
    Object.entries(obj).map(([k, v]) => `<tr><td>${(names && names[k]) || k}</td><td>${v.moves}</td><td>${v.errors}</td><td>${v.errorRate}%</td><td>${v.avgLoss ?? ""}</td></tr>`).join("") + "</table>";
  const t = d.trend, W = 400, H = 90;
  const px = (i) => 10 + (t.length < 2 ? 190 : i / (t.length - 1) * (W - 20)), py = (a) => H - 8 - (a || 0) / 100 * (H - 16);
  const spark = `<svg viewBox="0 0 ${W} ${H}" width="100%"><polyline fill="none" stroke="#888" stroke-width="1.5" points="${t.map((p, i) => px(i) + "," + py(p.acc)).join(" ")}"/>` +
    t.map((p, i) => `<circle cx="${px(i)}" cy="${py(p.acc)}" r="3.5" fill="${p.result === "W" ? "#81b64c" : p.result === "L" ? "#ca3431" : "#9a978f"}"><title>${esc(p.date || "")} · ${p.acc}% · ${p.result}</title></circle>`).join("") + "</svg>";
  const pn = { P: "Pawn", N: "Knight", B: "Bishop", R: "Rook", Q: "Queen", K: "King/castling" }, sn = { ahead: "when ahead", even: "equal", behind: "when behind" };
  box.innerHTML = `<div class="cards">${card(d.games, "games")}${card(`${d.record.W}-${d.record.D}-${d.record.L}`, "W-D-L")}${card(d.avgAccuracy + "%", "avg accuracy")}${card(d.errorRate + "%", "moves that are Miss/Mistake/Blunder")}</div>
   ${d.tips.length ? `<div class="panel"><h2>Weak spots</h2><ul class="tips">${d.tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
   <div class="panel"><h2>Accuracy per game <span class="mut" style="font-weight:400;font-size:12px">(green win · red loss)</span></h2>${spark}</div>
   <div class="panel">${tbl(d.phases, "Phase")}</div><div class="panel">${tbl(d.pieces, "Piece moved", pn)}</div>
   <div class="panel">${tbl(d.situation, "Position", sn)}</div>
   ${d.time && d.time.trouble.moves + d.time.normal.moves ? `<div class="panel">${tbl(d.time, "Clock", { trouble: "time trouble", normal: "normal" })}</div>` : ""}
   <div class="panel"><table><tr><th>Opening</th><th>games</th><th>W-D-L</th><th>avg acc</th></tr>${d.openings.map((o) => `<tr><td>${esc(o.name)}</td><td>${o.games}</td><td>${o.w}-${o.d}-${o.l}</td><td>${o.avgAcc}%</td></tr>`).join("")}</table></div>`;
}

// -------------------------------------------------------------------- init
$("me").value = LS.get("me", ""); $("me").onchange = () => { LS.set("me", me()); if (!$("impuser").value) $("impuser").value = me(); };
$("impuser").value = LS.get("impuser", me()); $("site").value = LS.get("site", "chesscom");
setTheme(LS.get("theme", 0));
board.set({ fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" });
showTab(["review","import","history","insights"].includes(LS.get("tab", "review")) ? LS.get("tab", "review") : "review");

// ---------------------------------------------------------------- display
$("pset").innerHTML = SETS.map((s) => `<option value="${s[0]}">${s[1]}</option>`).join("");
$("pset").value = PSET;
$("pset").onchange = () => { PSET = $("pset").value; LS.set("pset", PSET); board.render(); };
function applySize(v) { document.documentElement.style.setProperty("--bw", v + "px"); LS.set("bsize", v); }
$("bsize").value = LS.get("bsize", 520); applySize($("bsize").value);
$("bsize").oninput = () => applySize($("bsize").value);

// ----------------------------------------------------------------- exports
function download(name, text, type) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
}
const fileBase = () => `${(R.headers.White || "white")}-vs-${(R.headers.Black || "black")}`.replace(/[^\w-]+/g, "_");
function annotatedPgn() {
  const nag = { Brilliant: " $3", Great: " $1", Inaccuracy: " $6", Miss: " $2", Mistake: " $2", Blunder: " $4" };
  let out = "";
  for (const [k, v] of Object.entries(R.headers)) out += `[${k} "${String(v).replace(/"/g, '\\"')}"]\n`;
  if (!R.headers.Annotator) out += '[Annotator "chess-review (Stockfish)"]\n';
  const varText = (m) => m.engine_line.slice(0, 4).map((san, i) => {
    const p = m.ply + i, n = Math.ceil(p / 2), white = p % 2 === 1;
    return i === 0 ? `${n}${white ? "." : "..."} ${san}` : white ? `${n}. ${san}` : san;
  }).join(" ");
  let t = "";
  for (const m of R.moves) {
    const white = m.color === "white";
    t += `${m.move_number}${white ? "." : "..."} ${m.san}${nag[m.classification] || ""} `;
    let c = `[%eval ${m.eval_after.toFixed(2)}] ${m.classification}`;
    if (BAD.includes(m.classification) || m.classification === "Inaccuracy") c += `. Best was ${m.engine_best}`;
    t += `{ ${c} } `;
    if (["Inaccuracy", "Miss", "Mistake", "Blunder"].includes(m.classification) && m.engine_line.length) t += `( ${varText(m)} ) `;
  }
  return out + "\n" + t.trim() + " " + (R.result || "*") + "\n";
}
$("expPgn").onclick = () => R && download(fileBase() + "-annotated.pgn", annotatedPgn(), "application/x-chess-pgn");

// Self-contained viewer: stringified into the exported HTML file, so it must not use outer variables.
function viewer(D) {
  const R = D.R, CL = D.CL, $ = (id) => document.getElementById(id), F = "abcdefgh";
  let cur = 0, flip = false;
  const fenAt = (i) => (i < R.moves.length ? R.moves[i].fen_before : R.final_fen);
  const BADS = ["Inaccuracy", "Miss", "Mistake", "Blunder"];
  const tag = (c) => `<span class="tag" style="background:${CL[c][0]}">${CL[c][1]} ${c}</span>`;
  function draw() {
    const pcs = {};
    fenAt(cur).split(" ")[0].split("/").forEach((row, r) => { let f = 0; for (const ch of row) { if (/\d/.test(ch)) f += +ch; else { pcs[F[f] + (8 - r)] = ch; f++; } } });
    const m = cur ? R.moves[cur - 1] : null, last = m ? [m.uci.slice(0, 2), m.uci.slice(2, 4)] : [];
    let h = "";
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const n = F[flip ? 7 - c : c] + ((flip ? r : 7 - r) + 1), p = pcs[n];
      h += `<div class="sq ${(r + c) % 2 ? "d" : "l"}${last.includes(n) ? " hl" : ""}">${p ? `<img src="${D.pcs[(p === p.toUpperCase() ? "w" : "b") + p.toUpperCase()]}">` : ""}${m && n === last[1] ? `<b class="bd" style="background:${CL[m.classification][0]}">${CL[m.classification][1]}</b>` : ""}</div>`;
    }
    $("board").innerHTML = h;
    $("info").innerHTML = m ? `<b>${m.move_number}${m.color === "white" ? "." : "..."} ${m.san}</b> ${tag(m.classification)}<br>Eval ${m.eval_after > 0 ? "+" : ""}${m.eval_after.toFixed(2)}${BADS.includes(m.classification) && m.engine_best ? `<br>Engine preferred <b>${m.engine_best}</b> <span class="mut">${m.engine_line.slice(1, 5).join(" ")}</span>` : ""}` : `<b>${R.headers.White || "White"} vs ${R.headers.Black || "Black"}</b><br><span class="mut">${R.result}</span>`;
    document.querySelectorAll("#moves .m").forEach((e) => e.classList.toggle("cur", +e.dataset.i === cur));
    const e = R.eval_series_white_pov, n = e.length - 1 || 1, y = (v) => 40 - Math.max(-5, Math.min(5, v)) * 8, x = (i) => i / n * 400;
    $("graph").innerHTML = `<polygon points="0,40 ${e.map((v, i) => x(i) + "," + y(v)).join(" ")} 400,40" fill="#bbb"/><line x1="${x(cur)}" x2="${x(cur)}" y1="0" y2="80" stroke="#f6c631" stroke-width="2"/>`;
  }
  const s = R.summary, ks = Object.keys(CL).filter((k) => s.white.counts[k] || s.black.counts[k]);
  $("sum").innerHTML = `<tr><th></th><th>White</th><th>Black</th></tr><tr><td>Accuracy</td><td><b>${s.white.accuracy}%</b></td><td><b>${s.black.accuracy}%</b></td></tr>` + ks.map((k) => `<tr><td><span class="dotc" style="background:${CL[k][0]}"></span>${k}</td><td>${s.white.counts[k]}</td><td>${s.black.counts[k]}</td></tr>`).join("");
  $("moves").innerHTML = R.moves.map((m, i) => (m.color === "white" ? `<span class="n">${m.move_number}.</span>` : "") + `<span class="m" data-i="${i + 1}"><span class="dotc" style="background:${CL[m.classification][0]}"></span>${m.san}</span>`).join("");
  $("moves").onclick = (e) => { const m = e.target.closest(".m"); if (m) { cur = +m.dataset.i; draw(); } };
  $("graph").onclick = (ev) => { const b = ev.currentTarget.getBoundingClientRect(); cur = Math.max(0, Math.min(R.moves.length, Math.round((ev.clientX - b.left) / b.width * R.moves.length))); draw(); };
  $("title").textContent = `${R.headers.White || "White"} vs ${R.headers.Black || "Black"}` + (R.opening ? ` · ${R.opening.name}` : "");
  $("fl").onclick = () => { flip = !flip; draw(); };
  const go = (i) => { cur = Math.max(0, Math.min(R.moves.length, i)); draw(); };
  $("b0").onclick = () => go(0); $("b1").onclick = () => go(cur - 1); $("b2").onclick = () => go(cur + 1); $("b3").onclick = () => go(1e9);
  addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") go(cur - 1); if (e.key === "ArrowRight") go(cur + 1); if (e.key === "ArrowUp") go(0); if (e.key === "ArrowDown") go(1e9); if (e.key === "f") $("fl").click(); });
  draw();
}
const EXPORT_CSS = `:root{--light:LIGHT;--dark:DARK}*{box-sizing:border-box}body{margin:0;background:#1f1e1b;color:#e8e6e1;font:15px system-ui,sans-serif}main{max-width:980px;margin:0 auto;padding:14px}
h1{font-size:18px}.cols{display:grid;grid-template-columns:minmax(280px,480px) 1fr;gap:16px}@media(max-width:760px){.cols{grid-template-columns:1fr}}
#board{display:grid;grid-template-columns:repeat(8,1fr);aspect-ratio:1;border-radius:4px;overflow:hidden}.sq{position:relative;aspect-ratio:1}.sq.l{background:var(--light)}.sq.d{background:var(--dark)}.sq.hl::before{content:"";position:absolute;inset:0;background:#f6f66980}
.sq img{position:relative;width:100%;height:100%;z-index:1}.bd{position:absolute;z-index:2;top:-2px;right:-2px;min-width:22px;height:22px;border-radius:11px;font:800 11px/22px system-ui;text-align:center;color:#fff}
.panel{background:#2b2a27;border-radius:8px;padding:10px 12px;margin-bottom:10px}.mut{color:#9a978f}.tag{padding:1px 8px;border-radius:10px;font-size:12px;font-weight:700;color:#111}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:3px 6px;text-align:right}th:first-child,td:first-child{text-align:left}.dotc{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
#moves{max-height:240px;overflow:auto;display:grid;grid-template-columns:36px 1fr 1fr;gap:2px}#moves .m{padding:3px 6px;border-radius:4px;cursor:pointer}#moves .m.cur{background:#4b4a46}#moves .n{color:#9a978f;padding:3px 0}
button{background:#444;color:#eee;border:0;border-radius:6px;padding:8px 14px;cursor:pointer;margin-right:6px}`;
$("expHtml").onclick = async () => {
  if (!R) return;
  const pcs = {};
  await Promise.all(["wK", "wQ", "wR", "wB", "wN", "wP", "bK", "bQ", "bR", "bB", "bN", "bP"].map(async (k) => {
    const t = await (await fetch(`pieces/${setDir()}/${k}.svg`)).text();
    pcs[k] = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(t)));
  }));
  const slim = JSON.parse(JSON.stringify(R));
  slim.moves.forEach((m) => { delete m.legal_before; }); delete slim.final_legal;
  const cs = getComputedStyle(document.documentElement);
  const data = JSON.stringify({ R: slim, pcs, CL }).replace(/</g, "\\u003c");
  const css = EXPORT_CSS.replace("LIGHT", cs.getPropertyValue("--light").trim()).replace("DARK", cs.getPropertyValue("--dark").trim());
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Game review</title><style>${css}</style></head><body><main><h1 id="title"></h1>
<div class="cols"><div><div id="board"></div><p><button id="b0">⏮</button><button id="b1">◀</button><button id="b2">▶</button><button id="b3">⏭</button><button id="fl">flip</button></p></div>
<div><div class="panel" id="info" style="min-height:70px"></div><div class="panel"><svg id="graph" viewBox="0 0 400 80" width="100%" style="cursor:pointer;background:#1f1e1b"></svg></div><div class="panel"><table id="sum"></table></div><div class="panel" id="moves"></div></div></div>
<p class="mut" style="font-size:12px">Reviewed locally with Stockfish (depth ${R.depth}) · arrow keys to step</p></main>
<script>(${viewer.toString()})(${data});<\/script></body></html>`;
  download(fileBase() + "-review.html", html, "text/html");
};

api("/api/status").then((s) => { $("tbstat").textContent = s.tb ? `Tablebases: ${s.tb}-piece` : "Tablebases: not installed"; }).catch(() => {});
$("profile").value = LS.get("profile", "balanced");
$("profile").onchange = applyProfile; applyProfile();
