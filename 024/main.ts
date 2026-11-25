import "../shared/style.css";
import { mountNav } from "../shared/nav";
import { mount } from "./host";
import type { Hud } from "./nest";

const DAY = 24;
const IDLE_MS = 1200; // longest wait before the scene starts anyway

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const q = (s: string) => root.querySelector<HTMLElement>(`[data-cv-${s}]`);
  const out = { blades: q("blades"), grass: q("grass"), stage: q("stage"), hint: q("hint") };
  const params = new URLSearchParams(location.search);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarse = matchMedia("(pointer: coarse)").matches;
  const hint = coarse ? "Swipe to weave and turn" : "Scroll to weave, drag to turn";
  const still = () => {
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
  };
  const text = (el: HTMLElement | null, s: string) => {
    if (el && el.textContent !== s) el.textContent = s;
  };

  // HUD
  const hud = (h: Hud) => {
    text(out.blades, String(h.blades));
    text(out.grass, `${h.metres.toFixed(1)} m`);
    text(out.stage, h.stage);
    text(out.hint, h.resting ? "Scroll to go on" : hint);
  };

  if (!canvas || !("WebGL2RenderingContext" in window) || params.has("still")) still();
  else {
    // after load and an idle moment; the nest itself starts the gpu off this thread
    afterLoad().then(() => {
      const at = params.get("at");
      const nest = mount(
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
          at: at === null ? -1 : Number(at) || 0,
        },
      );
      if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { nest });
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
