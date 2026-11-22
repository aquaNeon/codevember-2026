import "../shared/style.css";
import { mountNav } from "../shared/nav";
import type { Hud } from "./cave";
import { mount } from "./host";

const DAY = 22;
const IDLE_MS = 1200; // longest wait before the scene starts anyway

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const q = (s: string) => root.querySelector<HTMLElement>(`[data-cv-${s}]`);
  const out = { pings: q("pings"), echo: q("echo"), delay: q("delay"), speed: q("speed") };
  const params = new URLSearchParams(location.search);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fly = q("fly");
  if (matchMedia("(pointer: coarse)").matches) {
    if (fly) fly.textContent = "Swipe to fly";
    const verb = q("verb");
    if (verb) verb.textContent = "Swipe";
  }
  const still = () => {
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
  };
  const text = (el: HTMLElement | null, s: string) => {
    if (el && el.textContent !== s) el.textContent = s;
  };

  // HUD
  const hud = (h: Hud) => {
    text(out.pings, String(h.pings));
    text(out.speed, `${h.speed.toFixed(1)} m/s`);
    if (h.idle !== root.hasAttribute("data-cv-idle")) root.toggleAttribute("data-cv-idle", h.idle);
    if (h.echo > 0) {
      text(out.echo, `${h.echo.toFixed(2)} m`);
      text(out.delay, `${h.delay.toFixed(1)} ms`);
    }
  };

  if (!canvas || !("WebGL2RenderingContext" in window) || params.has("still")) still();
  else {
    // after load and an idle moment; the cave itself starts the gpu off this thread
    afterLoad().then(() => {
      const cave = mount(
        canvas,
        {
          hud,
          shown: () => {
            canvas.setAttribute("data-cv-shown", "");
            root.setAttribute("data-cv-live", "");
          },
          fail: still,
        },
        { reducedMotion: reduced, at: import.meta.env.DEV ? Number(params.get("at") ?? NaN) : NaN },
      );
      if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { cave });
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
