import "../shared/style.css";
import { mountNav } from "../shared/nav";
import type { Tint } from "./gallery";
import { mount, type Material } from "./host";
import { sketch } from "./sketch";

const DAY = 10;
const IDLE_MS = 1200; // longest wait before the scene starts anyway
const SKETCH_MS = 1500; // the line drawing plays at least this long before the picture fades in
const SHAPE_NAMES = ["Sphere", "Drop", "Cube"] as const;
const SUN_AZ_DEG = [20, 56] as const; // keep in step with gallery.ts

const START: Material = { shape: 0, ior: 1.33, tint: "emerald", wave: 0.45, flow: 0.45, sun: 0.4 };
const TINTS: Tint[] = ["clear", "emerald", "amber", "pink", "ink"];
const IOR_RANGE = [1.1, 1.7] as const; // randomize stays inside this

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const q = <T extends Element>(s: string) => root.querySelector<T>(s);
  const qa = <T extends Element>(s: string) => Array.from(root.querySelectorAll<T>(s));
  const toggle = q<HTMLButtonElement>("[data-cv-toggle]");
  const name = q<HTMLElement>("[data-cv-name]");
  const shapes = qa<HTMLButtonElement>("[data-cv-shape]");
  const tints = qa<HTMLInputElement>("[data-cv-tint]");
  const knob = (k: string) => q<HTMLInputElement>(`[data-cv-knob="${k}"]`);
  const out = (k: string) => q<HTMLOutputElement>(`[data-cv-out="${k}"]`);
  const hud = {
    ior: q<HTMLElement>("[data-cv-ior]"),
    sun: q<HTMLElement>("[data-cv-sun]"),
    shape: q<HTMLElement>("[data-cv-shape-out]"),
  };
  const params = new URLSearchParams(location.search);
  const still = () => {
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
  };

  const m: Material = { ...START };
  const want = params.get("tint") as Tint | null;
  if (want && TINTS.includes(want)) m.tint = want;
  const shuffle = q<HTMLButtonElement>("[data-cv-shuffle]");
  if (params.has("sun")) m.sun = Math.min(1, Math.max(0, Number(params.get("sun")) || 0));
  let scene: ReturnType<typeof mount> | null = null;

  // PANEL
  // the controls mirror the material
  const show = () => {
    const deg = Math.round(SUN_AZ_DEG[0] + (SUN_AZ_DEG[1] - SUN_AZ_DEG[0]) * m.sun);
    const pct = (v: number) => String(Math.round(v * 100));
    for (const [k, v, text] of [
      ["ior", m.ior, m.ior.toFixed(2)],
      ["wave", m.wave * 100, pct(m.wave)],
      ["flow", m.flow * 100, pct(m.flow)],
      ["sun", m.sun * 100, `${deg}°`],
    ] as const) {
      const i = knob(k);
      const o = out(k);
      if (i) i.value = String(v);
      if (o) o.textContent = text;
    }
    for (const b of shapes) b.setAttribute("aria-pressed", String(Number(b.value) === m.shape));
    for (const t of tints) t.checked = t.value === m.tint;
    if (name) name.textContent = `M_${m.tint[0].toUpperCase()}${m.tint.slice(1)}`;
    if (hud.ior) hud.ior.textContent = m.ior.toFixed(2);
    if (hud.sun) hud.sun.textContent = `${deg}°`;
    if (hud.shape) hud.shape.textContent = SHAPE_NAMES[m.shape];
  };
  const push = () => {
    show();
    scene?.set({ ...m });
  };
  show();
  shuffle?.addEventListener("click", () => {
    const r = Math.random;
    m.shape = Math.floor(r() * SHAPE_NAMES.length);
    m.ior = Math.round((IOR_RANGE[0] + r() * (IOR_RANGE[1] - IOR_RANGE[0])) * 100) / 100;
    m.tint = TINTS[Math.floor(r() * TINTS.length)];
    m.wave = Math.round((0.1 + r() * 0.8) * 100) / 100;
    m.flow = Math.round((0.1 + r() * 0.8) * 100) / 100;
    m.sun = Math.round(r() * 100) / 100;
    push();
  });

  toggle?.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
  });
  for (const b of shapes)
    b.addEventListener("click", () => {
      m.shape = Number(b.value);
      push();
    });
  for (const t of tints)
    t.addEventListener("change", () => {
      m.tint = t.value as Tint;
      push();
    });
  for (const k of ["ior", "wave", "flow", "sun"] as const) {
    const i = knob(k);
    i?.addEventListener("input", () => {
      const v = Number(i.value);
      if (k === "ior") m.ior = v;
      else m[k] = v / 100;
      push();
    });
  }

  const t0 = performance.now();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sheet = q<HTMLElement>(".still");
  if (sheet) sketch(sheet);

  if (!canvas || !("WebGL2RenderingContext" in window) || params.has("still")) still();
  else {
    // wait for load and an idle moment so the scene never competes with first paint
    afterLoad().then(() => {
      scene = mount(
        canvas,
        {
          shown: () => {
            const wait = reduced ? 0 : Math.max(0, SKETCH_MS - (performance.now() - t0));
            setTimeout(() => root.setAttribute("data-cv-live", ""), wait);
          },
          fail: still,
        },
        { ...m },
      );
      if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { scene });
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
