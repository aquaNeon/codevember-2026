import type { Opts } from "./gl";
import type { Hud, Nest } from "./nest";

export type Sink = {
  hud: (h: Hud) => void;
  shown: () => void;
  fail: () => void;
};

// the calls the page makes on the scene, the same in a worker or on the page
export const CALLS = [
  "size",
  "visibility",
  "motion",
  "press",
  "move",
  "lift",
  "leave",
  "wheel",
  "key",
] as const;
type Call = (typeof CALLS)[number];
type Driver = Pick<Nest, Call | "dispose">;

export type ToWorker =
  { t: "init"; canvas: OffscreenCanvas; opts: Opts } | { t: Call; a: unknown[] };
export type FromWorker = { t: "hud"; h: Hud } | { t: "shown" } | { t: "fail" };

const KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"]);
const LINE_PX = 16;

// HOST
// the dom side: size, visibility, pointer, wheel and keys in, the hud out. the scene runs in a worker
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
    const { Nest } = await import("./nest");
    const s = new Nest(canvas, opts);
    if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { nest: s });
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

    const down = (e: PointerEvent) => {
      if (pointer !== -1) return;
      pointer = e.pointerId;
      rect = canvas.getBoundingClientRect();
      canvas.setPointerCapture?.(e.pointerId);
      d.press(e.clientX - rect.left, e.clientY - rect.top);
    };
    // pressed, it turns and runs the weaving; a mouse passing by is a breath of air
    const move = (e: PointerEvent) => {
      if (pointer !== -1 && e.pointerId !== pointer) return;
      if (pointer === -1 && e.pointerType !== "mouse") return;
      d.move(e.clientX - rect.left, e.clientY - rect.top);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pointer = -1;
      d.lift();
    };
    const leave = (e: PointerEvent) => {
      if (pointer === -1 && e.pointerType === "mouse") d.leave();
    };
    // scrolling down weaves on, up unweaves
    const wheel = (e: WheelEvent) => {
      const k = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? innerHeight : 1;
      d.wheel(e.deltaY * k);
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
