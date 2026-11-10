/** Parse the private desk link from a hash or pasted URL. Fragment only; never query. */

function decodeOnce(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Extract {t, d} from a full private URL, a `#t=...&d=...` fragment, or
 * `t=...&d=...`. Query-string t/d are ignored (those would hit server logs).
 * Handles a few rounds of URL-encoding (t%3D, %23t%3D, …).
 */
export function parseAuthParams(input) {
  if (input == null) return null;
  let s = String(input).trim().replace(/^['"]+|['"]+$/g, "").trim();
  if (!s) return null;

  const hashIdx = s.indexOf("#");
  if (hashIdx >= 0) {
    s = s.slice(hashIdx + 1);
  } else if (/^https?:\/\//i.test(s)) {
    // Full URL with no fragment — do not fall back to ?t= / ?d=.
    return null;
  }
  s = s.replace(/^#/, "").trim();
  if (!s || s.startsWith("/")) return null;

  for (let i = 0; i < 3; i++) {
    if (s.includes("t=") && s.includes("d=")) break;
    const next = decodeOnce(s);
    if (next === s) break;
    s = next.replace(/^#/, "");
    const inner = s.indexOf("#");
    if (inner >= 0) s = s.slice(inner + 1);
  }

  const ampRoute = s.search(/&\/|^\//);
  const paramStr = ampRoute >= 0 ? s.slice(0, ampRoute).replace(/&$/, "") : s;
  const params = new URLSearchParams(paramStr);
  let t = params.get("t");
  let d = params.get("d");
  if (!t || !d) {
    const manual = {};
    for (const part of paramStr.split("&")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const k = decodeOnce(part.slice(0, eq));
      const v = decodeOnce(part.slice(eq + 1));
      if (k) manual[k] = v;
    }
    t = t || manual.t;
    d = d || manual.d;
  }
  if (!t || !d) return null;
  t = String(t).trim();
  d = String(d).trim();
  if (!t || !d) return null;
  return { t, d };
}

export function applyAuthParams(td, storage) {
  const store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!td || !td.t || !td.d || !store) return false;
  store.setItem("desk.appToken", td.t);
  store.setItem("desk.dataPath", td.d);
  return true;
}
