import "../shared/style.css";
import { mountNav } from "../shared/nav";

const DAY = 2;
const IDLE_MS = 1200; // longest wait before the scene starts anyway
const STILL_WIDE = "../stills/002-wide.webp";
const STILL_TALL = "../stills/002-tall.webp";
const HINT = {
  whole: "Snap the tail",
  breaking: "Scroll to move through time",
  held: "Scroll back, or tap, to reform",
  mending: "Reforming",
};

// real time since the snap, in the unit that suits it
function stamp(t: number) {
  if (t < 1e-3) return `${(t * 1e6).toFixed(1)} µs`;
  if (t < 1) return `${(t * 1e3).toFixed(1)} ms`;
  return `${t.toFixed(2)} s`;
}

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const time = root.querySelector<HTMLElement>("[data-cv-time]");
  const count = root.querySelector<HTMLElement>("[data-cv-count]");
  const hint = root.querySelector<HTMLElement>("[data-cv-hint]");
  const scrub = root.querySelector<HTMLInputElement>("[data-cv-scrub]");
  const polar = root.querySelector<HTMLButtonElement>("[data-cv-pol]");
  const params = new URLSearchParams(location.search);
  const still = () => {
    if (root.hasAttribute("data-cv-still")) return;
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
    // a capture of the live room, wide or tall to match the screen
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
    const at = params.has("t") ? Math.max(0, Number(params.get("t")) || 0) : -1;
    // after load and an idle moment; the scene itself starts the gpu off this thread
    afterLoad(() => import("./stage"))
      .then(({ Stage }) => Stage.create(canvas, at))
      .then((stage) => {
        root.setAttribute("data-cv-live", "");
        stage.onShown = () => canvas.setAttribute("data-cv-shown", "");
        stage.onLost = () => {
          stage.dispose();
          still();
        };
        // TIMELINE
        // while the thumb is held the scene follows it, not the other way round
        let seeking = false;
        stage.onState = (m) => {
          if (time) time.textContent = stamp(m.real);
          if (count) count.textContent = String(m.pieces);
          if (hint && hint.textContent !== HINT[m.phase]) hint.textContent = HINT[m.phase];
          if (scrub && !seeking) {
            scrub.max = m.dur.toFixed(2);
            scrub.value = String(m.time);
          }
        };
        polar?.addEventListener("click", () => {
          const on = polar.getAttribute("aria-pressed") !== "true";
          polar.setAttribute("aria-pressed", String(on));
          root.toggleAttribute("data-cv-polarised", on);
          stage.post({ t: "pol", v: on });
        });
        if (scrub) {
          const opts = { passive: true };
          scrub.addEventListener("pointerdown", () => (seeking = true), opts);
          scrub.addEventListener("pointerup", () => (seeking = false), opts);
          scrub.addEventListener("pointercancel", () => (seeking = false), opts);
          scrub.addEventListener("input", () => stage.post({ t: "seek", s: Number(scrub.value) }));
        }
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
