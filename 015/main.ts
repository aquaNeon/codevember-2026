import "../shared/style.css";
import { mountNav } from "../shared/nav";
import { mount } from "./host";
import { placePlate } from "./plate";

const DAY = 15;
const IDLE_MS = 1200; // change to start the scene sooner

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const driven = root.querySelector<HTMLElement>("[data-cv-driven]");
  const ahead = root.querySelector<HTMLElement>("[data-cv-ahead]");
  const params = new URLSearchParams(location.search);
  const still = () => {
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
  };

  const avoid = [...root.querySelectorAll<HTMLElement>(".cv-title > *, .cv-hud dl")];

  // STILL
  const plate = root.querySelector<HTMLElement>("[data-cv-plate]");
  const paint = () => {
    if (plate) placePlate(plate, avoid);
  };
  paint();
  addEventListener("resize", paint, { passive: true });
  document.fonts?.ready.then(paint);

  if (!canvas || !("WebGL2RenderingContext" in window) || params.has("still")) still();
  else {
    afterLoad()
      .then(() => {
        const mirage = mount(canvas, {
          avoid,
          state: (d, a) => {
            if (driven) driven.textContent = `${d} m`;
            if (ahead) ahead.textContent = `${a} m ahead`;
          },
          ready: () => root.setAttribute("data-cv-live", ""),
          fail: still,
        });
        if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { mirage });
      })
      .catch(still);
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
