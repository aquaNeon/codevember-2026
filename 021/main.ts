import "../shared/style.css";
import { mountNav } from "../shared/nav";
import type { Hud } from "./garden";
import { mount } from "./host";

const DAY = 21;
const IDLE_MS = 1200;

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const q = (s: string) => root.querySelector<HTMLElement>(`[data-cv-${s}]`);
  const out = {
    day: q("day"),
    temp: q("temp"),
    hours: q("hours"),
    height: q("height"),
    stage: q("stage"),
    hint: q("hint"),
  };
  const params = new URLSearchParams(location.search);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarse = matchMedia("(pointer: coarse)").matches;
  const hint = coarse ? "Swipe to hurry the summer" : "Scroll to hurry the summer";
  const ripe = coarse ? "Tap to shake the seeds loose" : "Click to shake the seeds loose";
  const still = () => {
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
  };
  const text = (el: HTMLElement | null, s: string) => {
    if (el && el.textContent !== s) el.textContent = s;
  };

  // HUD
  const hud = (h: Hud) => {
    text(out.day, `Day ${h.day}`);
    text(out.temp, `${h.temp} °C`);
    text(out.hours, `${h.hours.toFixed(1)} h`);
    text(out.height, `${h.cm} cm`);
    text(out.stage, h.stage);
    text(out.hint, h.resting ? "Scroll to go on" : h.ripe ? ripe : hint);
  };

  if (!canvas || !("WebGL2RenderingContext" in window) || params.has("still")) still();
  else {
    afterLoad().then(() => {
      const garden = mount(
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
          hold: params.has("hold"),
          at: params.get("at") ?? "",
          seed: Number(params.get("seed")) || 0,
        },
      );
      if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { garden });
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
