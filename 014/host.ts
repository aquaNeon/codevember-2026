import type { Harp, Opts } from "./harp";

export type Sink = {
  shown: () => void;
  fail: () => void;
};

// the calls the page makes on the drawing, the same in a worker or in the page
export const CALLS = [
  "size",
  "visibility",
  "motion",
  "hold",
  "release",
  "pluck",
  "tune",
  "select",
] as const;
type Call = (typeof CALLS)[number];
export type Driver = Pick<Harp, Call | "dispose">;

export type ToWorker =
  { t: "init"; canvas: OffscreenCanvas; opts: Opts } | { t: Call; a: unknown[] };
export type FromWorker = { t: "shown" } | { t: "fail" };

// HOST
// dom side of the drawing: size and visibility in. the strings are drawn in a worker when the
// canvas can be handed over, so painting the wood never blocks the page; otherwise here
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

  const offscreen =
    "transferControlToOffscreen" in canvas &&
    typeof Worker === "function" &&
    typeof OffscreenCanvas === "function";
  const ready = offscreen ? inWorker() : inPage();

  function inWorker(): Promise<Driver> {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const off = canvas.transferControlToOffscreen();
    worker.postMessage({ t: "init", canvas: off, opts } satisfies ToWorker, [off]);
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      if (e.data.t === "shown") sink.shown();
      else fail();
    };
    worker.onerror = fail;
    const d = { dispose: () => worker.terminate() } as Record<string, unknown>;
    for (const t of CALLS) d[t] = (...a: unknown[]) => worker.postMessage({ t, a });
    return Promise.resolve(d as unknown as Driver);
  }

  async function inPage(): Promise<Driver> {
    const { Harp } = await import("./harp");
    const h = new Harp(canvas, opts);
    h.onShown = sink.shown;
    return h;
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
    const show = () => d.visibility(onScreen && !document.hidden);
    const ro = new ResizeObserver(() =>
      d.size(canvas.clientWidth, canvas.clientHeight, devicePixelRatio),
    );
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      show();
    });
    io.observe(canvas);
    const onMotion = () => d.motion(mq.matches);
    document.addEventListener("visibilitychange", show);
    mq.addEventListener("change", onMotion);
    cleanups.push(
      () => ro.disconnect(),
      () => io.disconnect(),
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

  // calls made before the drawing is up are dropped; the page replays its state on shown
  return {
    hold: (i: number, p: number, d: number) => driver?.hold(i, p, d),
    release: (i: number) => driver?.release(i),
    pluck: (i: number, p: number, d: number) => driver?.pluck(i, p, d),
    tune: (i: number, f: number, turn: number, t60: number) => driver?.tune(i, f, turn, t60),
    select: (i: number) => driver?.select(i),
    dispose,
  };
}
