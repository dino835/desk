/* Hand-drawn <canvas> charts. No chart library. */

export function fit(canvas, cssW, cssH) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

const GREEN = "#22c55e";
const RED = "#ef4444";
const BLUE = "#3b82f6";
const GREY = "rgba(235,235,245,0.35)";
const FONT = '-apple-system, "SF Pro Text", system-ui, sans-serif';

function tsMs(ts) {
  if (ts == null) return NaN;
  if (typeof ts === "number") return ts < 1e12 ? ts * 1000 : ts;
  const s = String(ts);
  return new Date(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z").getTime();
}

/** Smooth balance line with a soft gradient and a glowing latest dot. */
export function drawBalanceLine(canvas, payload, opts = {}) {
  const w = canvas.clientWidth || 358;
  const h = canvas.clientHeight || 200;
  const ctx = fit(canvas, w, h);
  ctx.clearRect(0, 0, w, h);
  const now = opts.now || Date.now();
  let pts = ((payload && payload.points) || [])
    .map((p) => ({ t: tsMs(p.ts), v: Number(p.value) }))
    .filter((p) => !Number.isNaN(p.t) && !Number.isNaN(p.v));
  if (!pts.length && payload && payload.startValue != null) pts = [{ t: now - 3600e3, v: Number(payload.startValue) }];
  if (!pts.length) return;
  const t0 = opts.startMs && opts.startMs < pts[0].t ? opts.startMs : pts[0].t;
  if (pts[0].t > t0) pts.unshift({ t: t0, v: payload && payload.startValue != null ? Number(payload.startValue) : pts[0].v });
  const last = pts[pts.length - 1];
  if (last.t < now) pts.push({ t: now, v: last.v });
  const pad = { l: 2, r: 12, t: 18, b: 10 };
  const vals = pts.map((p) => p.v);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max - min < Math.max(0.01, Math.abs(max) * 0.002)) { const m = (max + min) / 2 || 1; min = m - Math.abs(m) * 0.05 - 0.5; max = m + Math.abs(m) * 0.05 + 0.5; }
  const span = Math.max(1, now - t0);
  const X = (t) => pad.l + ((t - t0) / span) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - min) / (max - min)) * (h - pad.t - pad.b);
  const xy = pts.map((p) => [X(p.t), Y(p.v)]);
  const path = new Path2D();
  path.moveTo(xy[0][0], xy[0][1]);
  for (let i = 1; i < xy.length; i++) {
    const [x0, y0] = xy[i - 1], [x1, y1] = xy[i];
    const cx = (x0 + x1) / 2;
    path.bezierCurveTo(cx, y0, cx, y1, x1, y1);
  }
  const color = opts.color || GREEN;
  const fill = new Path2D(path);
  fill.lineTo(xy[xy.length - 1][0], h);
  fill.lineTo(xy[0][0], h);
  fill.closePath();
  const g = ctx.createLinearGradient(0, pad.t, 0, h);
  g.addColorStop(0, hexA(color, 0.32));
  g.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = g;
  ctx.fill(fill);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke(path);
  // trade marks
  for (const m of (payload && payload.marks) || []) {
    const t = tsMs(m.ts);
    if (Number.isNaN(t) || t < t0) continue;
    const x = X(t);
    let v = pts[0].v;
    for (const p of pts) { if (p.t <= t) v = p.v; }
    ctx.fillStyle = m.kind === "bought" ? BLUE : m.kind === "stopped" ? RED : GREEN;
    ctx.beginPath(); ctx.arc(x, Y(v), 3.5, 0, Math.PI * 2); ctx.fill();
  }
  const [lx, ly] = xy[xy.length - 1];
  const glow = ctx.createRadialGradient(lx, ly, 0, lx, ly, 14);
  glow.addColorStop(0, hexA(color, 0.55));
  glow.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(lx, ly, 14, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.arc(lx, ly, 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fill();
}

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

/** Progress ring with a label in the middle. frac 0..1 */
export function drawRing(canvas, frac, label, color, sub) {
  const w = canvas.clientWidth || 96;
  const h = canvas.clientHeight || 96;
  const ctx = fit(canvas, w, h);
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 7;
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 8;
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  if (f > 0) {
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2); ctx.stroke();
  }
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(r * 0.5)}px ${FONT}`;
  ctx.fillText(label, cx, sub ? cy - 6 : cy + 1);
  if (sub) {
    ctx.fillStyle = GREY;
    ctx.font = `500 ${Math.round(r * 0.26)}px ${FONT}`;
    ctx.fillText(sub, cx, cy + r * 0.38);
  }
}

function fmtPrice(p) {
  if (p == null || Number.isNaN(Number(p))) return "";
  const v = Number(p);
  if (v >= 1) return "$" + v.toFixed(v >= 100 ? 0 : 2);
  if (v === 0) return "$0";
  const e = Math.floor(Math.log10(v));
  return "$" + v.toFixed(Math.min(12, -e + 2));
}

/**
 * Candles with callout bubbles.
 * candles: [{t(ms), o,h,l,c}], events: [{t, kind:'buy'|'sell'|'alert', label}]
 */
export function drawCandles(canvas, candles, events = [], opts = {}) {
  const w = canvas.clientWidth || 358;
  const h = canvas.clientHeight || 260;
  const ctx = fit(canvas, w, h);
  ctx.clearRect(0, 0, w, h);
  const cs = (candles || []).filter((c) => [c.o, c.h, c.l, c.c].every((n) => Number.isFinite(Number(n))));
  if (!cs.length) {
    ctx.fillStyle = GREY;
    ctx.font = `500 14px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText("No price history yet", w / 2, h / 2);
    return;
  }
  const pad = { l: 4, r: 70, t: 44, b: 14 };
  let lo = Math.min(...cs.map((c) => +c.l)), hi = Math.max(...cs.map((c) => +c.h));
  for (const e of events) if (Number.isFinite(e.price)) { lo = Math.min(lo, e.price); hi = Math.max(hi, e.price); }
  if (hi === lo) { hi *= 1.05; lo *= 0.95; }
  const useLog = hi / Math.max(lo, 1e-18) > 20;
  const tf = (v) => (useLog ? Math.log(Math.max(v, 1e-18)) : v);
  const Lo = tf(lo), Hi = tf(hi);
  const Y = (v) => pad.t + (1 - (tf(v) - Lo) / (Hi - Lo)) * (h - pad.t - pad.b);
  const n = cs.length;
  const step = (w - pad.l - pad.r) / n;
  const bw = Math.max(1.5, Math.min(9, step * 0.68));
  const X = (i) => pad.l + step * (i + 0.5);
  // gridlines
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + (i / 3) * (h - pad.t - pad.b);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r + 8, y); ctx.stroke();
  }
  cs.forEach((c, i) => {
    const up = +c.c >= +c.o;
    ctx.strokeStyle = ctx.fillStyle = up ? GREEN : RED;
    const x = X(i);
    ctx.beginPath(); ctx.moveTo(x, Y(+c.h)); ctx.lineTo(x, Y(+c.l)); ctx.stroke();
    const y1 = Y(Math.max(+c.o, +c.c)), y2 = Y(Math.min(+c.o, +c.c));
    ctx.fillRect(x - bw / 2, y1, bw, Math.max(1.5, y2 - y1));
  });
  const idxAt = (t) => {
    let best = 0;
    for (let i = 0; i < n; i++) if (cs[i].t <= t) best = i;
    return best;
  };
  // last price tag
  const lastC = cs[n - 1];
  const ly = Y(+lastC.c);
  const tagUp = +lastC.c >= +cs[0].o;
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = tagUp ? hexA(GREEN, 0.6) : hexA(RED, 0.6);
  ctx.beginPath(); ctx.moveTo(pad.l, ly); ctx.lineTo(w - pad.r + 4, ly); ctx.stroke();
  ctx.setLineDash([]);
  const label = fmtPrice(lastC.c);
  ctx.font = `600 11px ${FONT}`;
  const tw = ctx.measureText(label).width + 10;
  roundRect(ctx, w - pad.r + 6, ly - 10, Math.min(tw, pad.r - 8), 20, 6);
  ctx.fillStyle = tagUp ? GREEN : RED;
  ctx.fill();
  ctx.fillStyle = "#000";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, w - pad.r + 11, ly + 0.5, pad.r - 18);
  // events: markers + bubbles
  const placed = [];
  for (const e of events) {
    if (!Number.isFinite(e.t)) continue;
    if (e.t < cs[0].t - 2 * 3600e3 || e.t > Date.now() + 60e3) continue;
    const i = idxAt(e.t);
    const x = X(i);
    const price = Number.isFinite(e.price) ? e.price : +cs[i].c;
    const y = Y(price);
    const col = e.kind === "buy" ? BLUE : e.kind === "sell" ? GREEN : RED;
    if (e.kind === "buy" || e.kind === "sell") {
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = `700 10px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(e.kind === "buy" ? "B" : "S", x, y + 0.5);
    } else {
      ctx.fillStyle = RED;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    }
    if (!e.label) continue;
    ctx.font = `600 11px ${FONT}`;
    const bw2 = Math.min(w - 16, ctx.measureText(e.label).width + 16);
    let bx = Math.max(6, Math.min(w - bw2 - 6, x - bw2 / 2));
    let by = y - 36;
    if (by < 4) by = y + 14;
    for (const p of placed) {
      if (Math.abs(p.y - by) < 24 && bx < p.x + p.w && bx + bw2 > p.x) by = p.y + 26;
    }
    by = Math.max(4, Math.min(h - 26, by));
    placed.push({ x: bx, y: by, w: bw2 });
    ctx.strokeStyle = hexA(col, 0.7);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, by + (by < y ? 22 : 0)); ctx.lineTo(x, y + (by < y ? -8 : 8)); ctx.stroke();
    roundRect(ctx, bx, by, bw2, 22, 11);
    ctx.fillStyle = e.kind === "alert" ? hexA(RED, 0.92) : "rgba(18,18,20,0.96)";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = col;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(e.label, bx + 8, by + 11.5, bw2 - 14);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
