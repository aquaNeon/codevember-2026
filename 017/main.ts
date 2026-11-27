import "../shared/style.css";
import { mountNav } from "../shared/nav";
import { mount } from "./host";

const DAY = 17;
const IDLE_MS = 1200;
const STILL_WIDE = "../stills/017-wide.jpg";
const STILL_TALL = "../stills/017-tall.jpg";

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const current = root.querySelector<HTMLElement>("[data-cv-current]");
  const still = () => {
    if (root.hasAttribute("data-cv-still")) return;
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
    const frame = root.querySelector<HTMLElement>(".still");
    if (!frame) return;
    const img = document.createElement("img");
    img.src = innerWidth > innerHeight ? STILL_WIDE : STILL_TALL;
    img.alt = "";
    img.decoding = "async";
    frame.append(img);
  };

  if (
    !canvas ||
    !("WebGL2RenderingContext" in window) ||
    new URLSearchParams(location.search).has("still")
  )
    still();
  else {
    // LIVE
    // after load and idle, so the scene never competes with first paint
    afterLoad().then(() => {
      const kelp = mount(canvas, {
        state: (v) => {
          if (current) current.textContent = `${v.toFixed(2)} m/s`;
          root.setAttribute("data-cv-live", "");
        },
        fail: still,
      });
      if (import.meta.env.DEV && location.search.includes("debug")) Object.assign(window, { kelp });
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
