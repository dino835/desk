import { drawLineChart, drawCandles, drawScoreRing } from "./chart.js";

const LS_TOKEN = "desk.appToken";
const LS_PATH = "desk.dataPath";
const LS_SEEN = "desk.activitySeen";
const POLL_MS = 15000;
const INFO = "desk-plan-b-v1";
const AGENT_ORDER = ["scanner", "auditor", "analyst", "executor", "risk"];
const RANGES = ["LIVE", "1H", "4H", "1D", "1W", "ALL"];

const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
const banner = $("#banner");
const tabbar = $("#tabbar");

const reduced = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function baseUrl() {
  return new URL("./", location.href);
}

/* ---------- auth fragment ---------- */

function consumeAuthFragment() {
  const raw = (location.hash || "").replace(/^#/, "");
  if (!raw) return;
  const cut = raw.startsWith("/") ? "" : raw;
  if (!cut || (!cut.includes("t=") && !cut.includes("d="))) return;
  const ampRoute = cut.search(/&\/|^\//);
  const paramStr = ampRoute >= 0 ? cut.slice(0, ampRoute).replace(/&$/, "") : cut;
  const params = new URLSearchParams(paramStr);
  const t = params.get("t");
  const d = params.get("d");
  if (t) localStorage.setItem(LS_TOKEN, t);
  if (d) localStorage.setItem(LS_PATH, d);
  let route = "";
  if (ampRoute >= 0) {
    const rest = cut.slice(ampRoute).replace(/^&/, "");
    route = rest.startsWith("/") ? "#" + rest : rest;
  }
  const next = location.pathname + location.search + route;
  history.replaceState(null, "", next || location.pathname);
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
  const ikm = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appToken),
    "HKDF",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

async function decryptEnvelope(env, appToken) {
  if (!env || env.v !== 1) throw new Error("unsupported envelope");
  const salt = b64ToU8(env.salt);
  const iv = b64ToU8(env.iv);
  const ct = b64ToU8(env.ct);
  const info = new TextEncoder().encode(env.info || INFO);
  const key = await deriveKey(appToken, salt, info);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

function dataHref(rel) {
  return new URL("d/" + encodeURIComponent(dataPath()) + "/" + rel.replace(/^\//, ""), baseUrl()).href;
}

async function loadJson(rel) {
  const res = await fetch(dataHref(rel), { cache: "no-store" });
  if (!res.ok) {
    const err = new Error("http " + res.status);
    err.status = res.status;
    throw err;
  }
  const env = await res.json();
  return decryptEnvelope(env, token());
}

/* ---------- store ---------- */

const store = {
  state: null,
  chart: {},
  activity: null,
  account: null,
  settings: null,
  decisions: {},
  coins: {},
  audits: {},
  updatedAt: null,
  error: null,
  retryIn: 0,
  loading: true,
  range: "LIVE",
  demo: null, // 'empty' | 'error' for screenshots
};

const route = {
  tab: "home",
  screen: "home", // home|agents|activity|account|coin|audit|lock
  mint: null,
};

function parseRoute() {
  const h = (location.hash || "").replace(/^#/, "");
  if (!h || h === "/" || h === "home") return { tab: "home", screen: "home", mint: null };
  const parts = h.replace(/^\//, "").split("/");
  const a = parts[0];
  if (a === "agents") return { tab: "agents", screen: "agents", mint: null };
  if (a === "activity") return { tab: "activity", screen: "activity", mint: null };
  if (a === "account") return { tab: "account", screen: "account", mint: null };
  if (a === "coin" && parts[1]) return { tab: route.tab === "account" ? "home" : route.tab, screen: "coin", mint: parts[1] };
  if (a === "audit" && parts[1]) return { tab: route.tab === "account" ? "home" : route.tab, screen: "audit", mint: parts[1] };
  return { tab: "home", screen: "home", mint: null };
}

function go(hash, opts = {}) {
  const url = (hash.startsWith("#") ? hash : "#" + hash);
  if (opts.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  Object.assign(route, parseRoute());
  render();
}

/* ---------- formatters ---------- */

function money(n, digits = 2) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs >= 1000 && digits === 2) {
    return (v < 0 ? "-" : "") + "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return (v < 0 ? "-" : "") + "$" + abs.toFixed(digits);
}
function compactMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n), a = Math.abs(v), s = v < 0 ? "-" : "";
  if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M";
  if (a >= 1e3) return s + "$" + (a / 1e3).toFixed(a >= 1e4 ? 1 : 1) + "K";
  return s + "$" + a.toFixed(2);
}
function pct(n, signed = true) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  const sign = signed && v >= 0 ? "+" : "";
  return sign + v.toFixed(2) + "%";
}
function agoAge(min) {
  if (min == null) return "";
  const m = Number(min);
  if (m < 60) return m + "m old";
  if (m < 60 * 24) return Math.round(m / 60) + "h old";
  return Math.round(m / (60 * 24)) + "d old";
}
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts.endsWith("Z") || ts.includes("+") ? ts : ts + "Z");
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function agentBy(name) {
  return ((store.state && store.state.agents) || []).find((a) => a.name === name) || {};
}

function prettyKey(k) {
  return k.replace(/_/g, " ").replace(/\busd\b/i, "USD").replace(/\bpct\b/i, "%");
}

/* ---------- data load ---------- */

async function refreshAll() {
  if (store.demo === "error") {
    store.error = "demo";
    store.retryIn = 5;
    return;
  }
  const t = token(), p = dataPath();
  if (!t || !p) {
    store.loading = false;
    return;
  }
  try {
    const [state, activity, account, settings, chart] = await Promise.all([
      loadJson("state.json"),
      loadJson("activity.json"),
      loadJson("account.json"),
      loadJson("settings.json"),
      loadJson("chart/" + store.range + ".json").catch(() => loadJson("chart.json")),
    ]);
    store.state = state;
    store.activity = activity;
    store.account = account;
    store.settings = settings;
    store.chart[store.range] = chart;
    store.updatedAt = state.updatedAt || new Date().toISOString();
    store.error = null;
    store.retryIn = 0;
    store.loading = false;
    prefetchKnown();
  } catch (err) {
    store.error = err;
    store.retryIn = 15;
    store.loading = false;
  }
}

function knownMints() {
  const set = new Set();
  const push = (m) => { if (m) set.add(m); };
  ((store.activity && store.activity.rows) || []).forEach((r) => push(r.mint));
  ((store.state && store.state.activity) || []).forEach((r) => push(r.mint));
  const sc = agentBy("scanner");
  (sc.feed || []).forEach((f) => push(f.mint));
  if (agentBy("auditor").currentMint) push(agentBy("auditor").currentMint);
  Object.values(store.decisions).forEach((d) => (d.decisions || []).forEach((x) => push(x.mint)));
  if (route.mint) push(route.mint);
  return [...set];
}

async function prefetchKnown() {
  const jobs = [];
  for (const name of AGENT_ORDER) {
    if (!store.decisions[name]) {
      jobs.push(loadJson("agents/" + name + "/decisions.json").then((d) => { store.decisions[name] = d; }).catch(() => {}));
    }
  }
  await Promise.all(jobs);
}

async function ensureCoin(mint) {
  if (!mint) return null;
  if (store.demo === "empty") {
    store.coins[mint] = null;
    return null;
  }
  if (store.coins[mint] === undefined) {
    try { store.coins[mint] = await loadJson("coin/" + mint + ".json"); }
    catch { store.coins[mint] = null; }
  }
  return store.coins[mint];
}
async function ensureAudit(mint) {
  if (!mint) return null;
  if (store.demo === "empty") {
    store.audits[mint] = { empty: true };
    return store.audits[mint];
  }
  if (store.audits[mint] === undefined) {
    try { store.audits[mint] = await loadJson("audit/" + mint + ".json"); }
    catch { store.audits[mint] = { missing: true }; }
  }
  return store.audits[mint];
}
async function ensureChart(range) {
  if (!store.chart[range]) {
    try { store.chart[range] = await loadJson("chart/" + range + ".json"); }
    catch { store.chart[range] = { range, points: [], marks: [], startValue: store.state && store.state.balance }; }
  }
  return store.chart[range];
}

/* ---------- render helpers ---------- */

function setTabs() {
  const hide = route.screen === "lock";
  tabbar.style.display = hide ? "none" : "flex";
  tabbar.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.tab === route.tab);
  });
}

function showBanner() {
  if (!store.error || store.demo === "empty") {
    banner.hidden = true;
    return;
  }
  const last = store.updatedAt ? fmtTime(store.updatedAt) : "never";
  banner.hidden = false;
  banner.textContent = `Desk offline · retrying in ${Math.max(0, store.retryIn)}s · last update ${last}`;
}

function navBar({ title, back, brand, tools }) {
  return `<div class="nav">
    ${back ? `<button class="icon-btn" data-act="back" type="button" aria-label="Back">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M15 5 8 12l7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>` : ""}
    ${brand || (title ? `<div class="nav-title">${escapeHtml(title)}</div>` : "")}
    <div class="nav-spacer"></div>
    ${tools || ""}
  </div>`;
}

function homeNav() {
  return navBar({
    brand: `<button class="nav-brand" data-act="account" type="button">Grok Bot <span>›</span></button>`,
    tools: `<button class="icon-btn" data-act="search" type="button" aria-label="Search">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.8"/><path d="M16 16l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    </button>
    <button class="icon-btn" data-act="account" type="button" aria-label="Account">
      <span class="avatar">A</span>
    </button>
    <button class="icon-btn" data-act="bell" type="button" aria-label="Notifications">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 19a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      <span class="bell-dot${hasUnread() ? " on" : ""}"></span>
    </button>`,
  });
}

function hasUnread() {
  const rows = (store.activity && store.activity.rows) || [];
  if (!rows.length) return false;
  const seen = localStorage.getItem(LS_SEEN) || "";
  return rows.some((r) => (r.ts || "") > seen);
}

function paperBadge(mode) {
  return mode === "PAPER" ? `<span class="paper-pill">PAPER</span>` : "";
}

function odometerHtml(value) {
  const text = money(value);
  return `<div class="odometer" data-odo="${escapeHtml(text)}">${[...text].map((ch, i) =>
    /[0-9]/.test(ch)
      ? `<span class="odo-reel" data-i="${i}" data-d="${ch}"><span>${"0123456789".split("").map((n) => n).join("<br>")}</span></span>`
      : `<span class="odo-char">${escapeHtml(ch)}</span>`
  ).join("")}</div>`;
}

function spinOdometer(root, prev, next) {
  root.querySelectorAll(".odo-reel").forEach((reel) => {
    const d = Number(reel.dataset.d);
    const span = reel.querySelector("span");
    const apply = () => { span.style.transform = `translateY(${-d}em)`; };
    if (reduced()) { apply(); return; }
    reel.classList.add("anim");
    const delay = 30 * (root.querySelectorAll(".odo-reel").length - 1 - Number(reel.dataset.i || 0));
    setTimeout(apply, Math.max(0, delay));
  });
}

function activityRow(r) {
  if (!r) return "";
  const kind = (r.kind || "").toLowerCase();
  const act = kind === "rejected" ? "audit" : "coin";
  return `<button class="row" type="button" data-act="${act}" data-mint="${escapeHtml(r.mint || "")}">
    <div class="mid"><div class="title">${escapeHtml(r.title || kind)}</div>
    <div class="sub">${escapeHtml(r.subtitle || "")}</div></div>
    <div class="right ${kind === "sold" ? "green" : kind === "stopped" ? "red" : ""}">${escapeHtml(r.value || "")}</div>
  </button>`;
}

function scannerFeed(card) {
  const feed = card.feed || [];
  if (!feed.length || store.demo === "empty") {
    return `<div class="feed muted">Listening for graduations</div>`;
  }
  return `<div class="feed">${feed.slice(0, 5).map((f) => {
    const kill = (f.verdict || "").toLowerCase() !== "pass";
    return `<div>${kill
      ? `<span class="strike">${escapeHtml(f.name || f.mint)}</span><span class="kill-reason">${escapeHtml(f.reason || "")}</span>`
      : `${escapeHtml(f.name || f.mint)} <span class="muted">→ auditor</span>`}</div>`;
  }).join("")}</div>`;
}

function auditorLayers(card) {
  const layers = card.layers || [];
  const cells = [];
  for (let i = 1; i <= 8; i++) {
    const L = layers.find((x) => x.layer === i);
    let cls = "wait";
    if (L && L.pass === true) cls = "ok";
    else if (L && L.pass === false) cls = "no";
    cells.push(`<div class="layer-strip ${cls}"></div>`);
  }
  return `<div class="layers-grid">${cells.join("")}</div>`;
}

function agentCardHtml(name) {
  const a = agentBy(name);
  if (name === "scanner") {
    return `<button class="agent-card" type="button" data-act="tab" data-tab="agents" style="border-radius:${radius()}px">
      <div class="kicker" style="color:var(--cyan)">Scanner</div>
      <div class="count">${store.demo === "empty" ? "0" : (a.pools ?? 0)} pools</div>
      ${scannerFeed(a)}
    </button>`;
  }
  if (name === "auditor") {
    const empty = store.demo === "empty" || !(a.takenApart || a.layers && a.layers.length);
    return `<button class="agent-card" type="button" data-act="tab" data-tab="agents" style="border-radius:${radius()}px">
      <div class="kicker">Auditor</div>
      <div class="count">${empty ? "0" : (a.takenApart ?? 0)} taken apart</div>
      ${empty ? `<div class="feed muted">No coin taken apart yet</div>` : auditorLayers(a)}
      <div class="headline">${escapeHtml(empty ? "" : (a.headline || ""))}</div>
      ${empty ? "" : `<div class="muted">${a.rejected ?? 0} rejected</div>`}
    </button>`;
  }
  if (name === "analyst") {
    return `<button class="agent-card" type="button" data-act="tab" data-tab="agents" style="border-radius:${radius()}px">
      <div class="kicker" style="color:var(--yellow)">Analyst</div>
      <div class="count">Scoring</div>
      <canvas class="score-ring" width="140" height="140" style="width:120px;height:120px;margin:0 auto;display:block"></canvas>
    </button>`;
  }
  if (name === "executor") {
    const size = a.sizeUsd != null ? money(a.sizeUsd) : "—";
    const sp = a.stackPct != null ? Number(a.stackPct).toFixed(1) : "—";
    return `<button class="agent-card" type="button" data-act="tab" data-tab="agents" style="border-radius:${radius()}px">
      <div class="kicker" style="color:var(--green)">Executor</div>
      <div class="count">${a.trades ?? 0} trades</div>
      <div class="muted">${size} · ${sp}% of stack</div>
      <div class="headline" style="margin-top:auto">${escapeHtml(a.headline || "Executing... 0%")}</div>
    </button>`;
  }
  const stop = a.stopPct != null ? `-${Number(a.stopPct)}%` : "—";
  const trail = a.trailPct != null ? `${Number(a.trailPct)}%` : "—";
  return `<button class="agent-card" type="button" data-act="tab" data-tab="agents" style="border-radius:${radius()}px">
    <div class="kicker" style="color:var(--pink)">Risk</div>
    <div class="count">Guarding</div>
    <div class="headline">${escapeHtml(a.headline || "Guarding")}</div>
    <div style="margin-top:10px">
      <span class="pill pill-red">stop ${escapeHtml(stop)}</span>
      <span class="pill pill-green">trail ${escapeHtml(trail)}</span>
    </div>
  </button>`;
}

function radius() {
  const width = Math.max(200, (window.innerWidth || 390) - 32);
  return 42 * width / 504;
}

function runningCount() {
  return ((store.state && store.state.agents) || []).filter((a) => a.status !== "paused").length;
}

/* ---------- screens ---------- */

function renderLock() {
  view.classList.add("locked");
  view.innerHTML = `<div class="lock">
    <h1>Grok Bot</h1>
    <p class="muted">Open your private desk link to sign in. The token stays on this phone and is never sent to a server.</p>
  </div>`;
}

function renderLoading() {
  view.innerHTML = `${homeNav()}
    <div class="balance-wrap"><div class="skel" style="height:72px;width:70%;border-radius:8px"></div>
    <div class="skel" style="height:18px;width:40%;margin-top:12px"></div></div>
    <div class="chart-card"><div class="skel" style="height:180px;border-radius:12px"></div></div>
    <div class="h-section"><div class="skel" style="height:24px;width:50%"></div></div>
    <div style="padding:0 16px"><div class="skel" style="height:200px;border-radius:24px"></div></div>`;
}

function renderHome() {
  const st = store.state || {};
  const mode = st.mode || "PAPER";
  const ch = store.chart[store.range] || { points: [], marks: [], startValue: st.balance };
  const emptyChart = store.demo === "empty" || !ch.points || (ch.points.length <= 1 && !(ch.marks || []).length);
  const rows = store.demo === "empty" ? [] : (st.activity || (store.activity && store.activity.rows) || []).slice(0, 5);
  const today = st.todayPct;
  const mult = st.multiplier;
  const bal = st.balance;
  view.innerHTML = `${homeNav()}
    <div class="balance-wrap">
      <div class="balance-row">${odometerHtml(bal)}${paperBadge(mode)}</div>
      <div class="meta-row">
        <span class="${Number(today) < 0 ? "red" : "green"}">${pct(today)}</span>
        <span class="mult">${Number(mult).toFixed(2)}×</span>
      </div>
    </div>
    <div class="chart-card">
      <canvas id="home-chart"></canvas>
      <div class="chart-empty" ${emptyChart ? "" : "hidden"}>Waiting for the first trade</div>
      <div class="ranges">${RANGES.map((r) => `<button type="button" data-act="range" data-range="${r}" class="${r === store.range ? "on" : ""}">${r}</button>`).join("")}</div>
    </div>
    <div class="h-section">Agents · ${runningCount()} running</div>
    <div class="carousel">${AGENT_ORDER.map(agentCardHtml).join("")}</div>
    <div class="h-section">Activity <button class="link" type="button" data-act="tab" data-tab="activity">See all</button></div>
    ${rows.length ? rows.map(activityRow).join("") : `<div class="empty-note">Nothing yet tonight</div>`}`;

  requestAnimationFrame(() => {
    spinOdometer($(".odometer"));
    const c = $("#home-chart");
    if (c) {
      const payload = emptyChart ? { points: ch.points && ch.points.length ? ch.points : [{ ts: st.updatedAt, value: ch.startValue ?? bal }], marks: [], startValue: ch.startValue ?? bal } : ch;
      drawLineChart(c, payload, { progress: 1, markFade: 1 });
    }
    const ring = $(".score-ring");
    if (ring) drawScoreRing(ring, store.demo === "empty" ? null : agentBy("analyst").score);
  });
}

function renderAgents() {
  view.innerHTML = `${navBar({ title: "Agents" })}
    ${AGENT_ORDER.map((name) => {
      const d = store.decisions[name] || { name, status: agentBy(name).status, paused: false, decisions: [], todayCount: 0, locked: false };
      const a = agentBy(name);
      const count = d.todayCount ?? 0;
      const locked = !!d.locked;
      const paused = !!d.paused;
      const rows = (store.demo === "empty" ? [] : (d.decisions || [])).slice(0, 20);
      return `<section class="full-agent" id="agent-${name}">
        <header>
          <span class="status-dot ${paused ? "paused" : ""}"></span>
          <strong style="text-transform:capitalize">${escapeHtml(name)}</strong>
          <span class="muted">${count} today</span>
          <button class="settings-link" type="button" data-act="settings-group" data-group="${name === "scanner" ? "scanner" : name}">Settings</button>
          <button class="switch ${paused ? "" : "on"} ${locked ? "locked" : ""}" type="button" data-act="pause-note" data-name="${name}" ${locked ? "disabled" : ""} aria-label="Pause"></button>
        </header>
        <div class="decisions">
          ${rows.length ? rows.map((r) => `<div class="row">
            <button type="button" class="mid" data-act="${name === "auditor" && (r.verdict === "rejected") ? "audit" : "coin"}" data-mint="${escapeHtml(r.mint || "")}" style="text-align:left">
              <div class="title">${escapeHtml(r.name || r.mint || "")}</div>
              <div class="sub">${escapeHtml(fmtTime(r.ts) + " · " + (r.verdict || "") + (r.reason ? " · " + r.reason : ""))}</div>
            </button>
            ${r.coin_url ? `<a class="settings-link" href="${escapeHtml(r.coin_url)}" data-act="ext" target="_blank" rel="noopener">FOMO</a>` : ""}
          </div>`).join("") : `<div class="empty-note">No decisions yet</div>`}
        </div>
      </section>`;
    }).join("")}
    <p class="note">Pause, resume and settings are read-only on this page. Change them in Telegram.</p>`;
}

function renderActivity() {
  const rows = store.demo === "empty" ? [] : ((store.activity && store.activity.rows) || []);
  view.innerHTML = `${navBar({ title: "Activity" })}
    ${rows.length ? rows.map(activityRow).join("") : `<div class="empty-note">Nothing yet tonight</div>`}`;
}

function renderAccount() {
  const acc = store.account || {};
  const st = (store.settings && store.settings.settings) || {};
  const grouped = (store.settings && store.settings.grouped) || {};
  const mode = acc.mode || st.mode || "PAPER";
  const tg = acc.telegram || {};
  const webPush = acc.webPush || {};
  const groups = ["desk", "scanner", "auditor", "analyst", "executor", "risk"];
  view.innerHTML = `${navBar({ title: "Account" })}
    <div class="group-title">Mode</div>
    <div class="group">
      <div class="cell">
        <div class="lbl">Mode</div>
        <div class="seg">
          <button type="button" class="${mode === "PAPER" ? "on" : ""}" disabled>PAPER</button>
          <button type="button" class="${mode === "LIVE" ? "on" : ""}" data-act="live-note" disabled>LIVE</button>
        </div>
      </div>
      <div class="cell"><div class="lbl">Stack</div><div class="val num">${money(acc.stack)}</div></div>
    </div>
    <p class="note">Switching PAPER / LIVE and editing the stack is done in Telegram.</p>
    <div class="group-title">FOMO</div>
    <div class="group">
      <a class="cell" href="${escapeHtml(acc.profile_url || "#")}" data-act="ext" target="_blank" rel="noopener">
        <div class="lbl">Your FOMO profile</div><div class="val">Open</div>
      </a>
      <button class="cell" type="button" data-act="invite">
        <div class="lbl">Invite a friend</div><div class="val">Share</div>
      </button>
    </div>
    ${groups.map((g) => {
      const items = grouped[g] || {};
      const keys = Object.keys(items);
      if (!keys.length) return "";
      return `<div class="group-title" id="settings-${g}">${escapeHtml(g[0].toUpperCase() + g.slice(1))}</div>
      <div class="group">${keys.map((k) => settingBlock(k, items[k])).join("")}</div>`;
    }).join("")}
    <div class="group-title">Notifications</div>
    <div class="group">
      <div class="cell"><div class="lbl">Telegram</div><div class="val">${tg.connected ? "Connected" : "Not connected"}</div></div>
      <button class="cell" type="button" data-act="test-push"><div class="lbl">Send test push</div><div class="val">Telegram</div></button>
      <div class="cell"><div class="lbl">Enable notifications</div><div class="val">${webPush.available ? "Available" : "Telegram only"}</div></div>
    </div>
    <p class="note">${escapeHtml(webPush.reason || "Plan B has no web push; use Telegram.")}</p>`;
}

function settingBlock(key, spec) {
  const typ = (spec && spec.type) || "str";
  const val = spec && spec.value;
  const min = spec && spec.min, max = spec && spec.max;
  if (typ === "bool") {
    return `<div class="cell"><div class="lbl">${escapeHtml(prettyKey(key))}</div>
      <button class="switch ${val ? "on" : ""}" type="button" data-act="setting-note" disabled></button></div>`;
  }
  if (typ === "choice") {
    return `<div class="cell"><div class="lbl">${escapeHtml(prettyKey(key))}</div><div class="val">${escapeHtml(String(val ?? ""))}</div></div>`;
  }
  if (typ === "int" || typ === "float") {
    return `<div class="setting-block">
      <label><span>${escapeHtml(prettyKey(key))}</span><input type="number" disabled value="${escapeHtml(val ?? "")}"></label>
      ${min != null && max != null ? `<input type="range" disabled min="${min}" max="${max}" step="${typ === "int" ? 1 : "any"}" value="${escapeHtml(val ?? min)}">` : ""}
    </div>`;
  }
  return `<div class="cell"><div class="lbl">${escapeHtml(prettyKey(key))}</div><div class="val">${escapeHtml(String(val ?? ""))}</div></div>`;
}

function renderAudit(audit, coin) {
  const empty = store.demo === "empty" || !audit || audit.empty || audit.missing || !(audit.layers || []).length;
  const name = (audit && audit.name) || (coin && coin.name) || "Auditor";
  if (empty) {
    view.innerHTML = `${navBar({ title: "Auditor", back: true })}
      <div class="empty-note">No coin taken apart yet</div>`;
    return;
  }
  const layers = audit.layers || [];
  const rejected = audit.verdict === "rejected";
  const discs = [];
  for (let i = 1; i <= 8; i++) {
    const L = layers.find((x) => x.layer === i) || { layer: i, name: "Layer " + i, value: "", pass: null };
    discs.push(L);
  }
  view.innerHTML = `${navBar({ title: name, back: true, tools: paperBadge((store.state || {}).mode) })}
    <div class="discs" id="discs">
      <div class="beam" id="beam"></div>
      ${discs.map((L, i) => `<div class="disc" data-i="${i}" data-pass="${L.pass === true ? "1" : L.pass === false ? "0" : ""}">${escapeHtml((L.name || "").split(" ")[0] || String(i + 1))}</div>`).join("")}
    </div>
    <div class="verdict-block">
      <h2>${rejected ? "Rejected · " + escapeHtml(audit.reason || "") : "Cleared · 8/8 parts"}</h2>
      <div class="muted">${rejected ? "Grok Bot won't buy " + escapeHtml(name) : "Sent to Executor" + (audit.sizeUsd != null ? " · " + money(audit.sizeUsd) : "")}</div>
    </div>
    <div class="layer-rows">
      ${discs.map((L) => `<div class="layer-row"><span>${escapeHtml(L.name || "")}</span><span class="val ${L.pass === false ? "red" : L.pass === true ? "green" : ""}">${escapeHtml(L.value || "")}</span></div>`).join("")}
    </div>
    <div class="toggle-row">
      <div>Take apart before buying</div>
      <button class="switch ${((store.settings && store.settings.settings) || {}).auditor_enabled !== false ? "on" : ""}" type="button" data-act="auditor-toggle" disabled></button>
    </div>
    <p class="note">This toggle is read-only here. Change it in Telegram. Turning it off requires two confirms.</p>
    ${audit.coin_url ? `<a class="primary-btn" data-act="ext" href="${escapeHtml(audit.coin_url)}" target="_blank" rel="noopener">Open on FOMO</a>` : ""}`;

  runBeam();
}

function runBeam() {
  const discs = [...view.querySelectorAll(".disc")];
  const beam = $("#beam");
  if (!discs.length) return;
  if (reduced()) {
    discs.forEach((el) => applyDisc(el));
    return;
  }
  let i = 0;
  const step = () => {
    if (i >= discs.length) {
      if (beam) beam.classList.remove("on");
      return;
    }
    const el = discs[i];
    const pass = el.dataset.pass;
    if (pass === "") {
      // wait for a result the server didn't send — stay on this disc
      if (beam) {
        beam.classList.add("on");
        positionBeam(beam, el);
      }
      setTimeout(step, 350);
      return;
    }
    if (beam) {
      beam.classList.add("on");
      positionBeam(beam, el);
    }
    setTimeout(() => {
      applyDisc(el);
      i += 1;
      setTimeout(step, 150);
    }, 350);
  };
  step();
}
function positionBeam(beam, el) {
  const parent = el.parentElement.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  beam.style.top = (r.top - parent.top - 4) + "px";
  beam.style.height = (r.height + 8) + "px";
}
function applyDisc(el) {
  if (el.dataset.pass === "1") { el.classList.add("ok"); el.textContent = "✓"; }
  else if (el.dataset.pass === "0") { el.classList.add("no"); el.textContent = "✕"; }
}

function renderCoin(coin) {
  const header = navBar({
    title: (coin && coin.name) || "Coin",
    back: true,
    tools: `${paperBadge((store.state || {}).mode)}${coin && coin.auditShield ? `<span class="shield">${escapeHtml(coin.auditShield)}</span>` : ""}`,
  });
  if (store.demo === "empty" || !coin) {
    view.innerHTML = `${header}<div class="empty-note">No coin to show</div>`;
    return;
  }
  const change = coin.priceChangeSinceEntry;
  const pos = coin.position && !coin.position.closedAt ? coin.position : null;
  const stats = coin.stats || {};
  const hold = stats.holders == null ? "n/a" : stats.holders;
  view.innerHTML = `${header}
    <div class="muted" style="padding:0 16px">${escapeHtml(coin.symbol || "")} · ${escapeHtml((coin.chain || "solana")[0].toUpperCase() + (coin.chain || "solana").slice(1))} · ${escapeHtml(agoAge(coin.ageMin))}</div>
    <div class="price-lg num">${coin.price == null ? "—" : money(coin.price, coin.price < 1 ? 6 : 2)}</div>
    <div class="coin-sub ${change != null && change >= 0 ? "green" : "red"}">${change == null ? "" : (change >= 0 ? "▲ " : "▼ ") + pct(change)}</div>
    <div class="chart-card" style="height:240px"><canvas id="coin-chart" style="height:220px"></canvas></div>
    <div class="stats-grid">
      <div><div class="stat-lbl">Market cap</div><div class="stat-val">${compactMoney(stats.marketCap)}</div></div>
      <div><div class="stat-lbl">Liquidity</div><div class="stat-val">${compactMoney(stats.liquidity)}</div></div>
      <div><div class="stat-lbl">24h volume</div><div class="stat-val">${compactMoney(stats.volume24h)}</div></div>
      <div><div class="stat-lbl">Holders</div><div class="stat-val">${escapeHtml(String(hold))}</div></div>
    </div>
    ${pos ? `<div class="exit-card">
      <h3>Your position · ${money(pos.sizeUsd)} in · Executor</h3>
      <div>
        <span class="pill pill-red">stop ${pos.stopPct != null ? ("-" + Number(pos.stopPct).toFixed(1) + "%") : money(pos.stopPrice)}</span>
        <span class="pill pill-green">trail ${pos.trailLine != null ? money(pos.trailLine, 6) : "off"}</span>
      </div>
      <div class="muted" style="margin-top:8px">Time left to timeout: ${escapeHtml(timeoutLeft(pos.timeoutAt))}</div>
    </div>` : ""}
    ${coin.coin_url ? `<a class="primary-btn" data-act="ext" href="${escapeHtml(coin.coin_url)}" target="_blank" rel="noopener">${pos ? "Sell on FOMO" : "Buy on FOMO"}</a>` : ""}`;

  requestAnimationFrame(() => {
    const c = $("#coin-chart");
    if (c) drawCandles(c, coin.candles || [], coin.exitLines || {});
  });
}

function timeoutLeft(ts) {
  if (!ts) return "—";
  const d = new Date(ts.endsWith("Z") ? ts : ts + "Z");
  const ms = d.getTime() - Date.now();
  if (Number.isNaN(d.getTime())) return "—";
  if (ms <= 0) return "0m";
  const m = Math.round(ms / 60000);
  if (m < 60) return m + "m";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

/* ---------- search / toasts ---------- */

function openSearch() {
  closeSheet();
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.id = "sheet";
  sheet.innerHTML = `<div class="sheet-card">
    <input id="q" type="search" placeholder="Name, symbol or mint" autofocus>
    <div id="q-results"></div>
  </div>`;
  document.body.appendChild(sheet);
  const input = $("#q");
  const results = $("#q-results");
  const draw = () => {
    const q = (input.value || "").trim().toLowerCase();
    const items = [];
    knownMints().forEach((m) => {
      const c = store.coins[m] || {};
      const name = c.name || "", sym = c.symbol || "";
      const blob = (name + " " + sym + " " + m).toLowerCase();
      if (!q || blob.includes(q)) items.push({ mint: m, name: name || m, symbol: sym });
    });
    if (q && q.length >= 8 && !items.some((x) => x.mint === q)) items.push({ mint: q, name: q, symbol: "" });
    results.innerHTML = items.slice(0, 12).map((it) =>
      `<button class="row" type="button" data-act="coin" data-mint="${escapeHtml(it.mint)}"><div class="mid"><div class="title">${escapeHtml(it.name)}</div><div class="sub">${escapeHtml(it.symbol || it.mint)}</div></div></button>`
    ).join("") || `<div class="empty-note">No matches</div>`;
  };
  input.addEventListener("input", draw);
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) closeSheet();
  });
  draw();
  input.focus();
}
function closeSheet() {
  const s = $("#sheet");
  if (s) s.remove();
}
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

async function invite() {
  const url = store.account && store.account.signup_url;
  if (!url) return;
  if (navigator.share) {
    try { await navigator.share({ title: "FOMO", url }); return; } catch {}
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  } catch {
    toast("Link copied");
  }
}

/* ---------- main render / events ---------- */

function render() {
  setTabs();
  showBanner();
  if (!token() || !dataPath()) {
    route.screen = "lock";
    renderLock();
    return;
  }
  view.classList.remove("locked");
  if (store.loading && !store.state) {
    renderLoading();
    return;
  }
  const sc = route.screen;
  if (sc === "home") renderHome();
  else if (sc === "agents") renderAgents();
  else if (sc === "activity") renderActivity();
  else if (sc === "account") renderAccount();
  else if (sc === "audit") {
    const au = store.audits[route.mint];
    if (au === undefined) {
      renderLoading();
      ensureAudit(route.mint).then(() => render());
      return;
    }
    renderAudit(au, store.coins[route.mint]);
  } else if (sc === "coin") {
    const c = store.coins[route.mint];
    if (c === undefined) {
      renderLoading();
      ensureCoin(route.mint).then(() => render());
      return;
    }
    renderCoin(c);
  }
}

view.addEventListener("click", async (e) => {
  const ext = e.target.closest("[data-act=ext]");
  if (ext && ext.href) return; // let the browser follow coin_url / profile_url
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  if (act === "back") { history.length > 1 ? history.back() : go("#/home", { replace: true }); return; }
  if (act === "tab") { go("#/" + el.dataset.tab); return; }
  if (act === "account") { go("#/account"); return; }
  if (act === "search") { openSearch(); return; }
  if (act === "bell") { localStorage.setItem(LS_SEEN, new Date().toISOString()); go("#/activity"); return; }
  if (act === "range") {
    store.range = el.dataset.range;
    await ensureChart(store.range);
    render();
    return;
  }
  if (act === "coin") { closeSheet(); if (el.dataset.mint) go("#/coin/" + el.dataset.mint); return; }
  if (act === "audit") { closeSheet(); if (el.dataset.mint) go("#/audit/" + el.dataset.mint); return; }
  if (act === "settings-group") { go("#/account"); setTimeout(() => { const n = document.getElementById("settings-" + el.dataset.group); if (n) n.scrollIntoView({ behavior: reduced() ? "auto" : "smooth" }); }, 40); return; }
  if (act === "invite") { invite(); return; }
  if (act === "pause-note" || act === "setting-note" || act === "live-note" || act === "test-push" || act === "auditor-toggle") {
    toast("Change this in Telegram");
    return;
  }
});

tabbar.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  go("#/" + tab.dataset.tab);
});

window.addEventListener("popstate", () => {
  Object.assign(route, parseRoute());
  render();
});

/* ---------- boot / poll ---------- */

let pollTimer = null;
let retryTimer = null;

async function tick() {
  await refreshAll();
  Object.assign(route, parseRoute());
  render();
  if (store.error && store.retryIn > 0) {
    clearInterval(retryTimer);
    retryTimer = setInterval(() => {
      store.retryIn = Math.max(0, store.retryIn - 1);
      showBanner();
      if (store.retryIn === 0) {
        clearInterval(retryTimer);
        tick();
      }
    }, 1000);
  }
}

function startPoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (document.visibilityState !== "hidden") tick(); }, POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") tick();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(new URL("sw.js", baseUrl()), { scope: "./" }).catch(() => {});
}

consumeAuthFragment();
Object.assign(route, parseRoute());
if (!location.hash && token() && dataPath()) history.replaceState(null, "", "#/home");

window.__deskTest = {
  setDemo(mode) {
    store.demo = mode || null;
    if (mode === "error") { store.error = "demo"; store.retryIn = 8; }
    else if (mode !== "error") { store.error = null; }
    render();
  },
  go,
  store,
};

tick().then(startPoll);
