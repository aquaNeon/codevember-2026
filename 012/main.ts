import "../shared/style.css";
import { mountNav } from "../shared/nav";

const DAY = 12;
const IDLE_MS = 1200;
const GPU_WARM_MS = 1500;
const CM_PER_UNIT = 11;
const WINDS = ["calm", "breath", "breeze", "gust"];

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const params = new URLSearchParams(location.search);
  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const fallen = root.querySelector<HTMLElement>("[data-cv-fallen]");
  const wind = root.querySelector<HTMLElement>("[data-cv-wind]");
  // STILL
  const still = () => {
    if (root.hasAttribute("data-cv-still")) return;
    root.setAttribute("data-cv-still", "");
    import("./plume").then(({ drawPlume, LOOKS }) => {
      const frame = root.querySelector<HTMLElement>(".still");
      frame?.append(drawPlume(LOOKS[params.get("v") === "b" ? "b" : "a"]));
    });
  };

  if (!canvas || params.has("still")) still();
  else {
    const look = params.get("v") === "b" ? "b" : "a";
    afterLoad(() => Promise.all([import("./feather"), import("./plume")]))
      .then(async ([{ Feather }, { drawPlumeSoon, LOOKS }]) => {
        const plume = await drawPlumeSoon(LOOKS[look], true);
        const feather = new Feather(canvas, plume, LOOKS[look]);
        await feather.start();
        if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { feather });
        root.setAttribute("data-cv-live", "");
        let cm = -1;
        let w = -1;
        feather.onState = (f, speed) => {
          const c = Math.round(f * CM_PER_UNIT);
          if (c !== cm && fallen) fallen.textContent = `${(cm = c)} cm`;
          const k = speed < 0.08 ? 0 : speed < 0.4 ? 1 : speed < 1.1 ? 2 : 3;
          if (k !== w && wind) wind.textContent = WINDS[(w = k)];
        };
        canvas.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          feather.dispose();
          still();
        });
      })
      .catch(still);
  }
}

function afterLoad<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<void>((done) => {
    // GPU WARM-UP
    // let a cold gpu process start before the first webgl call
    const ready = () => setTimeout(done, Math.max(0, GPU_WARM_MS - performance.now()));
    const idle = () =>
      "requestIdleCallback" in window
        ? requestIdleCallback(ready, { timeout: IDLE_MS })
        : setTimeout(ready, 200);
    if (document.readyState === "complete") idle();
    else addEventListener("load", idle, { once: true });
  }).then(fn);
}
