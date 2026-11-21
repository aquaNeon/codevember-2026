import "../shared/style.css";
import { mountNav } from "../shared/nav";

const DAY = 1;
const IDLE_MS = 1200; // longest wait before the scene starts anyway
const HINT = {
  fold: "Lift an edge, fold it over",
  rest: "Four folds. Let it rest",
  covered: "Resting. New dough for another round",
} as const;

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const folds = root.querySelector<HTMLElement>("[data-cv-folds]");
  const hint = root.querySelector<HTMLElement>("[data-cv-hint]");
  const reset = root.querySelector<HTMLButtonElement>("[data-cv-reset]");
  const still = () => root.setAttribute("data-cv-still", "");

  if (!canvas || new URLSearchParams(location.search).has("still")) still();
  else {
    // three is the heavy part; wait for load and an idle moment, and wake the gpu from a worker
    // so the first webgl context on the page does not block on a cold gpu process
    afterLoad(() => Promise.all([import("./dough"), warmGpu()]).then(([m]) => m))
      .then(({ Dough }) => {
        const dough = new Dough(canvas);
        if (import.meta.env.DEV && location.search.includes("debug"))
          Object.assign(window, { dough });
        root.setAttribute("data-cv-live", "");
        dough.onState = (n, phase) => {
          if (folds) folds.textContent = `${n} / 4`;
          if (hint) hint.textContent = HINT[phase];
        };
        reset?.addEventListener("click", () => dough.reset());
        canvas.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          dough.dispose();
          still();
        });
      })
      .catch(still);
  }
}

function afterLoad<T>(fn: () => Promise<T>) {
  return new Promise<void>((done) => {
    const idle = () =>
      "requestIdleCallback" in window
        ? requestIdleCallback(() => done(), { timeout: IDLE_MS })
        : setTimeout(done, 200);
    if (document.readyState === "complete") idle();
    else addEventListener("load", idle, { once: true });
  }).then(fn);
}

// WARM UP
// a throwaway context in a worker pays the gpu start-up off the main thread
const WARM_MS = 2500; // give up waiting after this
const WARM_SRC = `try{new OffscreenCanvas(1,1).getContext("webgl2")}catch(e){}postMessage(0)`;

function warmGpu() {
  return new Promise<void>((done) => {
    if (typeof OffscreenCanvas === "undefined" || typeof Worker === "undefined") return done();
    const url = URL.createObjectURL(new Blob([WARM_SRC], { type: "text/javascript" }));
    const w = new Worker(url);
    const end = () => {
      clearTimeout(t);
      w.terminate();
      URL.revokeObjectURL(url);
      done();
    };
    const t = setTimeout(end, WARM_MS);
    w.onmessage = end;
    w.onerror = end;
  });
}
