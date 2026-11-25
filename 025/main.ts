import "../shared/style.css";
import { mountNav } from "../shared/nav";
import { mount } from "./host";
import type { Hud } from "./veil";

const DAY = 25;
const IDLE_MS = 1200; // longest wait before the scene starts anyway

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const q = (s: string) => root.querySelector<HTMLElement>(`[data-cv-${s}]`);
  const out = { drift: q("drift"), span: q("span") };
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
    text(out.drift, `${h.drift.toFixed(1)} cm/s`);
    text(out.span, `${h.span.toFixed(2)} m`);
  };

  if (!canvas || !("WebGL2RenderingContext" in window) || params.has("still")) still();
  else {
    // after load and an idle moment; the cloth and the gpu start off this thread
    afterLoad().then(() => {
      const veil = mount(
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
        },
      );
      if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { veil });
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
