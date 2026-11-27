import "../shared/style.css";
import { mountNav } from "../shared/nav";
import { mount } from "./host";

const DAY = 5;
const IDLE_MS = 1200; // change max idle wait here
const MAX_COLONIES = 32;
// START
// x, y from top left, species
const START = [
  [0.62, 0.38, 0],
  [0.4, 0.56, 1],
  [0.78, 0.64, 2],
  [0.5, 0.2, 3],
] as const;
const START_GAP_MS = 700;

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const count = root.querySelector<HTMLElement>("[data-cv-count]");
  const status = root.querySelector<HTMLElement>("[data-cv-status]");
  const wipe = root.querySelector<HTMLButtonElement>("[data-cv-wipe]");
  const params = new URLSearchParams(location.search);
  const variant = params.get("v") === "b" ? "b" : "a";
  const timers: number[] = [];
  const still = () => {
    timers.forEach(clearTimeout);
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
  };
  if (variant === "b") {
    document.documentElement.setAttribute("data-cv-slate", "");
    const fig = root.querySelector<HTMLElement>("[data-cv-stone]");
    if (fig) fig.textContent = "Lichen on slate";
  }

  if (!canvas || !("WebGL2RenderingContext" in window) || params.has("still")) still();
  else {
    afterLoad().then(() => {
      const avoid = [".cv-title", ".cv-hud"]
        .map((q) => root.querySelector<HTMLElement>(q))
        .filter((el): el is HTMLElement => !!el);
      let started = false;
      const stone = mount(
        canvas,
        avoid,
        {
          state: (n, growing) => {
            if (count) count.textContent = `${n} / ${MAX_COLONIES}`;
            if (status) status.textContent = growing ? "Growing" : "Settled";
            root.setAttribute("data-cv-live", "");
          },
          shown: () => {
            canvas.setAttribute("data-cv-shown", "");
            if (started) return;
            started = true;
            START.forEach(([x, y, s], i) =>
              timers.push(window.setTimeout(() => stone.plant(x, y, s), i * START_GAP_MS)),
            );
          },
          fail: still,
        },
        {
          reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
          forceGl: params.has("gl"),
          variant,
        },
      );
      if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { stone });
      wipe?.addEventListener("click", () => {
        timers.forEach(clearTimeout);
        timers.length = 0;
        stone.wipe();
      });
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
