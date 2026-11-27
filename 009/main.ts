import "../shared/style.css";
import { mountNav } from "../shared/nav";
import { mount } from "./host";

const DAY = 9;
const IDLE_MS = 1200;

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const pokes = root.querySelector<HTMLElement>("[data-cv-pokes]");
  const button = root.querySelector<HTMLButtonElement>("[data-cv-poke]");
  const params = new URLSearchParams(location.search);
  const still = () => {
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
  };
  const look = params.get("v") === "b" ? "paper" : "dark";
  if (look === "paper") document.documentElement.setAttribute("data-cv-paper", "");

  if (!canvas || params.has("still")) still();
  else {
    afterLoad().then(() => {
      const sac = mount(canvas, look, {
        poke: (n) => {
          if (pokes) pokes.textContent = String(n);
        },
        fail: still,
      });
      if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { sac });
      root.setAttribute("data-cv-live", "");
      button?.addEventListener("click", () => sac.poke());
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
