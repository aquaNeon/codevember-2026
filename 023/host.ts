import type { Hud, Magma } from "./magma";
import type { Opts } from "./gl";

export type Sink = {
  hud: (h: Hud) => void;
  shown: () => void;
  fail: () => void;
};

// CALLS
// same api in a worker or on the page
export const CALLS = [
  "size",
  "visibility",
  "motion",
  "press",
  "move",
  "lift",
  "leave",
  "key",
] as const;
type Call = (typeof CALLS)[number];
type Driver = Pick<Magma, Call | "dispose">;

export type ToWorker =
  { t: "init"; canvas: OffscreenCanvas; opts: Opts } | { t: Call; a: unknown[] };
export type FromWorker = { t: "hud"; h: Hud } | { t: "shown" } | { t: "fail" };

const KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

// HOST
// dom side: size, visibility, pointer, keys in; hud out; worker when transferable
export function mount(canvas: HTMLCanvasElement, sink: Sink, opts: Opts) {
  const cleanups: (() => void)[] = [];
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  let driver: Driver | null = null;
  let dead = false;
  let over = false;
  let pointer = -1;
  const hud = (h: Hud) => {
    if (h.over !== over) {
      over = h.over;
      if (pointer === -1) canvas.style.cursor = over ? "grab" : "";
    }
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
    const { Magma } = await import("./magma");
    const m = new Magma(canvas, opts);
    if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { magma: m });
    m.onHud = hud;
    m.onShown = sink.shown;
    const lost = (e: Event) => {
      e.preventDefault();
      fail();
    };
    canvas.addEventListener("webglcontextlost", lost);
    cleanups.push(() => canvas.removeEventListener("webglcontextlost", lost));
    return m;
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
    let lastT = 0;
    const show = () => d.visibility(onScreen && !document.hidden);
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

    // POINTER
    const down = (e: PointerEvent) => {
      if (pointer !== -1) return;
      pointer = e.pointerId;
      rect = canvas.getBoundingClientRect();
      canvas.setPointerCapture?.(e.pointerId);
      lastT = e.timeStamp;
      canvas.style.cursor = "grabbing";
      d.press(e.clientX - rect.left, e.clientY - rect.top);
    };
    const move = (e: PointerEvent) => {
      if (pointer !== -1 && e.pointerId !== pointer) return;
      const dt = e.timeStamp - lastT;
      lastT = e.timeStamp;
      d.move(e.clientX - rect.left, e.clientY - rect.top, dt);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pointer = -1;
      canvas.style.cursor = over ? "grab" : "";
      d.lift();
      if (e.pointerType !== "mouse") d.leave();
    };
    const leave = (e: PointerEvent) => {
      if (pointer === -1 && e.pointerType === "mouse") d.leave();
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
    canvas.addEventListener("pointerleave", leave, opts);
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
      () => canvas.removeEventListener("pointerleave", leave),
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
