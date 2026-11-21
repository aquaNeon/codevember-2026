import type { Haze, Hud, Opts } from "./haze";
import { HORIZON } from "./shaders";

export type Sink = {
  hud: (h: Hud) => void;
  shown: () => void;
  fail: () => void;
};

// the calls the page makes on the haze, the same in a worker or on the page
export const CALLS = ["size", "show", "motion", "warm", "lean"] as const;
type Call = (typeof CALLS)[number];
type Driver = Pick<Haze, Call | "dispose">;

export type ToWorker =
  { t: "init"; canvas: OffscreenCanvas; opts: Opts } | { t: Call; a: unknown[] };
export type FromWorker = { t: "hud"; h: Hud } | { t: "shown" } | { t: "fail" };

const LINE_PX = 16;
const ON_HORIZON = 1 - HORIZON; // the horizon, as a share from the top
const KEY_PX = 90;
const KEY_STEP = 0.08;

// HOST
// the dom side: size, visibility, pointer, wheel and keys in, the hud out. the haze runs in a
// worker when the canvas can be handed over, so compiling never blocks the page
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
    const { Haze } = await import("./haze");
    const g = new Haze(canvas, opts);
    if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { haze: g });
    g.onHud = sink.hud;
    g.onShown = sink.shown;
    const lost = (e: Event) => {
      e.preventDefault();
      fail();
    };
    canvas.addEventListener("webglcontextlost", lost);
    cleanups.push(() => canvas.removeEventListener("webglcontextlost", lost));
    return g;
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
    let touch = -1;
    let lastY = 0;
    let keyX = 0.5;
    const show = () => d.show(onScreen && !document.hidden);
    const ro = new ResizeObserver(() => {
      rect = canvas.getBoundingClientRect();
      d.size(canvas.clientWidth, canvas.clientHeight, devicePixelRatio || 1);
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      show();
    });
    io.observe(canvas);
    const onMotion = () => d.motion(mq.matches);

    // the pointer is heat; a finger warms the horizon where it rests and slides the eye up and down
    const share = (e: PointerEvent) => [
      (e.clientX - rect.left) / (rect.width || 1),
      (e.clientY - rect.top) / (rect.height || 1),
    ];
    const move = (e: PointerEvent) => {
      if (e.pointerType === "mouse") {
        const [x, y] = share(e);
        d.warm(x, y, true);
        return;
      }
      if (e.pointerId !== touch) return;
      const [x] = share(e);
      d.warm(x, ON_HORIZON, true);
      d.lean(lastY - e.clientY);
      lastY = e.clientY;
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" || touch !== -1) return;
      touch = e.pointerId;
      lastY = e.clientY;
      canvas.setPointerCapture?.(e.pointerId);
      const [x] = share(e);
      d.warm(x, ON_HORIZON, true);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== touch) return;
      touch = -1;
      d.warm(0.5, 0.5, false);
    };
    const leave = (e: PointerEvent) => {
      if (e.pointerType === "mouse") d.warm(0.5, 0.5, false);
    };
    const wheel = (e: WheelEvent) => {
      const k = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? innerHeight : 1;
      d.lean(e.deltaY * k);
    };
    // up and down move the eye; left and right carry the heat along the horizon
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "ArrowUp") d.lean(-KEY_PX);
      else if (e.key === "ArrowDown") d.lean(KEY_PX);
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        keyX = Math.min(1, Math.max(0, keyX + (e.key === "ArrowLeft" ? -KEY_STEP : KEY_STEP)));
        d.warm(keyX, ON_HORIZON, true);
      } else if (e.key === "Escape") d.warm(0.5, 0.5, false);
      else return;
      e.preventDefault();
    };
    const blur = () => d.warm(0.5, 0.5, false);
    const opts = { passive: true };
    canvas.addEventListener("pointerdown", down, opts);
    canvas.addEventListener("pointermove", move, opts);
    canvas.addEventListener("pointerup", up, opts);
    canvas.addEventListener("pointercancel", up, opts);
    canvas.addEventListener("pointerleave", leave, opts);
    canvas.addEventListener("keydown", key);
    canvas.addEventListener("blur", blur);
    addEventListener("wheel", wheel, opts);
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
