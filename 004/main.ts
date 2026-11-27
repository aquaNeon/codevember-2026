import "../shared/style.css";
import { mountNav } from "../shared/nav";
import { Threads } from "./threads";

const DAY = 4;

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const count = root.querySelector<HTMLElement>("[data-cv-crossings]");
  const hint = root.querySelector<HTMLElement>("[data-cv-hint]");
  const stir = root.querySelector<HTMLButtonElement>("[data-cv-stir]");
  const comb = root.querySelector<HTMLButtonElement>("[data-cv-comb]");

  if (canvas) {
    try {
      const threads = new Threads(canvas);
      if (import.meta.env.DEV && location.search.includes("debug"))
        Object.assign(window, { threads });
      root.setAttribute("data-cv-live", "");
      threads.onState = (n) => {
        if (count) count.textContent = String(n);
        if (hint)
          hint.textContent =
            n === 0
              ? "Stir to tangle"
              : n > 24
                ? "Comb it out, slow and straight"
                : "Stir more, or comb it out";
      };
      stir?.addEventListener("click", () => threads.stir());
      comb?.addEventListener("click", () => threads.comb());
    } catch {
      root.setAttribute("data-cv-still", "");
    }
  }
}
