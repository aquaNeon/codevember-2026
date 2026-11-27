import { DAYS, READY, pad } from "./days";

const ODO_COL_MS = 70;
const ODO_HEAD_MS = 250;
const ODO_TAG_MS = 450;
const DAY_PATH_RE = /\/(\d{3})\/?$/;

export function mountNav(day: number) {
  turnDay(day);
  const nav = document.querySelector<HTMLElement>("[data-cv-nav]");
  if (!nav) return;
  const link = (n: number, text: string, rel: string) => {
    const ready = READY.has(n);
    const el = document.createElement(ready ? "a" : "span");
    el.textContent = text;
    if (el instanceof HTMLAnchorElement) {
      el.href = `../${pad(n)}/`;
      el.rel = rel;
      el.setAttribute("aria-label", `${rel === "prev" ? "Previous" : "Next"}: ${DAYS[n - 1]}`);
    } else el.setAttribute("aria-disabled", "true");
    return el;
  };
  nav.replaceChildren(link(day - 1, "← Prev", "prev"), link(day + 1, "Next →", "next"));
}

// TURNING NUMBER
// odometer on changed digits when the same-origin referrer is another day
function turnDay(day: number) {
  let from: number;
  try {
    const ref = new URL(document.referrer);
    const m = ref.origin === location.origin ? DAY_PATH_RE.exec(ref.pathname) : null;
    from = m ? Number(m[1]) : 0;
  } catch {
    return;
  }
  if (!from || from === day) return;
  const top = document.querySelector<HTMLElement>(".cv-top > span");
  const tag = document.querySelector<HTMLElement>(".cv-title > .mono");
  if (top) turn(top, day, from, ODO_HEAD_MS);
  if (tag) turn(tag, day, from, ODO_TAG_MS);
}

function turn(el: HTMLElement, day: number, from: number, delayMs: number) {
  if (el.hasAttribute("data-cv-odo")) return;

  const text = el.textContent ?? "";
  const hit = /\d+/.exec(text);
  if (!hit || Number(hit[0]) !== day) return;
  const at = hit.index;
  const now = hit[0];
  const was = String(from).padStart(now.length, "0");
  const up = day > from;
  el.setAttribute("data-cv-odo", "");

  const sr = document.createElement("span");
  sr.className = "cv-sr";
  sr.textContent = text;
  const shown = document.createElement("span");
  shown.setAttribute("aria-hidden", "true");
  shown.append(text.slice(0, at));
  let col = 0;
  for (let i = 0; i < now.length; i++) {
    if (now[i] === was[i]) {
      shown.append(now[i]);
      continue;
    }
    const wrap = document.createElement("span");
    wrap.className = "cv-odo";
    const strip = document.createElement("span");
    strip.className = up ? "cv-odo-strip" : "cv-odo-strip cv-odo-down";
    for (const d of up ? [was[i], now[i]] : [now[i], was[i]]) {
      const s = document.createElement("span");
      s.textContent = d;
      strip.append(s);
    }
    strip.style.setProperty("--cv-odo-delay", `${delayMs + col++ * ODO_COL_MS}ms`);
    wrap.append(strip);
    shown.append(wrap);
  }
  shown.append(text.slice(at + now.length));
  el.replaceChildren(sr, shown);
}
