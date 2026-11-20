import "../shared/style.css";
import { mountNav } from "../shared/nav";

const DAY = 20;
const IDLE_MS = 1200; // longest wait before the scene starts anyway
const STILL_WIDE = new URL("./still-wide.webp", import.meta.url).href;
const STILL_TALL = new URL("./still-tall.webp", import.meta.url).href;

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const lightEl = root.querySelector<HTMLElement>("[data-cv-light]");
  const params = new URLSearchParams(location.search);
  const still = () => {
    if (root.hasAttribute("data-cv-still")) return;
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
    // a capture of the live cocoon, wide or tall to match the screen
    const frame = root.querySelector<HTMLElement>(".still");
    if (!frame) return;
    const img = document.createElement("img");
    img.src = innerWidth > innerHeight ? STILL_WIDE : STILL_TALL;
    img.alt = "";
    img.decoding = "async";
    frame.append(img);
  };

  if (!canvas || !("WebGL2RenderingContext" in window) || params.has("still")) still();
  else {
    // after load and an idle moment; the scene itself starts the gpu off this thread
    afterLoad(() => import("./stage"))
      .then(({ Stage }) =>
        Stage.create(canvas, Number(params.get("at")) || 0, Number(params.get("bg")) || 0),
      )
      .then((stage) => {
        root.setAttribute("data-cv-live", "");
        stage.onShown = () => canvas.setAttribute("data-cv-shown", "");
        stage.onLight = (l) => {
          if (lightEl && lightEl.textContent !== l) lightEl.textContent = l;
        };
        // the light slider: native, so keys and screen readers work; it is outside the canvas,
        // so moving it never turns the cluster
        const slider = root.querySelector<HTMLInputElement>("[data-cv-angle]");
        const onAngle = () => slider && stage.angle(Number(slider.value) / 100);
        slider?.addEventListener("input", onAngle, { passive: true });
        onAngle();
        stage.onLost = () => {
          stage.dispose();
          still();
        };
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
