import "../shared/style.css";
import { mountNav } from "../shared/nav";
import { mount } from "./host";

const DAY = 11;
const IDLE_MS = 1200; // longest wait before the scene starts anyway
const YEARS = 40;
const AUTOPLAY_MS = 900; // after the fade in
const REDUCED_AGE = 0.45; // reduced motion opens part way, without playing
const KNOBS = ["humidity", "salt", "scale", "flake"] as const; // scale has no knob, it stays at 50

// what the steel looks like at an age, for the readout
const SURFACE: [number, string][] = [
  [0.04, "Bright"],
  [0.14, "Tarnished"],
  [0.32, "Flash rust"],
  [0.6, "Spreading"],
  [0.82, "Scale"],
  [2, "Crust"],
];

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const scrub = root.querySelector<HTMLInputElement>("[data-cv-scrub]");
  const playBtn = root.querySelector<HTMLButtonElement>("[data-cv-play]");
  const ageOut = root.querySelector<HTMLElement>("[data-cv-age]");
  const surfaceOut = root.querySelector<HTMLElement>("[data-cv-surface]");
  const toggle = root.querySelector<HTMLButtonElement>("[data-cv-toggle]");
  const knobs = KNOBS.map((k) => root.querySelector<HTMLInputElement>(`[data-cv-knob="${k}"]`));
  const outs = KNOBS.map((k) => root.querySelector<HTMLOutputElement>(`[data-cv-out="${k}"]`));
  const tones = Array.from(root.querySelectorAll<HTMLInputElement>("[data-cv-tone]"));
  const params = new URLSearchParams(location.search);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const still = () => {
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
  };

  let playing = false;
  let seeking = false;

  const readout = (age: number) => {
    const yrs = Math.round(age * YEARS);
    if (ageOut) ageOut.textContent = `${yrs} yrs`;
    if (surfaceOut) surfaceOut.textContent = SURFACE.find(([t]) => age < t)?.[1] ?? "";
    if (scrub) scrub.setAttribute("aria-valuetext", `${yrs} years`);
  };
  const setPlaying = (on: boolean) => {
    playing = on;
    if (!playBtn) return;
    playBtn.textContent = on ? "Pause" : "Play";
    playBtn.setAttribute("aria-pressed", String(on));
  };

  // PANEL
  // always open on desktop, a toggle on phones
  toggle?.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
  });

  if (!canvas || !("WebGL2RenderingContext" in window) || params.has("still")) still();
  else {
    const age0 = params.has("age") ? Number(params.get("age")) : reduced ? REDUCED_AGE : 0;
    if (scrub) scrub.value = String(age0 * YEARS);
    readout(age0);
    // wait for load and an idle moment; the scene itself runs off the main thread
    afterLoad().then(() => {
      const block = mount(
        canvas,
        {
          age: (age, on) => {
            if (!seeking && scrub) scrub.value = String(age * YEARS);
            readout(age);
            setPlaying(on);
          },
          // the first frame is up: fade it in over the still, then let the years run
          shown: () => {
            canvas.setAttribute("data-cv-shown", "");
            root.setAttribute("data-cv-live", "");
            if (!reduced && !params.has("age"))
              setTimeout(() => {
                if (!seeking && Number(scrub?.value ?? 0) === 0) block.play(true);
              }, AUTOPLAY_MS);
          },
          fail: still,
        },
        {
          reducedMotion: reduced,
          forceGl: params.has("gl"),
          age: age0,
        },
      );
      if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { block });

      const tune = () => {
        const v = knobs.map((k) => Number(k?.value ?? 50) / 100);
        knobs.forEach((k, i) => {
          const o = outs[i];
          if (k && o) o.textContent = k.value;
        });
        const tone = tones.find((t) => t.checked)?.value === "1" ? 1 : 0;
        block.tune(v[0], v[1], v[2], v[3], tone);
      };
      for (const k of knobs) k?.addEventListener("input", tune);
      for (const t of tones) t.addEventListener("change", tune);
      tune();

      if (scrub) {
        const opts = { passive: true };
        scrub.addEventListener("pointerdown", () => (seeking = true), opts);
        scrub.addEventListener("pointerup", () => (seeking = false), opts);
        scrub.addEventListener("pointercancel", () => (seeking = false), opts);
        scrub.addEventListener("input", () => {
          const age = Number(scrub.value) / YEARS;
          block.setAge(age);
          readout(age);
          setPlaying(false);
        });
      }
      const flip = () => {
        setPlaying(!playing);
        block.play(playing);
      };
      playBtn?.addEventListener("click", flip);
      canvas.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        flip();
      });
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
