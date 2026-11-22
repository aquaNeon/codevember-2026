import type { Cave, Hud } from "./cave";
import type { Opts } from "./gl";

export type Sink = {
  hud: (h: Hud) => void;
  shown: () => void;
  fail: () => void;
};

// the calls the page makes on the cave, the same in a worker or on the page
export const CALLS = ["size", "visibility", "motion", "steer", "wheel", "press", "key"] as const;
type Call = (typeof CALLS)[number];
type Driver = Pick<Cave, Call | "dispose">;

export type ToWorker =
  { t: "init"; canvas: OffscreenCanvas; opts: Opts } | { t: Call; a: unknown[] };
export type FromWorker = { t: "hud"; h: Hud } | { t: "shown" } | { t: "fail" };

const KEYS = new Set(["Enter", " "]);
const TAP_MS = 300;
const LINE_PX = 16; // a wheel line, in px
const SWIPE_K = 1.6; // a finger moves less than a wheel spins
const LOCK_PX = 10; // a touch picks its axis after this much travel
const STEER_SPAN = 0.35; // a sideways drag this share of the width steers fully

// HOST
// the dom side: size, visibility, pointer and keys in, the hud out. the cave runs in a worker
// when the canvas can be handed over, so compiling and drawing never block the page
export function mount(canvas: HTMLCanvasElement, sink: Sink, opts: Opts) {
  const cleanups: (() => void)[] = [];
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  let driver: Driver | null = null;
  let dead = false;

  const fail = () => {
    if (dead) return;
    dispose();
    sink.fail();
  };

  const params = new URLSearchParams(location.search);
  const offscreen =
    "transferControlToOffscreen" in canvas &&
    typeof Worker === "function" &&
    !(import.meta.env.DEV && params.has("page"));
  const ready = offscreen ? inWorker() : inPage();

  function inWorker(): Promise<Driver> {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const off = canvas.transferControlToOffscreen();
    worker.postMessage({ t: "init", canvas: off, opts } satisfies ToWorker, [off]);
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const d = e.data;
      if (d.t === "hud") sink.hud(d.h);
      else if (d.t === "shown") sink.shown();
      else fail();
    };
    worker.onerror = fail;
    const call =
      (t: Call) =>
      (...a: unknown[]) =>
        worker.postMessage({ t, a } satisfies ToWorker);
    const d = Object.fromEntries(CALLS.map((c) => [c, call(c)])) as unknown as Driver;
    d.dispose = () => worker.terminate();
    return Promise.resolve(d);
  }

  async function inPage(): Promise<Driver> {
    const { Cave } = await import("./cave");
    const c = new Cave(canvas, opts);
    if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { echo: c });
    c.onHud = sink.hud;
    c.onShown = sink.shown;
    const lost = (e: Event) => {
      e.preventDefault();
      fail();
    };
    canvas.addEventListener("webglcontextlost", lost);
    cleanups.push(() => canvas.removeEventListener("webglcontextlost", lost));
    return c;
  }

  ready
    .then((d) => {
      if (dead) return d.dispose();
      driver = d;
      wire(d);
    })
    .catch(fail);

  function wire(d: Driver) {
    let onScreen = false;
    let rect = canvas.getBoundingClientRect();
    const show = () => d.visibility(onScreen && !document.hidden);
    // where the title sits over the top of the cave, the roof starts below it
    const title = document.querySelector<HTMLElement>(".cv-title");
    const ro = new ResizeObserver(() => {
      rect = canvas.getBoundingClientRect();
      const t = title?.getBoundingClientRect();
      const top = t && t.top < rect.height / 2 ? Math.max(0, t.bottom - rect.top + 12) : 0;
      d.size(canvas.clientWidth, canvas.clientHeight, devicePixelRatio || 1, top);
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      show();
    });
    io.observe(canvas);
    const onMotion = () => d.motion(mq.matches);

    // STEER, FLY AND TAP
    // mouse: hover steers, the wheel flies, a click calls. touch: once a finger has moved
    // LOCK_PX it is either a vertical swipe that flies or a sideways drag that steers, never
    // both; a touch that never locks is a tap and calls
    let downX = 0;
    let downY = 0;
    let downT = 0;
    let lastY = 0;
    let finger = -1;
    let axis = 0; // 0 none yet, 1 sideways, 2 vertical
    const down = (e: PointerEvent) => {
      if (e.button > 0) return;
      canvas.setAttribute("data-cv-pointer", "");
      if (e.pointerType === "mouse") {
        d.press(e.clientX - rect.left, e.clientY - rect.top);
        return;
      }
      if (finger !== -1) return;
      finger = e.pointerId;
      axis = 0;
      downX = e.clientX;
      downY = e.clientY;
      downT = performance.now();
      lastY = e.clientY;
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType === "mouse") {
        d.steer(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -(((e.clientY - rect.top) / rect.height) * 2 - 1),
        );
        return;
      }
      if (e.pointerId !== finger) return;
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (axis === 0) {
        if (Math.hypot(dx, dy) < LOCK_PX) return;
        axis = Math.abs(dx) > Math.abs(dy) ? 1 : 2;
      }
      if (axis === 1) d.steer(Math.max(-1, Math.min(1, dx / (rect.width * STEER_SPAN))), 0);
      else d.wheel((lastY - e.clientY) * SWIPE_K);
      lastY = e.clientY;
    };
    const wheel = (e: WheelEvent) => {
      const k = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? innerHeight : 1;
      d.wheel(e.deltaY * k);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== finger) return;
      finger = -1;
      if (axis === 1) d.steer(0, 0);
      else if (axis === 0 && performance.now() - downT < TAP_MS)
        d.press(e.clientX - rect.left, e.clientY - rect.top);
    };
    const leave = (e: PointerEvent) => {
      if (e.pointerType === "mouse") d.steer(0, 0);
    };
    const blur = () => canvas.removeAttribute("data-cv-pointer");
    const key = (e: KeyboardEvent) => {
      if (!KEYS.has(e.key)) return;
      e.preventDefault();
      d.key(e.key);
    };
    canvas.addEventListener("pointerdown", down, { passive: true });
    canvas.addEventListener("pointermove", move, { passive: true });
    canvas.addEventListener("pointerup", up, { passive: true });
    canvas.addEventListener("pointercancel", up, { passive: true });
    canvas.addEventListener("pointerleave", leave, { passive: true });
    canvas.addEventListener("keydown", key);
    canvas.addEventListener("blur", blur);
    addEventListener("wheel", wheel, { passive: true });
    document.addEventListener("visibilitychange", show);
    mq.addEventListener("change", onMotion);
    cleanups.push(
      () => ro.disconnect(),
      () => io.disconnect(),
      () => canvas.removeEventListener("pointerdown", down),
      () => canvas.removeEventListener("pointermove", move),
      () => canvas.removeEventListener("pointerup", up),
      () => canvas.removeEventListener("pointercancel", up),
      () => canvas.removeEventListener("pointerleave", leave),
      () => canvas.removeEventListener("keydown", key),
      () => canvas.removeEventListener("blur", blur),
      () => removeEventListener("wheel", wheel),
      () => document.removeEventListener("visibilitychange", show),
      () => mq.removeEventListener("change", onMotion),
    );
  }

  function dispose() {
    dead = true;
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
    driver?.dispose();
    driver = null;
  }

  return { dispose };
}
