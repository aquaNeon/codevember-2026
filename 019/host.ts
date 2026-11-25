import type { Opts } from "./gl";
import type { Hud, Sky } from "./sky";

export type Sink = {
  hud: (h: Hud) => void;
  shown: () => void;
  fail: () => void;
};

// the calls the page makes on the sky, the same in a worker or on the page
export const CALLS = [
  "size",
  "visibility",
  "motion",
  "press",
  "drag",
  "lift",
  "key",
  "type",
] as const;
type Call = (typeof CALLS)[number];
type Driver = Pick<Sky, Call | "dispose">;

export type ToWorker =
  { t: "init"; canvas: OffscreenCanvas; opts: Opts } | { t: Call; a: unknown[] };
export type FromWorker = { t: "hud"; h: Hud } | { t: "shown" } | { t: "fail" };

const TAP_MS = 260;
const TAP_PX = 8;
const KEYS = new Set(["Enter", " "]);

// HOST
// the dom side: size, visibility, pointer and keys in, the hud out. the sky runs in a worker
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
    const { Sky } = await import("./sky");
    const s = new Sky(canvas, opts);
    if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { sky: s });
    s.onHud = sink.hud;
    s.onShown = sink.shown;
    const lost = (e: Event) => {
      e.preventDefault();
      fail();
    };
    canvas.addEventListener("webglcontextlost", lost);
    cleanups.push(() => canvas.removeEventListener("webglcontextlost", lost));
    return s;
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
    let pointer = -1;
    let downX = 0;
    let downY = 0;
    let downT = 0;
    const show = () => d.visibility(onScreen && !document.hidden);
    // TYPE
    // where the title and hud sit, so the sky can thin its tone behind them
    const blocks = canvas.closest("[data-cv]")?.querySelectorAll<HTMLElement>(".cv-title, .cv-hud");
    const type = () => {
      const b: number[] = [];
      blocks?.forEach((el, i) => {
        if (i > 1) return;
        const r = el.getBoundingClientRect();
        b.push(
          r.left - rect.left,
          rect.bottom - r.bottom,
          r.right - rect.left,
          rect.bottom - r.top,
        );
      });
      while (b.length < 8) b.push(0);
      d.type(b);
    };
    const ro = new ResizeObserver(() => {
      rect = canvas.getBoundingClientRect();
      d.size(canvas.clientWidth, canvas.clientHeight, devicePixelRatio || 1);
      type();
    });
    document.fonts?.ready.then(() => {
      if (!dead) type();
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      show();
    });
    io.observe(canvas);
    const onMotion = () => d.motion(mq.matches);

    const down = (e: PointerEvent) => {
      if (pointer !== -1) return;
      pointer = e.pointerId;
      rect = canvas.getBoundingClientRect();
      canvas.setPointerCapture?.(e.pointerId);
      downX = e.clientX;
      downY = e.clientY;
      downT = performance.now();
      d.press(e.clientX - rect.left, e.clientY - rect.top);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId === pointer) d.drag(e.clientX - rect.left, e.clientY - rect.top);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pointer = -1;
      const tap =
        performance.now() - downT < TAP_MS &&
        Math.hypot(e.clientX - downX, e.clientY - downY) < TAP_PX;
      d.lift(tap);
    };
    const key = (e: KeyboardEvent) => {
      if (!KEYS.has(e.key)) return;
      e.preventDefault();
      d.key(e.key);
    };
    const opts = { passive: true };
    canvas.addEventListener("pointerdown", down, opts);
    canvas.addEventListener("pointermove", move, opts);
    canvas.addEventListener("pointerup", up, opts);
    canvas.addEventListener("pointercancel", up, opts);
    canvas.addEventListener("keydown", key);
    document.addEventListener("visibilitychange", show);
    mq.addEventListener("change", onMotion);
    cleanups.push(
      () => ro.disconnect(),
      () => io.disconnect(),
      () => canvas.removeEventListener("pointerdown", down),
      () => canvas.removeEventListener("pointermove", move),
      () => canvas.removeEventListener("pointerup", up),
      () => canvas.removeEventListener("pointercancel", up),
      () => canvas.removeEventListener("keydown", key),
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
