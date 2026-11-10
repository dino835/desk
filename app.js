import { drawBalanceLine, drawCandles, drawRing } from "./chart.js";
import { applyAuthParams, parseAuthParams } from "./auth.js";

/* Trading Desk — PAPER. Read-only view of encrypted snapshots. Stop / Pause / Resume go
   through the desk's own Telegram bot (owner-only commands); this page never places orders. */

const LS_TOKEN = "desk.appToken";
const LS_PATH = "desk.dataPath";
const LS_STARS = "desk.stars";
const POLL_MS = 15000;
const INFO = "desk-plan-b-v1";
const AGENT_ORDER = ["scanner", "auditor", "analyst", "executor", "risk"];
const RANGES = ["LIVE", "1H", "4H", "1D", "1W", "ALL"];
const RANGE_MS = { "1H": 3600e3, "4H": 4 * 3600e3, "1D": 24 * 3600e3, "1W": 7 * 24 * 3600e3 };

const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
const banner = $("#banner");
const sheetRoot = $("#sheet-root");

const reduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function baseUrl() { return new URL("./", location.href); }

/* ---------- auth fragment (unchanged flow) ---------- */

function consumeAuthFragment() {
  const td = parseAuthParams(location.hash || "");
  if (!td) return;
  applyAuthParams(td);
  const raw = (location.hash || "").replace(/^#/, "");
  let r = "";
  const ampRoute = raw.search(/&\/|^\//);
  if (ampRoute >= 0) {
    const rest = raw.slice(ampRoute).replace(/^&/, "");
    r = rest.startsWith("/") ? "#" + rest : (rest ? "#" + rest : "");
  }
  history.replaceState(null, "", location.pathname + r);
}
function unlockFromPaste(raw) {
  const td = parseAuthParams(raw);
  if (!td) return false;
  applyAuthParams(td);
  history.replaceState(null, "", location.pathname + "#/home");
  Object.assign(route, parseRoute());
  return true;
}
function token() { return localStorage.getItem(LS_TOKEN) || ""; }
function dataPath() { return localStorage.getItem(LS_PATH) || ""; }

/* ---------- crypto / fetch ---------- */

function b64ToU8(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function deriveKey(appToken, salt, info) {
  const ikm = await crypto.subtle.importKey("raw", new TextEncoder().encode(appToken), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info }, ikm, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}
async function decryptEnvelope(env, appToken) {
  if (!env || env.v !== 1) throw new Error("unsupported envelope");
  const key = await deriveKey(appToken, b64ToU8(env.salt), new TextEncoder().encode(env.info || INFO));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToU8(env.iv) }, key, b64ToU8(env.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
function dataHref(rel) {
  return new URL("d/" + encodeURIComponent(dataPath()) + "/" + rel.replace(/^\//, ""), baseUrl()).href;
}
async function loadJson(rel) {
  const res = await fetch(dataHref(rel) + "?_=" + Math.floor(Date.now() / 10000), { cache: "no-store" });
  if (!res.ok) { const err = new Error("http " + res.status); err.status = res.status; throw err; }
  return decryptEnvelope(await res.json(), token());
}

/* ---------- public market data (no secrets; coin addresses only) ---------- */

const meta = {}; // mint -> {image, mc, created, price, pool, symbol, name, fetched}
async function fetchMeta(mints) {
  const want = [...new Set(mints.filter(Boolean))].filter((m) => !meta[m] || Date.now() - meta[m].fetched > 60e3);
  for (let i = 0; i < want.length; i += 30) {
    const chunk = want.slice(i, i + 30);
    try {
      const res = await fetch("https://api.dexscreener.com/tokens/v1/solana/" + chunk.join(","), { referrerPolicy: "no-referrer" });
      if (!res.ok) continue;
      const pairs = await res.json();
      const now = Date.now();
      chunk.forEach((m) => { if (!meta[m]) meta[m] = { fetched: now }; else meta[m].fetched = now; });
      for (const p of pairs || []) {
        const m = p.baseToken && p.baseToken.address;
        if (!m || !chunk.includes(m)) continue;
        const cur = meta[m];
        if (cur.pairAddress && cur.dexId === "pumpswap") continue; // keep the pumpswap pair, as the desk does
        const img = p.info && p.info.imageUrl;
        Object.assign(cur, {
          image: typeof img === "string" && img.startsWith("https://") ? img : cur.image,
          mc: Number(p.marketCap || p.fdv) || cur.mc,
          created: p.pairCreatedAt || cur.created,
          price: Number(p.priceUsd) || cur.price,
          pairAddress: p.pairAddress,
          dexId: p.dexId,
          symbol: p.baseToken.symbol,
          name: p.baseToken.name,
        });
      }
    } catch { /* offline: fall back to desk data */ }
  }
}

const ohlcv = {}; // pool -> {candles, fetched}
async function fetchOhlcv(pool, ageMin) {
  if (!pool) return null;
  const hit = ohlcv[pool];
  if (hit && Date.now() - hit.fetched < 60e3) return hit.candles;
  let tf = "minute", agg = 5;
  if (ageMin != null && ageMin > 36 * 60) { tf = "hour"; agg = 1; }
  else if (ageMin != null && ageMin > 6 * 60) { agg = 15; }
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${encodeURIComponent(pool)}/ohlcv/${tf}?aggregate=${agg}&limit=80`, { referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error("ohlcv " + res.status);
    const js = await res.json();
    const list = (((js || {}).data || {}).attributes || {}).ohlcv_list || [];
    const candles = list.map((r) => ({ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4] })).sort((a, b) => a.t - b.t);
    ohlcv[pool] = { candles, fetched: Date.now() };
    return candles;
  } catch {
    ohlcv[pool] = { candles: null, fetched: Date.now() };
    return null;
  }
}

/* ---------- store / routes ---------- */

const store = {
  state: null, chart: {}, activity: null, account: null, settings: null, decisions: {},
  coins: {}, updatedAt: null, error: null, retryIn: 0, loading: true, range: "LIVE",
  pending: null, // {action, at}
  demo: null,
};
const route = { screen: "home", mint: null, name: null };

function parseRoute() {
  const h = (location.hash || "").replace(/^#\/?/, "");
  const parts = h.split("/");
  const a = parts[0];
  if (a === "activity") return { screen: "activity" };
  if (a === "account") return { screen: "account" };
  if (a === "agents") return { screen: "agent", name: parts[1] || "scanner" };
  if ((a === "coin" || a === "audit") && parts[1]) return { screen: "coin", mint: parts[1] };
  return { screen: "home" };
}
function go(hash, opts = {}) {
  const url = hash.startsWith("#") ? hash : "#" + hash;
  if (opts.replace) history.replaceState(null, "", url); else history.pushState(null, "", url);
  Object.assign(route, { mint: null, name: null }, parseRoute());
  render();
  window.scrollTo(0, 0);
  view.scrollTop = 0;
}

/* ---------- formatters ---------- */

function money(n, digits = 2) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  return (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function signedMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  return (v < 0 ? "-" : "+") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function compactMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n), a = Math.abs(v), s = v < 0 ? "-" : "";
  if (a >= 1e9) return s + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M";
  if (a >= 1e3) return s + "$" + (a / 1e3).toFixed(1) + "K";
  return s + "$" + a.toFixed(a >= 100 ? 0 : 2);
}
function pct(n, digits = 2) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) + "%";
}
function tsMs(ts) {
  if (!ts) return NaN;
  const s = String(ts);
  return new Date(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z").getTime();
}
function fmtTime(ts) {
  const t = tsMs(ts);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function ageText(min) {
  if (min == null || Number.isNaN(Number(min))) return "";
  const m = Math.max(0, Math.round(Number(min)));
  if (m < 60) return m + "m old";
  if (m < 48 * 60) return Math.floor(m / 60) + "h " + (m % 60) + "m old";
  return Math.floor(m / 1440) + "d old";
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function tick(sym, name, mint) {
  const raw = (sym || name || (mint || "").slice(0, 5) || "?").replace(/^\$/, "");
  return raw.length > 10 ? raw.slice(0, 10) : raw;
}
function agentBy(name) { return ((store.state && store.state.agents) || []).find((a) => a.name === name) || {}; }
function botName() { return (store.account && store.account.telegram && store.account.telegram.bot) || ""; }
function mode() { return (store.state && store.state.mode) || "PAPER"; }

function coinAvatar(mint, symbol, size = 40, badge = "") {
  const m = meta[mint] || {};
  const letter = esc((tick(symbol, m.symbol, mint)[0] || "?").toUpperCase());
  const hue = [...(mint || "x")].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  const img = m.image ? `<img src="${esc(m.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
  return `<span class="cav" style="width:${size}px;height:${size}px;background:hsl(${hue} 45% 28%)"><span class="cav-l">${letter}</span>${img}${badge ? `<span class="cav-b ${badge}"></span>` : ""}</span>`;
}

/* ---------- data load ---------- */

async function refreshAll() {
  if (store.demo === "error") { store.error = "demo"; store.retryIn = 5; return; }
  if (!token() || !dataPath()) { store.loading = false; return; }
  try {
    const [state, activity, account, settings, chart] = await Promise.all([
      loadJson("state.json"), loadJson("activity.json"), loadJson("account.json"), loadJson("settings.json"),
      loadJson("chart/" + store.range + ".json").catch(() => loadJson("chart.json")),
    ]);
    Object.assign(store, { state, activity, account, settings, error: null, retryIn: 0, loading: false });
    store.chart[store.range] = chart;
    store.updatedAt = state.updatedAt || new Date().toISOString();
    if (store.pending) {
      const p = store.pending;
      const done = (p.action === "resume" && !state.entriesPaused) || (p.action !== "resume" && state.entriesPaused);
      if (done || Date.now() - p.at > 10 * 60e3) store.pending = null;
    }
    fetchMeta(knownMints()).then(() => { if (route.screen !== "coin") softRender(); });
  } catch (err) {
    store.error = err; store.retryIn = 15; store.loading = false;
  }
}
function knownMints() {
  const s = store.state || {};
  const out = [];
  ((store.activity && store.activity.rows) || []).forEach((r) => out.push(r.mint));
  (s.recent || []).forEach((r) => out.push(r.mint));
  (agentBy("scanner").feed || []).forEach((f) => out.push(f.mint));
  (s.openPositions || []).forEach((p) => out.push(p.mint));
  const ex = agentBy("executor").last; if (ex) out.push(ex.mint);
  return out.filter(Boolean).slice(0, 60);
}
async function ensureCoin(mint) {
  if (store.coins[mint] === undefined) {
    try { store.coins[mint] = await loadJson("coin/" + mint + ".json"); } catch { store.coins[mint] = null; }
  }
  return store.coins[mint];
}
async function ensureChart(range) {
  try { store.chart[range] = await loadJson("chart/" + range + ".json"); }
  catch { if (!store.chart[range]) store.chart[range] = { range, points: [], marks: [], startValue: store.state && store.state.balance }; }
  return store.chart[range];
}
async function ensureDecisions(name) {
  try { store.decisions[name] = await loadJson("agents/" + name + "/decisions.json"); } catch { store.decisions[name] = store.decisions[name] || null; }
  return store.decisions[name];
}

/* ---------- pieces ---------- */

function showBanner() {
  if (!store.error || store.demo === "empty") { banner.hidden = true; return; }
  banner.hidden = false;
  banner.textContent = `Desk offline · retrying in ${Math.max(0, store.retryIn)}s · last update ${store.updatedAt ? fmtTime(store.updatedAt) : "never"}`;
}

const ICON_BACK = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M15 5 8 12l7 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHEV = `<svg width="9" height="14" viewBox="0 0 9 14" fill="none"><path d="m1.5 1.5 5.5 5.5-5.5 5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function deskStatus() {
  const s = store.state || {};
  if (store.pending) return { cls: "pending", label: store.pending.action === "resume" ? "Resuming…" : store.pending.action === "stop" ? "Stopping…" : "Pausing…" };
  if (s.deskStopped) return { cls: "stopped", label: "Stopped" };
  if (s.entriesPaused) return { cls: "paused", label: "Paused" };
  return { cls: mode() === "LIVE" ? "live" : "paper", label: mode() === "LIVE" ? "Live" : "Paper" };
}

function sizingLine() {
  const s = store.state || {};
  const z = s.sizing || {};
  const open = (s.openPositions || []).length;
  const how = z.mode === "compounder" ? `Compounder ${Number(z.compounderPct || 60)}%` : `${Number(z.stackPct || 8)}% of stack · min ${money(z.minTicket, 0)}`;
  return `fomo · ${how} · ${open} open`;
}

function homeChartPayload() {
  const st = store.state || {};
  const ch = store.chart[store.range] || { points: [], marks: [], startValue: st.balance };
  let startMs;
  if (RANGE_MS[store.range]) startMs = Date.now() - RANGE_MS[store.range];
  else if (store.range === "LIVE") {
    const pts = ch.points || [];
    startMs = pts.length ? Math.min(tsMs(pts[0].ts), Date.now() - 3600e3) : Date.now() - 3600e3;
  }
  return { ch, startMs };
}

const GOALS = [2, 5, 10, 25, 50, 100, 250, 500, 1000];
function nextGoal(mult) { return GOALS.find((g) => g > mult + 1e-9) || GOALS[GOALS.length - 1]; }

function agentCard(name) {
  const a = agentBy(name);
  const st = store.state || {};
  const dot = a.status === "paused" ? "paused" : "on";
  if (name === "scanner") {
    const feed = (a.feed || []).slice(0, 3);
    return `<article class="acard" data-act="agent" data-name="scanner">
      <header><span class="aico teal">${svgRadar()}</span><div><div class="aname">Scanner</div><div class="asub"><i class="dot ${dot}"></i>${(a.scannedTotal ?? 0).toLocaleString("en-US")} coins scanned</div></div></header>
      <div class="alist">${feed.length ? feed.map((f) => `<button class="arow" type="button" data-act="coin" data-mint="${esc(f.mint)}">
          ${coinAvatar(f.mint, f.symbol, 28)}<span class="arow-t">${esc(tick(f.symbol, f.name, f.mint))}</span>
          <span class="arow-m">${f.liquidityUsd != null ? "liq " + compactMoney(f.liquidityUsd) : ""}</span>
          <span class="badge ${f.verdict === "pass" ? "g" : "x"}">${f.verdict === "pass" ? "pass" : "kill"}</span></button>`).join("")
        : `<div class="aempty">Listening for new pools</div>`}</div>
    </article>`;
  }
  if (name === "auditor") {
    const layers = a.layers || [];
    const pick = ["Dev wallet", "Top 10 holders", "Liquidity", "Mint authority"].map((n) => layers.find((l) => l.name === n)).filter(Boolean).slice(0, 3);
    return `<article class="acard" data-act="agent" data-name="auditor">
      <header><span class="aico orange">${svgShield()}</span><div><div class="aname">Auditor <span class="aalias">dev watch</span></div><div class="asub"><i class="dot ${dot}"></i>${a.takenApart ?? 0} taken apart today · ${a.rejected ?? 0} rejected</div></div></header>
      <div class="alist">${pick.length ? pick.map((l) => `<div class="arow"><span class="arow-t">${esc(l.name)}</span><span class="arow-m">${esc(l.value || "")}</span><span class="badge ${l.pass === true ? "g" : l.pass === false ? "r" : "x"}">${l.pass === true ? "ok" : l.pass === false ? "fail" : "—"}</span></div>`).join("")
        : `<div class="aempty">No coin reached the Auditor today. It checks dev wallet, top holders, LP lock and bundles before any buy.</div>`}</div>
      ${a.currentMint ? `<button class="aline" type="button" data-act="coin" data-mint="${esc(a.currentMint)}">${esc(a.headline || "")} ${CHEV}</button>` : ""}
    </article>`;
  }
  if (name === "analyst") {
    const last = a.last;
    const minScore = ((store.settings && store.settings.settings) || {}).min_score ?? 70;
    return `<article class="acard" data-act="agent" data-name="analyst">
      <header><span class="aico yellow">${svgSpark()}</span><div><div class="aname">Analyst</div><div class="asub"><i class="dot ${dot}"></i>${a.todayCount ?? 0} scored today</div></div></header>
      <div class="aring"><canvas class="ring" data-ring="analyst" width="96" height="96"></canvas>
        <div class="aring-t"><div class="muted">buys at score</div><div class="big">${esc(String(minScore))}+</div>
        <div class="muted">${last ? "last " + esc(tick(null, null, last.mint)) + " · " + esc(String(last.score)) : "no coin scored yet"}</div></div></div>
    </article>`;
  }
  if (name === "executor") {
    const mult = Number(st.multiplierAll || 1);
    const goal = nextGoal(mult);
    const z = st.sizing || {};
    const last = a.last;
    return `<article class="acard" data-act="agent" data-name="executor">
      <header><span class="aico purple">${svgBolt()}</span><div><div class="aname">Executor${z.mode === "compounder" ? ` <span class="aalias">compounder</span>` : ""}</div><div class="asub yellow"><i class="dot on"></i>${mult.toFixed(2)}x now</div></div></header>
      <div class="aring"><canvas class="ring" data-ring="executor" width="96" height="96"></canvas>
        <div class="aring-t"><div class="muted">next goal</div><div class="big">${money(goal * Number(st.startStack || 0))}</div>
        <div class="green">${z.nextBuy != null ? "buy " + money(z.nextBuy) : esc(z.nextBuyNote || "no free cash")}</div></div></div>
      ${last ? `<button class="abtn" type="button" data-act="coin" data-mint="${esc(last.mint)}">${coinAvatar(last.mint, null, 22)} ${esc(last.status === "skipped" ? "Skipped" : "Bought")} ${esc(tick(null, null, last.mint))}</button>`
        : `<div class="aempty">No paper buy yet</div>`}
    </article>`;
  }
  const open = st.openPositions || [];
  return `<article class="acard" data-act="agent" data-name="risk">
    <header><span class="aico red">${svgTri()}</span><div><div class="aname">Risk</div><div class="asub"><i class="dot ${dot}"></i>${open.length} open · guarding</div></div></header>
    <div class="pills"><span class="pill r">stop -${esc(String(a.stopPct ?? "—"))}%</span><span class="pill g">trail ${esc(String(a.trailPct ?? "—"))}%</span></div>
    <div class="alist">${open.length ? open.map((p) => `<button class="arow" type="button" data-act="coin" data-mint="${esc(p.mint)}">${coinAvatar(p.mint, p.symbol, 28)}<span class="arow-t">${esc(tick(p.symbol, p.name, p.mint))}</span><span class="arow-m">${money(p.sizeUsd)} in</span></button>`).join("")
      : `<div class="aempty">${a.lastExit ? "Last exit: " + esc(a.lastExit.reason || "") + " · " + signedMoney(a.lastExit.pnlUsd) : `Nothing open. Sells on the stop, the trail or the ${esc(String(((store.settings && store.settings.settings) || {}).timeout_h ?? 3))}h timeout.`}</div>`}</div>
  </article>`;
}

function svgRadar() { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M12 12 18 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`; }
function svgShield() { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="m9 12 2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function svgSpark() { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 16l5-5 4 4 7-8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function svgBolt() { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>`; }
function svgTri() { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 2 21h20L12 3Z"/></svg>`; }

function parseValue(v) {
  const parts = String(v || "").split(" · ");
  return { amount: parts[0] || "", sub: parts.slice(1).join(" · ") };
}

function tradeRow(r) {
  const kind = (r.kind || "").toLowerCase();
  const badge = kind === "bought" ? "buy" : kind === "stopped" ? "stop" : "sell";
  const { amount, sub } = parseValue(r.value);
  const title = (r.title || kind).replace(r.name || "\u0000", tick(r.symbol, r.name, r.mint));
  const amtCls = kind === "bought" ? "" : amount.startsWith("-") ? "red" : "green";
  return `<button class="row" type="button" data-act="coin" data-mint="${esc(r.mint || "")}">
    ${coinAvatar(r.mint, r.symbol, 42, badge)}
    <div class="mid"><div class="title">${esc(title)}</div><div class="sub">${esc([r.subtitle, fmtTime(r.ts)].filter(Boolean).join(" · "))}</div></div>
    <div class="right"><div class="amt ${amtCls}">${esc(amount)}</div><div class="sub">${esc(sub)}</div></div>
  </button>`;
}
function decisionRow(d) {
  const t = tick(d.symbol, d.name, d.mint);
  const title = d.agent === "scanner" ? (d.verdict === "pass" ? `Passed ${t} to Auditor` : `Skipped ${t}`)
    : d.agent === "auditor" ? (d.verdict === "rejected" ? `Rejected ${t}` : `Cleared ${t}`)
    : d.agent === "analyst" ? `Scored ${t}` : `Didn't buy ${t}`;
  const right = d.agent === "analyst" && d.score != null ? `score ${d.score}` : d.liquidityUsd != null ? compactMoney(d.liquidityUsd) : "";
  return `<button class="row" type="button" data-act="coin" data-mint="${esc(d.mint || "")}">
    ${coinAvatar(d.mint, d.symbol, 42, "info")}
    <div class="mid"><div class="title">${esc(title)}</div><div class="sub">${esc([d.agent, d.reason, fmtTime(d.ts)].filter(Boolean).join(" · "))}</div></div>
    <div class="right"><div class="amt muted">${esc(right)}</div><div class="sub">${d.agent === "scanner" ? "liq" : ""}</div></div>
  </button>`;
}
function activityHtml(limit) {
  const trades = (store.activity && store.activity.rows) || (store.state && store.state.activity) || [];
  if (trades.length) return trades.slice(0, limit).map(tradeRow).join("");
  const recent = ((store.state && store.state.recent) || []).slice(0, limit);
  return `<div class="note-row">No paper trades yet. Latest desk decisions:</div>${recent.map(decisionRow).join("") || `<div class="empty-note">Nothing yet</div>`}`;
}

/* ---------- screens ---------- */

function renderLock() {
  view.innerHTML = `<div class="lock">
    <div class="lock-av">G</div>
    <h1>Trading Desk</h1>
    <p class="muted">Open the link in Safari (Telegram: tap … → Open in Safari). After Add to Home Screen, paste the link once inside the Home Screen app. The token stays on this phone and is never sent to a server.</p>
    <form class="lock-form" data-act="unlock-form" method="dialog">
      <label class="lock-label" for="unlock-input">Private desk link</label>
      <textarea id="unlock-input" class="lock-input" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the full link, or the #t=…&amp;d=… part"></textarea>
      <button class="lock-btn" type="submit" data-act="unlock">Unlock</button>
      <p id="unlock-error" class="lock-error" hidden></p>
    </form>
  </div>`;
}
function renderLoading() {
  view.innerHTML = `<div class="topbar"><span></span><div class="tb-title">Trading Desk</div><span></span></div>
    <div class="pad"><div class="skel" style="height:22px;width:50%"></div><div class="skel" style="height:64px;width:75%;margin-top:18px"></div>
    <div class="skel" style="height:200px;margin-top:18px;border-radius:16px"></div><div class="skel" style="height:180px;margin-top:18px;border-radius:22px"></div></div>`;
}

/* odometer (kept: settles on iOS WebKit) */
let lastOdoText = null;
function odometerHtml(value) {
  const text = money(value);
  return `<div class="odometer" data-odo="${esc(text)}">${[...text].map((ch, i) => /[0-9]/.test(ch)
    ? `<span class="odo-reel" data-i="${i}" data-d="${ch}"><span class="odo-strip">${[..."0123456789"].map((n) => `<span class="odo-digit">${n}</span>`).join("")}</span></span>`
    : `<span class="odo-char">${esc(ch)}</span>`).join("")}</div>`;
}
function reelH(reel) { const h = reel.getBoundingClientRect().height; if (h > 0) return h; const fs = parseFloat(getComputedStyle(reel).fontSize); return fs > 0 ? fs : 64; }
function settle(strip, d, h) { strip.style.transform = `translate3d(0, ${-(Number(d) * h)}px, 0)`; }
function spinOdometer(root, prevText) {
  if (!root) return;
  const next = root.dataset.odo || "";
  const animate = prevText && prevText !== next && !reduced();
  root.querySelectorAll(".odo-reel").forEach((reel) => {
    const strip = reel.querySelector(".odo-strip");
    const d = Number(reel.dataset.d);
    let from = d;
    if (animate) { const i = Number(reel.dataset.i) + (prevText.length - next.length); const ch = prevText[i]; from = /[0-9]/.test(ch || "") ? Number(ch) : 0; }
    reel.classList.remove("anim"); strip.style.transition = "none"; settle(strip, from, reelH(reel)); void strip.offsetHeight;
    if (from !== d) { strip.style.transition = ""; reel.classList.add("anim"); settle(strip, d, reelH(reel)); setTimeout(() => { reel.classList.remove("anim"); strip.style.transition = "none"; settle(strip, d, reelH(reel)); }, 700); }
  });
  lastOdoText = next;
  const re = () => root.isConnected && root.querySelectorAll(".odo-reel").forEach((reel) => { if (!reel.classList.contains("anim")) settle(reel.querySelector(".odo-strip"), reel.dataset.d, reelH(reel)); });
  requestAnimationFrame(re);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(re).catch(() => {});
}

function renderHome() {
  const st = store.state || {};
  const ds = deskStatus();
  const pnl = Number(st.allTimePnl || 0);
  const up = pnl >= 0;
  const running = AGENT_ORDER.filter((n) => agentBy(n).status !== "paused").length;
  const prevOdo = lastOdoText ?? $(".odometer")?.dataset.odo ?? null;
  const scrollX = $(".carousel")?.scrollLeft || 0;
  view.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" type="button" data-act="tg" aria-label="Back to Telegram">${ICON_BACK}</button>
      <div class="tb-title">Trading Desk</div>
      <button class="share-btn" type="button" data-act="share">Share</button>
    </div>
    <div class="pad">
      <div class="bot-row">
        <button class="bot" type="button" data-act="account"><span class="bot-av">G</span><span class="bot-name">Grok Bot</span>${CHEV}</button>
        <button class="mode-pill ${ds.cls}" type="button" data-act="stop-sheet"><i></i>${esc(ds.label)}</button>
      </div>
      <div class="subline">${esc(sizingLine())}</div>
      <div class="balance">${odometerHtml(st.balance)}</div>
      <div class="gain-row">
        <span class="gain ${up ? "green" : "red"}">${up ? "▲" : "▼"} ${money(Math.abs(pnl))} (${pct(Math.abs(Number(st.allTimePct || 0)))})</span>
        <span class="mult-pill ${up ? "" : "down"}">${Number(st.multiplierAll || 1).toFixed(2)}x</span>
      </div>
    </div>
    <div class="chart-wrap"><canvas id="home-chart"></canvas></div>
    <div class="chips">${RANGES.map((r) => `<button type="button" data-act="range" data-range="${r}" class="${r === store.range ? "on" : ""}">${r === "LIVE" ? "<i></i>LIVE" : r}</button>`).join("")}</div>
    <div class="h-row"><h2>Agents</h2><span class="green">${running} running</span></div>
    <div class="carousel" id="carousel">${AGENT_ORDER.map(agentCard).join("")}</div>
    <div class="dots" id="dots">${AGENT_ORDER.map((_, i) => `<i class="${i === 0 ? "on" : ""}"></i>`).join("")}</div>
    <div class="h-row"><h2>Activity</h2><button class="link" type="button" data-act="activity">See all</button></div>
    <div class="list">${activityHtml(6)}</div>
    <p class="foot">PAPER · simulated fills on real prices · no orders are placed</p>`;
  const car = $("#carousel");
  if (car) {
    car.scrollLeft = scrollX;
    const upd = () => {
      const cards = [...car.children];
      const idx = cards.reduce((best, c, i) => Math.abs(c.offsetLeft - car.scrollLeft - 16) < Math.abs(cards[best].offsetLeft - car.scrollLeft - 16) ? i : best, 0);
      $("#dots")?.querySelectorAll("i").forEach((d, i) => d.classList.toggle("on", i === idx));
    };
    car.addEventListener("scroll", () => requestAnimationFrame(upd), { passive: true });
    upd();
  }
  requestAnimationFrame(() => {
    spinOdometer($(".odometer"), prevOdo);
    drawHomeChart();
    const mult = Number(st.multiplierAll || 1);
    const goal = nextGoal(mult);
    const prev = GOALS[GOALS.indexOf(goal) - 1] || 1;
    const ringE = $('[data-ring="executor"]');
    if (ringE) drawRing(ringE, (mult - prev < 0 ? 0 : (mult - 1) / (goal - 1)), goal + "x", "#facc15");
    const ringA = $('[data-ring="analyst"]');
    const last = agentBy("analyst").last;
    if (ringA) drawRing(ringA, last ? Number(last.score) / 100 : 0, last ? String(last.score) : "—", last && last.pass ? "#22c55e" : "#facc15", "score");
  });
}
function drawHomeChart() {
  const c = $("#home-chart");
  if (!c) return;
  const { ch, startMs } = homeChartPayload();
  const up = Number((store.state || {}).allTimePnl || 0) >= 0;
  drawBalanceLine(c, ch, { startMs, color: up ? "#22c55e" : "#ef4444" });
}

function renderActivity() {
  view.innerHTML = `<div class="topbar"><button class="icon-btn" type="button" data-act="back">${ICON_BACK}</button><div class="tb-title">Activity</div><span class="tb-sp"></span></div>
    <div class="list">${activityHtml(60)}</div>`;
}

function renderAgent(name) {
  const d = store.decisions[name];
  if (d === undefined) { renderLoading(); ensureDecisions(name).then(render); return; }
  const rows = (d && d.decisions) || [];
  const title = name[0].toUpperCase() + name.slice(1);
  view.innerHTML = `<div class="topbar"><button class="icon-btn" type="button" data-act="back">${ICON_BACK}</button><div class="tb-title">${esc(title)}</div><span class="tb-sp"></span></div>
    <div class="carousel single">${agentCard(name)}</div>
    <div class="h-row"><h2>Decisions</h2><span class="muted">${d ? d.todayCount ?? 0 : 0} today</span></div>
    <div class="list">${rows.length ? rows.slice(0, 40).map((r) => `<button class="row" type="button" data-act="coin" data-mint="${esc(r.mint || "")}">
      ${coinAvatar(r.mint, null, 36)}<div class="mid"><div class="title">${esc(r.name || r.mint || "")}</div><div class="sub">${esc([fmtTime(r.ts), r.verdict, r.reason].filter(Boolean).join(" · "))}</div></div>
      <div class="right">${r.score != null ? `<span class="badge g">${esc(String(r.score))}</span>` : ""}</div></button>`).join("") : `<div class="empty-note">No decisions yet</div>`}</div>
    <p class="foot">Pause or resume ${esc(title)} in Telegram: /pause ${esc(name)} · /resume ${esc(name)}</p>`;
  requestAnimationFrame(() => {
    const ringE = $('[data-ring="executor"]');
    const st = store.state || {};
    const mult = Number(st.multiplierAll || 1), goal = nextGoal(mult);
    if (ringE) drawRing(ringE, (mult - 1) / (goal - 1), goal + "x", "#facc15");
    const ringA = $('[data-ring="analyst"]');
    const last = agentBy("analyst").last;
    if (ringA) drawRing(ringA, last ? Number(last.score) / 100 : 0, last ? String(last.score) : "—", "#facc15", "score");
  });
}

function renderAccount() {
  const acc = store.account || {};
  const grouped = (store.settings && store.settings.grouped) || {};
  const groups = ["desk", "scanner", "auditor", "analyst", "executor", "risk"];
  view.innerHTML = `<div class="topbar"><button class="icon-btn" type="button" data-act="back">${ICON_BACK}</button><div class="tb-title">Grok Bot</div><span class="tb-sp"></span></div>
    <div class="group-title">Desk</div>
    <div class="group">
      <div class="cell"><div class="lbl">Mode</div><div class="val">${esc(acc.mode || "PAPER")}</div></div>
      <div class="cell"><div class="lbl">Paper stack</div><div class="val">${money(acc.stack)}</div></div>
      <div class="cell"><div class="lbl">Telegram bot</div><div class="val">${botName() ? "@" + esc(botName()) : (acc.telegram && acc.telegram.connected ? "Connected" : "—")}</div></div>
    </div>
    ${acc.ticket ? `<p class="note">${esc(acc.ticket)}</p>` : ""}
    <div class="group-title">FOMO</div>
    <div class="group">
      <a class="cell" href="${esc(acc.profile_url || "#")}" target="_blank" rel="noopener" data-act="ext"><div class="lbl">Your FOMO profile</div><div class="val">Open ${CHEV}</div></a>
      <button class="cell" type="button" data-act="share"><div class="lbl">Invite a friend</div><div class="val">Share ${CHEV}</div></button>
    </div>
    ${groups.map((g) => {
      const items = grouped[g] || {};
      const keys = Object.keys(items).filter((k) => k !== "rpc_url");
      if (!keys.length) return "";
      return `<div class="group-title">${esc(g[0].toUpperCase() + g.slice(1))}</div><div class="group">${keys.map((k) =>
        `<div class="cell"><div class="lbl">${esc(k.replace(/_/g, " "))}</div><div class="val">${esc(String(items[k].value ?? ""))}</div></div>`).join("")}</div>`;
    }).join("")}
    <p class="note">Settings are read-only here. Change any of them in Telegram, e.g. “set stop to -8%” or “sizing_mode compounder”.</p>`;
}

/* ---------- coin detail ---------- */

const LAYER_STATUS = (l) => (l.pass === true ? ["passed", "g"] : l.pass === false ? ["failed", "r"] : ["not checked", "x"]);

function renderCoin(coin, mint) {
  if (!coin) {
    view.innerHTML = `<div class="coin-top"><button class="home-link" type="button" data-act="home">‹ Home</button></div><div class="empty-note">The desk has no data for this coin yet.</div>`;
    return;
  }
  const m = meta[mint] || {};
  const sym = tick(coin.symbol, m.symbol, mint);
  const created = m.created || tsMs(coin.createdAt);
  const ageMin = created ? (Date.now() - created) / 60000 : coin.ageMin;
  const trades = coin.trades || [];
  const buy = [...trades].reverse().find((t) => t.kind === "buy");
  const sell = buy ? trades.find((t) => t.kind === "sell" && tsMs(t.ts) >= tsMs(buy.ts)) : null;
  const nowPrice = m.price || coin.price;
  let change = null, since = "";
  if (buy && buy.price) { change = ((sell ? sell.price : nowPrice) / buy.price - 1) * 100; since = sell ? "on Grok Bot's paper trade" : "since Grok Bot bought"; }
  else if (coin.firstSeenPrice && nowPrice) { change = (nowPrice / coin.firstSeenPrice - 1) * 100; since = "since Grok Bot first saw it"; }
  const starred = (JSON.parse(localStorage.getItem(LS_STARS) || "[]")).includes(mint);
  const audit = coin.audit && coin.audit.layers ? coin.audit.layers : [];
  const passed = audit.filter((l) => l.pass === true).length;
  const scan = coin.scan;
  const verdict = coin.verdict;
  const devLayer = audit.find((l) => /^dev/i.test(l.name || ""));
  const status = buy ? (sell ? "closed" : "open") : scan && scan.verdict !== "pass" ? "passed on it" : audit.length && passed < audit.length ? "rejected" : "watching";

  view.innerHTML = `
    <div class="coin-top">
      <button class="home-link" type="button" data-act="home">‹ Home</button>
      <button class="star ${starred ? "on" : ""}" type="button" data-act="star" data-mint="${esc(mint)}" aria-label="Star">${starred ? "★" : "☆"}</button>
    </div>
    <div class="pad coin-head">
      ${coinAvatar(mint, sym, 52)}
      <div><div class="coin-name">${esc(coin.name || m.name || sym)}</div>
      <div class="muted">${esc(sym.toUpperCase())} · Solana${ageMin != null ? " · " + esc(ageText(ageMin)) : ""}</div></div>
      ${coin.coin_url ? `<a class="fomo-pill" href="${esc(coin.coin_url)}" target="_blank" rel="noopener" data-act="ext">FOMO</a>` : ""}
    </div>
    <div class="pad">
      <div class="mc">${m.mc ? compactMoney(m.mc) : coin.price != null ? "$" + Number(coin.price).toPrecision(3) : "—"}</div>
      <div class="muted small">${m.mc ? "market cap" : "price (market cap loading)"}</div>
      ${change != null ? `<div class="chg ${change >= 0 ? "green" : "red"}">${change >= 0 ? "▲" : "▼"} ${pct(Math.abs(change), 1)} ${esc(since)}</div>` : ""}
      <div class="legend"><span>Grok Bot on fomo</span><span>·</span><span class="lb b">B</span><span class="lb s">S</span><span>its trades</span><span>·</span><span class="lr"></span><span>desk calls</span></div>
    </div>
    <div class="candle-wrap"><canvas id="coin-chart"></canvas><div class="chart-src muted" id="chart-src"></div></div>
    ${audit.length ? `<div class="strip-wrap">
      <div class="strip-h"><span class="muted">auditor · ${audit.length} checks</span><span class="tag ${passed === audit.length ? "g" : "o"}">${passed}/${audit.length}</span></div>
      <div class="strip">${audit.map((l) => `<i class="${LAYER_STATUS(l)[1]}" title="${esc(l.name)}"></i>`).join("")}</div>
    </div>` : ""}
    <div class="h-row"><h2>Desk checks · $${esc(sym.toUpperCase())}</h2><span class="${status === "open" || status === "closed" ? "green" : "muted"} small">${esc(status)}</span></div>
    <div class="list checks">
      ${scan ? checkRow("scanner", `Scanner · ${scan.reason || scan.verdict}`, [scan.liquidityUsd != null ? "liq " + compactMoney(scan.liquidityUsd) : "", scan.top10Pct != null ? "top 10 " + pct(scan.top10Pct, 1) : "", scan.h1ChangePct != null ? "1h " + pct(scan.h1ChangePct, 0) : ""].filter(Boolean).join(" · "), `mint ${mint.slice(0, 4)}…${mint.slice(-4)} · ${fmtTime(scan.ts)}`, scan.verdict === "pass" ? ["passed", "g"] : ["killed", "r"]) : ""}
      ${audit.map((l) => checkRow("auditor", `${l.name}`, l.value || "", `layer ${l.layer}${l.source ? " · " + l.source : ""}${coin.audit.ts ? " · " + fmtTime(coin.audit.ts) : ""}`, LAYER_STATUS(l))).join("")}
      ${verdict ? checkRow("analyst", `Analyst · score ${verdict.score}`, verdict.reason || "", fmtTime(verdict.ts), verdict.pass ? ["bought", "b"] : ["passed", "x"]) : ""}
      ${trades.map((t) => checkRow(t.kind === "buy" ? "buy" : "sell", t.kind === "buy" ? `Paper buy · ${money(t.sizeUsd)}` : `Paper sell · ${t.reason || ""}`, t.kind === "sell" ? `${signedMoney(t.pnlUsd)} · x${Number(t.mult || 0).toFixed(2)}` : `at $${Number(t.price).toPrecision(3)}`, fmtTime(t.ts), t.kind === "buy" ? ["bought", "b"] : ["sold", "g"])).join("")}
      ${!scan && !audit.length && !trades.length ? `<div class="empty-note">No desk checks recorded for this coin.</div>` : ""}
    </div>
    <div class="pos-spacer"></div>
    ${positionBar(coin, buy, sell, nowPrice, devLayer, scan, change)}`;

  requestAnimationFrame(() => drawCoinChart(coin, mint, buy, trades, scan, verdict));
}

function checkRow(kind, title, detail, tiny, [tag, cls]) {
  const ico = { scanner: svgRadar(), auditor: svgShield(), analyst: svgSpark(), buy: "B", sell: "S" }[kind] || "";
  return `<div class="row check">
    <span class="cico ${kind}">${ico}</span>
    <div class="mid"><div class="title">${esc(title)}</div>${detail ? `<div class="sub">${esc(detail)}</div>` : ""}${tiny ? `<div class="tiny">${esc(tiny)}</div>` : ""}</div>
    <span class="tag ${cls}">${esc(tag)}</span></div>`;
}

function positionBar(coin, buy, sell, nowPrice, devLayer, scan, change) {
  if (buy) {
    const size = Number(buy.sizeUsd || 0);
    const val = sell ? size + Number(sell.pnlUsd || 0) : buy.price ? size * (nowPrice / buy.price) : size;
    const p = val - size;
    return `<div class="posbar"><span class="pico">${svgBolt()}</span>
      <div class="mid"><div class="title">Position</div><div class="sub">${money(size)} in${devLayer ? " · dev " + esc(devLayer.value) : ""} · ${sell ? "closed" : "open"}</div></div>
      <div class="right"><div class="amt">${money(val)}</div><div class="${p >= 0 ? "green" : "red"} small">${signedMoney(p)}</div></div></div>`;
  }
  const why = scan && scan.verdict !== "pass" ? "Scanner: " + (scan.reason || "killed") : "not bought";
  return `<div class="posbar"><span class="pico grey">${svgBolt()}</span>
    <div class="mid"><div class="title">No position</div><div class="sub">${esc(why)}</div></div>
    <div class="right">${change != null ? `<div class="amt ${change >= 0 ? "green" : "red"}">${change >= 0 ? "+" : "-"}${pct(Math.abs(change), 1)}</div><div class="muted small">since seen</div>` : `<div class="amt">$0.00</div>`}</div></div>`;
}

async function drawCoinChart(coin, mint, buy, trades, scan, verdict) {
  const c = $("#coin-chart");
  if (!c) return;
  const events = [];
  for (const t of trades || []) {
    if (t.kind === "buy") events.push({ t: tsMs(t.ts), kind: "buy", price: Number(t.price), label: `Entry${verdict && verdict.score != null ? " · score " + verdict.score : ""}` });
    else events.push({ t: tsMs(t.ts), kind: "sell", price: Number(t.price), label: `Sold · x${Number(t.mult || 0).toFixed(2)}` });
  }
  if (scan && scan.verdict !== "pass") events.push({ t: tsMs(scan.ts), kind: "alert", label: `Scanner · ${scan.reason || "killed"}` });
  const desk = (coin.candles || []).map((k) => ({ t: tsMs(k.ts), o: k.open, h: k.high, l: k.low, c: k.close }));
  const draw = (cs, src) => {
    if (!$("#coin-chart")) return;
    drawCandles($("#coin-chart"), cs, events);
    const s = $("#chart-src"); if (s) s.textContent = src;
  };
  draw(desk, desk.length ? "desk price samples" : "");
  const m = meta[mint] || {};
  const created = m.created || tsMs(coin.createdAt);
  const pool = coin.pool || m.pairAddress;
  const cs = await fetchOhlcv(pool, created ? (Date.now() - created) / 60000 : coin.ageMin);
  if (cs && cs.length && route.mint === mint) draw(cs, "candles: GeckoTerminal");
}

/* ---------- Stop sheet ---------- */

function openStopSheet() {
  const st = store.state || {};
  const open = (st.openPositions || []).map((p) => tick(p.symbol, p.name, p.mint).toUpperCase());
  const paused = st.entriesPaused;
  const names = open.length === 0 ? "" : open.length === 1 ? open[0] : open.slice(0, -1).join(", ") + " and " + open[open.length - 1];
  const msg = open.length
    ? `${names} ${open.length === 1 ? "is" : "are"} still open — ${open.length === 1 ? "it'll" : "they'll"} be paper-sold at market on fomo prices, and the ${(st.sizing || {}).mode === "compounder" ? "Compounder stops rolling" : "desk takes no new entries"}.`
    : `Nothing is open right now. The desk will stop taking new paper entries${(st.sizing || {}).mode === "compounder" ? " and the Compounder stops rolling" : ""}.`;
  const title = paused ? (st.deskStopped ? "The desk is stopped" : "New entries are paused") : "Stop the desk?";
  const body = paused ? (open.length ? `${names} ${open.length === 1 ? "is" : "are"} still open and guarded by Risk.` : "Nothing is open.") + " Resume to take new paper entries again." : msg;
  sheetRoot.innerHTML = `<div class="sheet-back" data-act="sheet-close"></div>
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet-group">
        <div class="sheet-head"><div class="sheet-title">${esc(title)}</div><div class="sheet-msg">${esc(body)}</div></div>
        ${paused ? `<button class="sheet-btn blue" type="button" data-act="desk" data-cmd="resume">Resume the desk</button>` : ""}
        ${!st.deskStopped ? `<button class="sheet-btn red" type="button" data-act="desk" data-cmd="stop">Stop &amp; sell all</button>` : ""}
        ${!paused ? `<button class="sheet-btn blue" type="button" data-act="desk" data-cmd="pause">Pause new entries only</button>` : ""}
      </div>
      <button class="sheet-btn cancel" type="button" data-act="sheet-close">Cancel</button>
      <div class="sheet-foot">PAPER · confirms in your desk's Telegram chat${botName() ? " (@" + esc(botName()) + ")" : ""}</div>
    </div>`;
  requestAnimationFrame(() => sheetRoot.classList.add("open"));
}
function closeSheet() {
  sheetRoot.classList.remove("open");
  setTimeout(() => { if (!sheetRoot.classList.contains("open")) sheetRoot.innerHTML = ""; }, 250);
}
function sendDeskCommand(cmd) {
  closeSheet();
  const bot = botName();
  if (!bot) { toast(`Send /${cmd} to your desk bot in Telegram`); return; }
  store.pending = { action: cmd, at: Date.now() };
  softRender();
  // Deep link: Telegram opens the desk bot; tapping Start sends "/start <cmd>" (owner-only on the desk).
  location.href = `https://t.me/${encodeURIComponent(bot)}?start=${encodeURIComponent(cmd)}`;
}

/* ---------- misc ---------- */

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}
async function share() {
  const url = store.account && store.account.signup_url;
  const st = store.state || {};
  const text = `My Grok Bot paper desk: ${money(st.balance)} (${Number(st.multiplierAll || 1).toFixed(2)}x). Trade meme coins on FOMO:`;
  if (navigator.share && url) { try { await navigator.share({ title: "FOMO", text, url }); return; } catch { return; } }
  try { await navigator.clipboard.writeText(text + " " + (url || "")); toast("Copied"); } catch { toast("Couldn't copy"); }
}

/* ---------- render / events ---------- */

function softRender() {
  if (route.screen === "home" || route.screen === "activity") render();
}
function render() {
  showBanner();
  if (!token() || !dataPath()) { route.screen = "lock"; view.classList.add("locked"); renderLock(); return; }
  view.classList.remove("locked");
  if (store.loading && !store.state) { renderLoading(); return; }
  const sc = route.screen;
  if (sc === "home") renderHome();
  else if (sc === "activity") renderActivity();
  else if (sc === "account") renderAccount();
  else if (sc === "agent") renderAgent(route.name);
  else if (sc === "coin") {
    const mint = route.mint;
    const c = store.coins[mint];
    if (c === undefined) {
      renderLoading();
      Promise.all([ensureCoin(mint), fetchMeta([mint])]).then(() => { if (route.mint === mint) render(); });
      return;
    }
    renderCoin(c, mint);
  } else renderHome();
}

function submitUnlock(e) {
  if (e) e.preventDefault();
  const input = $("#unlock-input");
  const err = $("#unlock-error");
  if (!unlockFromPaste(input ? input.value : "")) {
    if (err) { err.hidden = false; err.textContent = "That doesn't look like your private desk link. Paste the whole link, including the #t= part."; }
    return;
  }
  render();
  loop();
}
view.addEventListener("submit", (e) => { if (e.target.closest("[data-act=unlock-form]")) { e.preventDefault(); submitUnlock(e); } });

async function onClick(e) {
  const ext = e.target.closest("[data-act=ext]");
  if (ext && ext.href) return;
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  if (act === "unlock") return submitUnlock(e);
  if (act === "back") { history.length > 1 ? history.back() : go("#/home", { replace: true }); return; }
  if (act === "home") { go("#/home"); return; }
  if (act === "activity") { go("#/activity"); return; }
  if (act === "account") { go("#/account"); return; }
  if (act === "share") { share(); return; }
  if (act === "tg") { const b = botName(); if (b) location.href = "https://t.me/" + encodeURIComponent(b); return; }
  if (act === "range") { store.range = el.dataset.range; render(); await ensureChart(store.range); if (route.screen === "home") drawHomeChart(); return; }
  if (act === "coin") { e.stopPropagation(); if (el.dataset.mint) { store.coins[el.dataset.mint] = undefined; go("#/coin/" + el.dataset.mint); } return; }
  if (act === "agent") { if (route.screen !== "agent") { store.decisions[el.dataset.name] = undefined; go("#/agents/" + el.dataset.name); } return; }
  if (act === "star") {
    const list = JSON.parse(localStorage.getItem(LS_STARS) || "[]");
    const m = el.dataset.mint;
    const next = list.includes(m) ? list.filter((x) => x !== m) : [...list, m];
    localStorage.setItem(LS_STARS, JSON.stringify(next));
    el.classList.toggle("on"); el.textContent = next.includes(m) ? "★" : "☆";
    return;
  }
  if (act === "stop-sheet") { openStopSheet(); return; }
  if (act === "sheet-close") { closeSheet(); return; }
  if (act === "desk") { sendDeskCommand(el.dataset.cmd); return; }
}
document.addEventListener("click", onClick);
window.addEventListener("popstate", () => { Object.assign(route, { mint: null, name: null }, parseRoute()); render(); });
window.addEventListener("resize", () => { if (route.screen === "home") drawHomeChart(); });

/* ---------- boot / poll ---------- */

let pollTimer = null, retryTimer = null;
async function loop() {
  await refreshAll();
  if (route.screen !== "coin" && route.screen !== "agent") render(); else showBanner();
  if (store.error && store.retryIn > 0) {
    clearInterval(retryTimer);
    retryTimer = setInterval(() => {
      store.retryIn = Math.max(0, store.retryIn - 1);
      showBanner();
      if (store.retryIn === 0) { clearInterval(retryTimer); loop(); }
    }, 1000);
  }
}
function startPoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (document.visibilityState !== "hidden") loop(); }, POLL_MS);
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") loop(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register(new URL("sw.js", baseUrl()), { scope: "./" }).catch(() => {});

consumeAuthFragment();
Object.assign(route, parseRoute());
if (!location.hash && token() && dataPath()) history.replaceState(null, "", "#/home");

window.__deskTest = {
  setDemo(m) { store.demo = m || null; if (m === "error") { store.error = "demo"; store.retryIn = 8; } else store.error = null; render(); },
  pausePoll() { clearInterval(pollTimer); clearInterval(retryTimer); pollTimer = retryTimer = null; },
  openStopSheet, go, store, meta, parseAuthParams, applyAuthParams, unlockFromPaste,
};

render();
loop().then(startPoll);
