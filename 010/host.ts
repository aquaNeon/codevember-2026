import type { Gallery, Opts, Tint } from "./gallery";

export type Sink = {
  shown: () => void;
  fail: () => void;
};

export type Material = {
  shape: number;
  ior: number;
  tint: Tint;
  wave: number;
  flow: number;
  sun: number;
};

type Driver = Pick<
  Gallery,
  "size" | "show" | "motion" | "down" | "move" | "up" | "key" | "set" | "dispose"
>;

export type ToWorker =
  | { t: "init"; canvas: OffscreenCanvas; opts: Opts }
  | { t: "size"; w: number; h: number; dpr: number }
  | { t: "show"; v: boolean }
  | { t: "motion"; v: boolean }
  | { t: "down"; x: number; y: number; id: number }
  | { t: "move"; x: number; y: number; id: number }
  | { t: "up"; id: number }
  | { t: "key" }
  | { t: "set"; m: Material };

export type FromWorker =
  { t: "cursor"; c: string } | { t: "perf"; ms: number } | { t: "shown" } | { t: "fail" };

// HOST
// runs the scene in a worker on an OffscreenCanvas when supported
export function mount(canvas: HTMLCanvasElement, sink: Sink, m: Material) {
  const cleanups: (() => void)[] = [];
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  const params = new URLSearchParams(location.search);
  const opts: Opts = {
    reducedMotion: mq.matches,
    forceGl: params.has("gl"),
    perf: params.has("perf"),
  };
  const logPerf = (ms: number) => console.info(`gpu ${ms.toFixed(2)} ms/frame`);
  let driver: Driver | null = null;
  let dead = false;
  let pending: Material = m;

  const cursor = (c: string) => (canvas.style.cursor = c);
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
      if (d.t === "cursor") cursor(d.c);
      else if (d.t === "perf") logPerf(d.ms);
      else if (d.t === "shown") sink.shown();
      else fail();
    };
    worker.onerror = fail;
    const post = (msg: ToWorker) => worker.postMessage(msg);
    return Promise.resolve({
      size: (w, h, dpr) => post({ t: "size", w, h, dpr }),
      show: (v) => post({ t: "show", v }),
      motion: (v) => post({ t: "motion", v }),
      down: (x, y, id) => post({ t: "down", x, y, id }),
      move: (x, y, id) => post({ t: "move", x, y, id }),
      up: (id) => post({ t: "up", id }),
      key: () => post({ t: "key" }),
      set: (shape, ior, tint, wave, flow, sun) =>
        post({ t: "set", m: { shape, ior, tint, wave, flow, sun } }),
      dispose: () => worker.terminate(),
    });
  }

  async function inPage(): Promise<Driver> {
    const { Gallery } = await import("./gallery");
    const g = new Gallery(canvas, opts);
    g.onPerf = logPerf;
    g.onCursor = cursor;
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
      apply(pending);
      wire(d);
    })
    .catch(fail);

  function apply(x: Material) {
    pending = x;
    driver?.set(x.shape, x.ior, x.tint, x.wave, x.flow, x.sun);
  }

  function wire(d: Driver) {
    let onScreen = false;
    let rect = canvas.getBoundingClientRect();
    const show = () => d.show(onScreen && !document.hidden);
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
    const onScroll = () => (rect = canvas.getBoundingClientRect());
    const onMotion = () => d.motion(mq.matches);

    const opts = { passive: true };
    const down = (e: PointerEvent) => {
      rect = canvas.getBoundingClientRect();
      canvas.setPointerCapture?.(e.pointerId);
      d.down(e.clientX - rect.left, e.clientY - rect.top, e.pointerId);
    };
    const move = (e: PointerEvent) =>
      d.move(e.clientX - rect.left, e.clientY - rect.top, e.pointerId);
    const up = (e: PointerEvent) => d.up(e.pointerId);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      d.key();
    };
    canvas.addEventListener("pointerdown", down, opts);
    canvas.addEventListener("pointermove", move, opts);
    canvas.addEventListener("pointerup", up, opts);
    canvas.addEventListener("pointercancel", up, opts);
    canvas.addEventListener("keydown", key);
    document.addEventListener("visibilitychange", show);
    addEventListener("scroll", onScroll, opts);
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
      () => removeEventListener("scroll", onScroll),
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

  return { dispose, set: apply };
}
