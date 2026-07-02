/* Kleine Helfer: DOM, Zufall, Storage. Keine Abhängigkeiten. */

export const $ = (sel, root = document) => root.querySelector(sel);

/** Element-Fabrik. Kinder werden als Text eingefügt (nie als HTML) → kein XSS. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (val == null) continue;
    if (key === "class") node.className = val;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), val);
    else if (key === "disabled" || key === "checked" || key === "value") node[key] = val;
    else node.setAttribute(key, val);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

export function renderInto(container, ...children) {
  container.replaceChildren();
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) container.append(child);
  }
}

/* ---------- Zufall (kryptografisch, gleichverteilt) ---------- */

export function randInt(maxExclusive) {
  if (maxExclusive <= 0) return 0;
  const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  let value;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return value % maxExclusive;
}

export const pick = (arr) => arr[randInt(arr.length)];

export function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** n eindeutige Indizes aus 0..poolSize-1 */
export function pickIndices(poolSize, n) {
  return shuffle([...Array(poolSize).keys()]).slice(0, n);
}

/* ---------- Storage (fehlertolerant, z. B. Inkognito/voll) ---------- */

function safeLoad(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeSave(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const loadLocal = (key, fallback) => safeLoad(localStorage, key, fallback);
export const saveLocal = (key, value) => safeSave(localStorage, key, value);
export const loadSession = (key, fallback) => safeLoad(sessionStorage, key, fallback);
export const saveSession = (key, value) => safeSave(sessionStorage, key, value);
export function clearSession(key) {
  try { sessionStorage.removeItem(key); } catch { /* egal */ }
}
