/* Hand-drawn <canvas> charts. No chart library. */

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

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

function reduced() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function drawScoreRing(canvas, score, opts = {}) {
  const w = canvas.clientWidth || 120;
  const h = canvas.clientHeight || 120;
  const ctx = fit(canvas, w, h);
  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) * 0.38;
  const track = cssVar("--card2", "#2c2c2e");
  const yellow = cssVar("--yellow", "#ffd60a");
  const green = cssVar("--green", "#00d35a");
  const text = cssVar("--text", "#fff");
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = Math.max(6, r * 0.18);
  ctx.lineCap = "round";
  ctx.strokeStyle = track;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const v = Math.max(0, Math.min(100, Number(score) || 0)) / 100;
  if (v > 0) {
    ctx.strokeStyle = v >= 0.7 ? green : yellow;
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + v * Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = text;
  ctx.font = `600 ${Math.round(r * 0.7)}px "SF Pro Display", -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(score == null ? "—" : String(Math.round(Number(score))), cx, cy + 1);
}

export function drawLineChart(canvas, payload, opts = {}) {
  const w = canvas.clientWidth || 358;
  const h = canvas.clientHeight || 180;
  const ctx = fit(canvas, w, h);
  ctx.clearRect(0, 0, w, h);
  const green = cssVar("--green", "#00d35a");
  const blue = cssVar("--blue", "#0a84ff");
  const red = cssVar("--red", "#ff453a");
  const tertiary = cssVar("--tertiary", "rgba(235,235,245,0.3)");
  const points = (payload && payload.points) || [];
  const marks = (payload && payload.marks) || [];
  const start = payload && payload.startValue != null ? Number(payload.startValue) : (points[0] && points[0].value);
  const topPad = marks.length ? 36 : 16;
  const botPad = 16, left = 4, right = 4;
  const plotH = h - topPad - botPad;
  const plotW = w - left - right;
  const vals = points.map((p) => Number(p.value)).filter((n) => !Number.isNaN(n));
  if (start != null) vals.push(Number(start));
  let min = Math.min(...vals), max = Math.max(...vals);
  if (!vals.length) { min = 0; max = 1; }
  if (min === max) { min -= 1; max += 1; }
  const y = (v) => topPad + (1 - (v - min) / (max - min)) * plotH;
  const x = (i, n) => left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);

  // start line
  if (start != null) {
    ctx.save();
    ctx.strokeStyle = tertiary;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    const sy = y(Number(start));
    ctx.moveTo(left, sy);
    ctx.lineTo(left + plotW, sy);
    ctx.stroke();
    ctx.restore();
  }

  if (!points.length) return { empty: true };

  const progress = opts.progress == null || reduced() ? 1 : Math.max(0, Math.min(1, opts.progress));
  const n = points.length;
  const lastX = x(n - 1, n);
  const firstX = x(0, n);
  const clipX = firstX + (lastX - firstX) * progress;

  // fill
  const grad = ctx.createLinearGradient(0, topPad, 0, h - botPad);
  grad.addColorStop(0, "rgba(0,211,90,0.28)");
  grad.addColorStop(1, "rgba(0,211,90,0)");
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, clipX + 1, h);
  ctx.clip();
  ctx.beginPath();
  points.forEach((p, i) => {
    const px = x(i, n), py = y(Number(p.value));
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.lineTo(x(n - 1, n), h - botPad);
  ctx.lineTo(x(0, n), h - botPad);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // line
  ctx.beginPath();
  points.forEach((p, i) => {
    const px = x(i, n), py = y(Number(p.value));
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = green;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();

  // marks, stacked if they collide
  const fade = opts.markFade == null || reduced() ? 1 : Math.max(0, Math.min(1, opts.markFade));
  const placed = [];
  const colorFor = (m) => {
    const k = (m.kind || "").toLowerCase();
    if (k === "bought") return blue;
    if (k === "stopped") return red;
    return green;
  };
  marks.forEach((m, i) => {
    let mi = 0;
    if (m.ts && points.length) {
      const t = m.ts;
      let best = 0, bd = Infinity;
      points.forEach((p, j) => {
        const d = Math.abs(String(p.ts).localeCompare(String(t)));
        // nearest index by string compare is weak; use index ratio if possible
      });
      const ptTimes = points.map((p) => p.ts);
      const idx = ptTimes.findIndex((ts) => ts >= t);
      mi = idx < 0 ? n - 1 : idx;
    } else {
      mi = i;
    }
    const mx = x(Math.min(mi, n - 1), n);
    let row = 0;
    let my = topPad - 4;
    for (;;) {
      const collide = placed.some((q) => Math.abs(q.x - mx) < 72 && q.row === row);
      if (!collide) break;
      row += 1;
      my = topPad - 4 - row * 14;
    }
    placed.push({ x: mx, row });
    ctx.globalAlpha = fade;
    ctx.fillStyle = colorFor(m);
    ctx.font = '600 11px "SF Pro Text", -apple-system, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const label = m.label || "";
    ctx.fillText(label, Math.max(36, Math.min(w - 36, mx)), Math.max(12, my));
    ctx.globalAlpha = 1;
  });

  return { empty: points.length <= 1 && marks.length === 0 };
}

export function drawCandles(canvas, candles, exitLines) {
  const w = canvas.clientWidth || 358;
  const h = canvas.clientHeight || 220;
  const ctx = fit(canvas, w, h);
  ctx.clearRect(0, 0, w, h);
  const green = cssVar("--green", "#00d35a");
  const red = cssVar("--red", "#ff453a");
  const orange = cssVar("--orange", "#ff9f0a");
  const tertiary = cssVar("--tertiary", "rgba(235,235,245,0.3)");
  const volH = 44;
  const top = 8, bot = 8;
  const plotH = h - volH - top - bot;
  const rows = candles || [];
  if (!rows.length) {
    ctx.fillStyle = tertiary;
    ctx.font = '13px "SF Pro Text", -apple-system, sans-serif';
    ctx.textAlign = "center";
    ctx.fillText("No candles yet", w / 2, h / 2);
    return;
  }
  const highs = rows.map((c) => Number(c.high));
  const lows = rows.map((c) => Number(c.low));
  const lines = [];
  if (exitLines && exitLines.stop != null) lines.push(Number(exitLines.stop));
  if (exitLines && exitLines.trail != null) lines.push(Number(exitLines.trail));
  let min = Math.min(...lows, ...lines);
  let max = Math.max(...highs, ...lines);
  if (min === max) { min *= 0.99; max *= 1.01; }
  const y = (v) => top + (1 - (v - min) / (max - min)) * plotH;
  const nSlots = Math.max(rows.length, 24);
  const slot = w / nSlots;
  const bodyW = Math.max(3, Math.min(9, slot * 0.6));
  const vols = rows.map((c) => Math.max(0, Number(c.volume) || 0));
  const vmax = Math.max(1, ...vols);

  // exit / trail line
  const exitY = (() => {
    if (exitLines && exitLines.trail != null) return y(Number(exitLines.trail));
    if (exitLines && exitLines.stop != null) return y(Number(exitLines.stop));
    return null;
  })();
  if (exitY != null) {
    ctx.save();
    ctx.strokeStyle = orange;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(0, exitY);
    ctx.lineTo(w, exitY);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = orange;
    ctx.font = '11px "SF Pro Text", -apple-system, sans-serif';
    ctx.textAlign = "right";
    ctx.fillText("Risk trailing stop", w - 4, Math.max(12, exitY - 4));
  }

  rows.forEach((c, i) => {
    const cx = (i + 0.5) * slot;
    const up = Number(c.close) >= Number(c.open);
    ctx.strokeStyle = up ? green : red;
    ctx.fillStyle = up ? green : red;
    ctx.beginPath();
    ctx.moveTo(cx, y(Number(c.high)));
    ctx.lineTo(cx, y(Number(c.low)));
    ctx.stroke();
    const topB = y(Math.max(Number(c.open), Number(c.close)));
    const botB = y(Math.min(Number(c.open), Number(c.close)));
    const bh = Math.max(1, botB - topB);
    ctx.fillRect(cx - bodyW / 2, topB, bodyW, bh);
    const vh = (vols[i] / vmax) * (volH - 8);
    ctx.globalAlpha = 0.45;
    ctx.fillRect(cx - bodyW / 2, h - bot - vh, bodyW, vh);
    ctx.globalAlpha = 1;
  });
}
