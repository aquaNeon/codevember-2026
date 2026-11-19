import "../shared/style.css";
import { mountNav } from "../shared/nav";

const DAY = 7;
const IDLE_MS = 1200;
const GPU_WARM_MS = 1500; // earliest start after navigation

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const params = new URLSearchParams(location.search);
  if (params.get("v") === "b") document.documentElement.setAttribute("data-cv-paper", "");
  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const depth = root.querySelector<HTMLElement>("[data-cv-depth]");
  const layer = root.querySelector<HTMLElement>("[data-cv-layer]");
  const still = () => root.setAttribute("data-cv-still", "");

  if (!canvas || params.has("still")) still();
  else {
    afterLoad(() => import("./hollow"))
      .then(({ Hollow, layerAt }) => {
        const hollow = new Hollow(canvas);
        // ?z=70 starts that deep, to look at one layer
        const start = Number(params.get("z"));
        if (start > 0) hollow.jump(start);
        if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { hollow });
        root.setAttribute("data-cv-live", "");
        let shown = -1;
        hollow.onDepth = (z) => {
          const dm = Math.round(z * 10);
          if (dm === shown) return;
          shown = dm;
          if (depth) depth.textContent = `${(dm / 10).toFixed(1)} m`;
          const name = layerAt(z);
          if (layer && layer.textContent !== name) layer.textContent = name;
        };
        canvas.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          hollow.dispose();
          still();
        });
      })
      .catch(still);
  }
}

function afterLoad<T>(fn: () => Promise<T>) {
  return new Promise<void>((done) => {
    // and give a cold gpu process time to start before the first webgl call
    const ready = () => setTimeout(done, Math.max(0, GPU_WARM_MS - performance.now()));
    const idle = () =>
      "requestIdleCallback" in window
        ? requestIdleCallback(ready, { timeout: IDLE_MS })
        : setTimeout(ready, 200);
    if (document.readyState === "complete") idle();
    else addEventListener("load", idle, { once: true });
  }).then(fn);
}
