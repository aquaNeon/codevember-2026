import type { Opts } from "./gl";
import type { Specimen } from "./specimen";

export type Sink = {
  age: (age: number, playing: boolean) => void;
  shown: () => void;
  fail: () => void;
};

export const CALLS = [
  "size",
  "visibility",
  "motion",
  "press",
  "drag",
  "lift",
  "turn",
  "setAge",
  "play",
  "tune",
] as const;
type Call = (typeof CALLS)[number];
type Driver = Pick<Specimen, Call | "dispose">;

export type ToWorker =
  { t: "init"; canvas: OffscreenCanvas; opts: Opts } | { t: Call; a: unknown[] };
export type FromWorker =
  { t: "age"; age: number; playing: boolean } | { t: "shown" } | { t: "fail" };

// HOST
// scene runs in a worker when the canvas can transfer, otherwise on the page
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

  const offscreen = "transferControlToOffscreen" in canvas && typeof Worker === "function";
  const ready = offscreen ? inWorker() : inPage();

  function inWorker(): Promise<Driver> {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const off = canvas.transferControlToOffscreen();
    worker.postMessage({ t: "init", canvas: off, opts } satisfies ToWorker, [off]);
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const d = e.data;
      if (d.t === "age") sink.age(d.age, d.playing);
      else if (d.t === "shown") sink.shown();
      else fail();
    };
    worker.onerror = fail;
    const d = { dispose: () => worker.terminate() } as Record<string, unknown>;
    for (const t of CALLS) d[t] = (...a: unknown[]) => worker.postMessage({ t, a });
    return Promise.resolve(d as unknown as Driver);
  }

  async function inPage(): Promise<Driver> {
    const { Specimen } = await import("./specimen");
    const p = new Specimen(canvas, opts);
    p.onAge = sink.age;
    p.onShown = sink.shown;
    const lost = (e: Event) => {
      e.preventDefault();
      fail();
    };
    canvas.addEventListener("webglcontextlost", lost);
    cleanups.push(() => canvas.removeEventListener("webglcontextlost", lost));
    return p;
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
    const ro = new ResizeObserver(() => {
      rect = canvas.getBoundingClientRect();
      d.size(canvas.clientWidth, canvas.clientHeight, devicePixelRatio);
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      show();
    });
    io.observe(canvas);
    const onMotion = () => d.motion(mq.matches);
    let pid = -1;
    const down = (e: PointerEvent) => {
      if (pid !== -1) return;
      pid = e.pointerId;
      rect = canvas.getBoundingClientRect();
      canvas.setPointerCapture(e.pointerId);
      d.press(e.clientX - rect.left, e.clientY - rect.top);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId === pid) d.drag(e.clientX - rect.left, e.clientY - rect.top);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      pid = -1;
      d.lift();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      d.turn(e.key === "ArrowLeft" ? -1 : 1);
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

  return {
    setAge: (t: number) => driver?.setAge(t),
    play: (on: boolean) => driver?.play(on),
    tune: (h: number, s: number, sc: number, f: number, tone: number) =>
      driver?.tune(h, s, sc, f, tone),
    dispose,
  };
}
