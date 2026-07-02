/* UI-Bausteine: Screen-Wechsel, Halten-zum-Aufdecken, Timer, Toast,
   Wake-Lock und Zurück-Schutz. */

import { $, el } from "./util.js";

/* ---------- Screens ---------- */

export function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
  window.scrollTo(0, 0);
}

export const activeScreen = () => document.querySelector(".screen.active")?.id;

/* ---------- Toast ---------- */

let toastNode = null;
let toastTimer = 0;

export function toast(message, ms = 2600) {
  if (!toastNode) {
    toastNode = el("div", { class: "toast", role: "status" });
    document.body.append(toastNode);
  }
  toastNode.textContent = message;
  toastNode.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.remove("show"), ms);
}

/* ---------- Halten zum Aufdecken ----------
   Inhalt ist nur sichtbar, solange der Button gedrückt wird.
   onFirstReveal wird beim ersten vollständigen Aufdecken gerufen. */

export function bindHold(button, { onShow, onHide, onFirstReveal }) {
  let held = false;
  let revealed = false;

  const show = (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    ev.preventDefault();
    if (held) return;
    held = true;
    try { button.setPointerCapture(ev.pointerId); } catch { /* egal */ }
    onShow();
    if (!revealed) {
      revealed = true;
      onFirstReveal?.();
    }
  };
  const hide = () => {
    if (!held) return;
    held = false;
    onHide();
  };

  button.addEventListener("pointerdown", show);
  button.addEventListener("pointerup", hide);
  button.addEventListener("pointercancel", hide);
  button.addEventListener("contextmenu", (ev) => ev.preventDefault());
}

/* ---------- Timer ---------- */

export class CountdownTimer {
  constructor(displayNode, onEnd) {
    this.display = displayNode;
    this.onEnd = onEnd;
    this.remaining = 0;
    this.interval = 0;
    this.running = false;
  }

  start(seconds) {
    this.stop();
    this.remaining = seconds;
    this.running = true;
    this.display.classList.remove("done");
    this.render();
    this.interval = setInterval(() => this.tick(), 1000);
  }

  tick() {
    if (!this.running) return;
    this.remaining -= 1;
    this.render();
    if (this.remaining <= 0) {
      this.stop();
      this.display.classList.add("done");
      this.onEnd?.();
    }
  }

  toggle() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = 0;
      this.running = false;
    } else if (this.remaining > 0) {
      this.running = true;
      this.interval = setInterval(() => this.tick(), 1000);
    }
    return this.running;
  }

  stop() {
    clearInterval(this.interval);
    this.interval = 0;
    this.running = false;
  }

  render() {
    const m = Math.floor(Math.max(0, this.remaining) / 60);
    const s = Math.max(0, this.remaining) % 60;
    this.display.textContent = `${m}:${String(s).padStart(2, "0")}`;
  }
}

/* ---------- Wake Lock (Bildschirm anlassen) ---------- */

let wakeLock = null;
let wantWakeLock = false;

async function acquireWakeLock() {
  if (!wantWakeLock || !("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch { /* z. B. Energiesparmodus – nicht kritisch */ }
}

export function keepScreenAwake(on) {
  wantWakeLock = on;
  if (on) {
    acquireWakeLock();
  } else {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") acquireWakeLock();
});

/* ---------- Zurück-Taste abfangen ----------
   Während einer laufenden Runde fragt der Browser-Back nach Bestätigung. */

let backGuardActive = false;
let onBackConfirmed = null;

export function armBackGuard(onConfirm) {
  onBackConfirmed = onConfirm;
  if (!backGuardActive) {
    backGuardActive = true;
    history.pushState({ guard: true }, "");
  }
}

export function disarmBackGuard() {
  onBackConfirmed = null;
  backGuardActive = false;
}

window.addEventListener("popstate", () => {
  if (!backGuardActive) return;
  if (confirm("Laufende Runde abbrechen?")) {
    backGuardActive = false;
    const fn = onBackConfirmed;
    onBackConfirmed = null;
    fn?.();
  } else {
    history.pushState({ guard: true }, "");
  }
});

/* ---------- Einstellungs-Formular ----------
   schema: [{ key, label, desc?, type: 'toggle'|'select', options?: [[value, label]], visible?(settings) }]
   Rendert in container, schreibt Änderungen in settings und ruft onChange. */

export function renderSettingsForm(container, schema, settings, onChange) {
  const rerender = () => {
    container.replaceChildren();
    for (const item of schema) {
      if (item.visible && !item.visible(settings)) continue;

      const labelWrap = el("div", {},
        el("div", { class: "label" }, item.label),
        item.desc ? el("div", { class: "desc" }, item.desc) : null,
      );

      let control;
      if (item.type === "toggle") {
        control = el("button", {
          class: "switch",
          type: "button",
          role: "switch",
          "aria-checked": String(!!settings[item.key]),
          "aria-label": item.label,
          onclick: () => {
            settings[item.key] = !settings[item.key];
            onChange();
            rerender();
          },
        });
      } else {
        control = el("select", {
          class: "select",
          "aria-label": item.label,
          onchange: (ev) => {
            const raw = ev.target.value;
            const match = item.options.find(([value]) => String(value) === raw);
            settings[item.key] = match ? match[0] : raw;
            onChange();
            rerender();
          },
        }, item.options.map(([value, label]) =>
          el("option", { value: String(value), selected: String(settings[item.key]) === String(value) ? "" : null }, label)
        ));
        control.value = String(settings[item.key]);
      }

      container.append(el("div", { class: "setting" }, labelWrap, control));
    }
  };
  rerender();
  return rerender;
}
