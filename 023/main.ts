import "../shared/style.css";
import { mountNav } from "../shared/nav";
import type { Hud } from "./magma";
import { mount } from "./host";

const DAY = 23;
const IDLE_MS = 1200;

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const q = (s: string) => root.querySelector<HTMLElement>(`[data-cv-${s}]`);
  const out = { temp: q("temp"), seams: q("seams"), bursts: q("bursts") };
  const text = (el: HTMLElement | null, s: string) => {
    if (el && el.textContent !== s) el.textContent = s;
  };
  const params = new URLSearchParams(location.search);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // TOUCH
  // no hover, so a held finger warms instead
  if (matchMedia("(pointer: coarse)").matches) text(q("hint"), "Hold to warm the crust");
  const still = () => {
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
  };

  // HUD
  const hud = (h: Hud) => {
    text(out.temp, `${h.temp.toLocaleString("en-US")} °C`);
    text(out.seams, `${h.seams} %`);
    text(out.bursts, String(h.bursts));
  };

  if (!canvas || !("WebGL2RenderingContext" in window) || params.has("still")) still();
  else {
    // LIVE
    // after load and idle; the worker starts the gpu off this thread
    afterLoad().then(() => {
      const magma = mount(
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
          at: Number(params.get("at")) || 0,
        },
      );
      if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { magma });
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
