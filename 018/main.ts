import "../shared/style.css";
import { mountNav } from "../shared/nav";

const DAY = 18;
const IDLE_MS = 1200;

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const spin = root.querySelector<HTMLButtonElement>("[data-cv-spin]");
  const params = new URLSearchParams(location.search);
  const still = () => root.setAttribute("data-cv-still", "");

  if (!canvas || params.has("still")) still();
  else {
    // BOOT
    // after load and idle; the scene starts the gpu off this thread
    afterLoad(() => import("./stage"))
      .then(({ Stage }) => Stage.create(canvas))
      .then((stage) => {
        if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { stage });
        root.setAttribute("data-cv-live", "");
        stage.onShown = () => canvas.setAttribute("data-cv-shown", "");
        spin?.addEventListener("click", () => stage.spin());
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
