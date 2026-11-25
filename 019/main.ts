import "../shared/style.css";
import { mountNav } from "../shared/nav";
import { mount } from "./host";
import type { Hud } from "./sky";

const DAY = 19;
const IDLE_MS = 1200; // longest wait before the scene starts anyway

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const q = (s: string) => root.querySelector<HTMLElement>(`[data-cv-${s}]`);
  const out = {
    entry: q("entry"),
    alt: q("alt"),
    speed: q("speed"),
    mass: q("mass"),
    phase: q("phase"),
    shot: q("shot"),
    bar: q("bar"),
  };
  const params = new URLSearchParams(location.search);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const still = () => {
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
  };
  const text = (el: HTMLElement | null, s: string) => {
    if (el && el.textContent !== s) el.textContent = s;
  };

  // HUD
  const hud = (h: Hud) => {
    text(out.entry, `${Math.round(h.entry)}°`);
    text(out.alt, h.alt > 0 ? `${h.alt.toFixed(0)} km` : "–");
    text(out.speed, h.speed > 0 ? `${h.speed.toFixed(1)} km/s` : "–");
    const t = h.mass / 1000;
    text(out.mass, `1.8 t → ${t >= 0.1 ? `${t.toFixed(2)} t` : `${Math.round(h.mass)} kg`}`);
    text(out.phase, h.phase);
    out.bar?.style.setProperty("--cv-m", h.left.toFixed(3));
    text(out.shot, h.shot);
  };

  if (!canvas || !("WebGL2RenderingContext" in window) || params.has("still")) still();
  else {
    // after load and an idle moment; the sky itself starts the gpu off this thread
    afterLoad().then(() => {
      const sky = mount(
        canvas,
        {
          hud,
          shown: () => {
            canvas.setAttribute("data-cv-shown", "");
            root.setAttribute("data-cv-live", "");
          },
          fail: still,
        },
        {
          reducedMotion: reduced,
          forceGl: params.has("gl"),
          hold: import.meta.env.DEV && params.has("hold"),
          // smooth tone instead of the screens, for the stills, which must stay small
        },
      );
      if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { sky });
    });
  }
}

function afterLoad() {
  return new Promise<void>((done) => {
    const idle = () =>
      "requestIdleCallback" in window
        ? requestIdleCallback(() => done(), { timeout: IDLE_MS })
        : setTimeout(done, 200);
    if (document.readyState === "complete") idle();
    else addEventListener("load", idle, { once: true });
  });
}
