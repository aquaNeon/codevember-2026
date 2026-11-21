import type { Garden, Hud } from "./garden";
import type { Opts } from "./gl";

export type Sink = {
  hud: (h: Hud) => void;
  shown: () => void;
  fail: () => void;
};

// the calls the page makes on the garden, the same in a worker or on the page
export const CALLS = [
  "size",
  "visibility",
  "motion",
  "press",
  "move",
  "lift",
  "leave",
  "key",
  "wheel",
  "keepOut",
] as const;
type Call = (typeof CALLS)[number];
type Driver = Pick<Garden, Call | "dispose">;

export type ToWorker =
  { t: "init"; canvas: OffscreenCanvas; opts: Opts } | { t: Call; a: unknown[] };
export type FromWorker = { t: "hud"; h: Hud } | { t: "shown" } | { t: "fail" };

const TAP_MS = 260;
const TAP_PX = 8;
const KEYS = new Set(["Enter", " ", "ArrowRight", "ArrowDown", "PageDown"]);
const LINE_PX = 16;
const BOX_PAD_PX = 12;

// HOST
// the dom side: size, visibility, pointer, wheel and keys in, the hud out. the garden runs in
// a worker when the canvas can be handed over, so compiling and drawing never block the page
export function mount(canvas: HTMLCanvasElement, sink: Sink, opts: Opts) {
  const cleanups: (() => void)[] = [];
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  let driver: Driver | null = null;
  let dead = false;
  // the plant's box on screen, from the last hud, for the pointer cursor
  let box: Hud | null = null;
  const hud = (h: Hud) => {
    box = h;
    sink.hud(h);
  };

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
      if (d.t === "hud") hud(d.h);
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
    const { Garden } = await import("./garden");
    const g = new Garden(canvas, opts);
    if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { garden: g });
    g.onHud = hud;
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
    let pointer = -1;
    let downX = 0;
    let downY = 0;
    let downT = 0;
    let lastX = 0;
    let lastY = 0;
    let hand = false;
    const show = () => d.visibility(onScreen && !document.hidden);
    // the title's and the hud's boxes, so the bed's neighbours can keep clear of them
    const zones = () => {
      const a = document.querySelector(".cv-title")?.getBoundingClientRect();
      const b = document.querySelector(".cv-hud")?.getBoundingClientRect();
      if (!a || !b) return;
      d.keepOut(
        a.left - rect.left,
        a.top - rect.top,
        a.width,
        a.height,
        b.left - rect.left,
        b.top - rect.top,
        b.width,
        b.height,
      );
    };
    const ro = new ResizeObserver(() => {
      rect = canvas.getBoundingClientRect();
      d.size(canvas.clientWidth, canvas.clientHeight, devicePixelRatio || 1);
      zones();
    });
    document.fonts?.ready.then(() => !dead && zones());
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
      lastX = e.clientX;
      lastY = e.clientY;
      d.press(e.clientX - rect.left, e.clientY - rect.top);
    };
    // the sun follows the pointer; dragging, like scrolling, hurries the summer
    const move = (e: PointerEvent) => {
      if (pointer !== -1 && e.pointerId !== pointer) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      d.move(x, y);
      if (e.pointerType === "mouse" && box) {
        const over =
          x > box.x0 - BOX_PAD_PX &&
          x < box.x1 + BOX_PAD_PX &&
          y > box.y0 - BOX_PAD_PX &&
          y < box.y1 + BOX_PAD_PX;
        if (over !== hand) {
          hand = over;
          canvas.style.cursor = over ? "pointer" : "";
        }
      }
      if (pointer === -1) return;
      d.wheel(Math.hypot(e.clientX - lastX, e.clientY - lastY));
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const wheel = (e: WheelEvent) => {
      const k = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? innerHeight : 1;
      d.wheel(Math.hypot(e.deltaX, e.deltaY) * k);
    };
    const leave = (e: PointerEvent) => {
      if (pointer === -1 && e.pointerType === "mouse") d.leave();
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pointer = -1;
      const tap =
        performance.now() - downT < TAP_MS &&
        Math.hypot(e.clientX - downX, e.clientY - downY) < TAP_PX;
      d.lift(tap, e.clientX - rect.left);
    };
    // arrows and Page Down hurry it too; Enter or Space shakes it
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
    canvas.addEventListener("pointerleave", leave, opts);
    canvas.addEventListener("keydown", key);
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
