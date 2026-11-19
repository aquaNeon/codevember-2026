import "../shared/style.css";
import { mountNav } from "../shared/nav";
import { mount } from "./host";

const DAY = 16;
const IDLE_MS = 1200; // longest wait before the scene starts anyway

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const puffs = root.querySelector<HTMLElement>("[data-cv-puffs]");
  const button = root.querySelector<HTMLButtonElement>("[data-cv-poke]");
  const params = new URLSearchParams(location.search);
  const still = () => {
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
  };
  const look = params.get("v") === "b" ? "gouache" : "plate";
  if (look === "plate") document.documentElement.setAttribute("data-cv-plate", "");
  const labels = Array.from(root.querySelectorAll<HTMLElement>("[data-cv-label]"));

  if (!canvas || params.has("still")) still();
  else {
    // wait for load and an idle moment so the scene never competes with first paint
    afterLoad().then(() => {
      const spore = mount(
        canvas,
        look,
        {
          puff: (n) => {
            if (puffs) puffs.textContent = String(n);
          },
          // each plate figure gets its number under its foot
          labels: (xy) => {
            for (let i = 0; i < labels.length && i * 2 < xy.length; i++)
              labels[i].style.transform =
                `translate(${xy[i * 2].toFixed(1)}px, ${xy[i * 2 + 1].toFixed(1)}px) translate(-50%, 0)`;
          },
          fail: still,
        },
        look === "plate" ? root.querySelector<HTMLElement>("[data-cv-panel]") : null,
      );
      if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { spore });
      root.setAttribute("data-cv-live", "");
      button?.addEventListener("click", () => spore.poke());
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
