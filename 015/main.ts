import "../shared/style.css";
import { mountNav } from "../shared/nav";
import type { Hud } from "./haze";
import { mount } from "./host";

const DAY = 15;
const IDLE_MS = 1200; // longest wait before the scene starts anyway

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const q = (s: string) => root.querySelector<HTMLElement>(`[data-cv-${s}]`);
  const out = { eye: q("eye"), ground: q("ground"), mirage: q("mirage") };
  const params = new URLSearchParams(location.search);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const still = () => {
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
  };
  const text = (el: HTMLElement | null, s: string) => {
    if (el && el.textContent !== s) el.textContent = s;
  };
  const num = (k: string, fallback: number) => {
    const v = params.get(k);
    return v === null || Number.isNaN(Number(v)) ? fallback : Number(v);
  };

  // HUD
  const hud = (h: Hud) => {
    text(out.eye, `${h.eyeM.toFixed(1)} m`);
    text(out.ground, `${h.groundC} °C`);
    text(out.mirage, `${h.arcmin}′`);
  };

  if (!canvas || !("WebGL2RenderingContext" in window) || params.has("still")) still();
  else {
    // after load and an idle moment; the haze itself starts the gpu off this thread
    afterLoad().then(() => {
      const haze = mount(
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
          hold: params.has("hold"),
          at: num("at", 0),
          eye: num("eye", -1),
          heat: num("heat", 0),
          heatAt: num("hx", 0.5),
        },
      );
      if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { haze });
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
