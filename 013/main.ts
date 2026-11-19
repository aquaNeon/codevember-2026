import "../shared/style.css";
import { mountNav } from "../shared/nav";
import type { Phase } from "./garden";
import { mount } from "./host";

const DAY = 13;
const IDLE_MS = 1200; // longest wait before the scene starts anyway
const HINT: Record<Phase, string> = {
  rest: "Press on the path, draw the rake along it",
  raking: "Follow the path",
  walking: "Walking the path",
  centre: "The centre. Pause, then rake your way out",
  back: "Back at the gate",
};
const HINT_OUT = "Retrace the path to the gate";
const CIRCUIT = [
  "Gate",
  "1 of 7",
  "2 of 7",
  "3 of 7",
  "4 of 7",
  "5 of 7",
  "6 of 7",
  "7 of 7",
  "Centre",
];

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const circuit = root.querySelector<HTMLElement>("[data-cv-circuit]");
  const raked = root.querySelector<HTMLElement>("[data-cv-raked]");
  const way = root.querySelector<HTMLElement>("[data-cv-way]");
  const hint = root.querySelector<HTMLElement>("[data-cv-hint]");
  const walk = root.querySelector<HTMLButtonElement>("[data-cv-walk]");
  const still = () => {
    if (root.hasAttribute("data-cv-still")) return;
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
    const frame = root.querySelector<HTMLElement>(".still");
    if (frame) import("./still").then(({ still: draw }) => frame.append(draw()));
  };

  if (
    !canvas ||
    !("WebGL2RenderingContext" in window) ||
    new URLSearchParams(location.search).has("still")
  )
    still();
  else {
    // wait for load and an idle moment so the scene never competes with first paint
    afterLoad().then(() => {
      const garden = mount(canvas, {
        state: (c, m, phase, out) => {
          if (circuit) circuit.textContent = CIRCUIT[c];
          if (way) way.textContent = out ? "Out" : "In";
          if (raked) raked.textContent = `${m.toFixed(1)} m`;
          if (hint) hint.textContent = out && phase === "rest" ? HINT_OUT : HINT[phase];
          if (walk) walk.textContent = phase === "walking" ? "Stop" : "Walk it";
          root.setAttribute("data-cv-live", "");
        },
        fail: still,
      });
      if (import.meta.env.DEV && location.search.includes("debug"))
        Object.assign(window, { garden });
      walk?.addEventListener("click", () => garden.walk());
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
