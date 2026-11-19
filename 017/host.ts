import type { Kelp } from "./kelp";

export type Sink = {
  state: (current: number) => void;
  fail: () => void;
};

type Driver = Pick<Kelp, "size" | "show" | "move" | "leave" | "push" | "motion" | "dispose">;

export type FromWorker = { t: "state"; v: number } | { t: "shown" } | { t: "fail" };

const ARROWS: Record<string, [number, number]> = {
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

// HOST
// dom side of the scene: events, size and visibility in, state out. the scene runs in a
// worker when the canvas can be handed over, so compiling and drawing never block the page
export function mount(canvas: HTMLCanvasElement, sink: Sink) {
  const cleanups: (() => void)[] = [];
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  const forceGl = new URLSearchParams(location.search).has("gl");
  const dpr = Math.min(devicePixelRatio || 1, 2);
  let driver: Driver | null = null;
  let dead = false;

  const shown = () => canvas.setAttribute("data-cv-shown", "");
  const fail = () => {
    if (dead) return;
    dispose();
    sink.fail();
  };

  // DRIVER
  const offscreen = "transferControlToOffscreen" in canvas && typeof Worker === "function";
  const ready = offscreen ? inWorker() : inPage();

  function inWorker(): Promise<Driver> {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const off = canvas.transferControlToOffscreen();
    worker.postMessage({ t: "init", canvas: off, reduced: mq.matches, forceGl, dpr }, [off]);
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const d = e.data;
      if (d.t === "state") sink.state(d.v);
      else if (d.t === "shown") shown();
      else fail();
    };
    worker.onerror = fail;
    const post = (msg: unknown) => worker.postMessage(msg);
    return Promise.resolve({
      size: (w, h, r) => post({ t: "size", w, h, dpr: r }),
      show: (v) => post({ t: "show", v }),
      move: (x, y, fresh) => post({ t: "move", x, y, fresh }),
      leave: () => post({ t: "leave" }),
      push: (x, y) => post({ t: "push", x, y }),
      motion: (v) => post({ t: "motion", v }),
      dispose: () => worker.terminate(),
    });
  }

  async function inPage(): Promise<Driver> {
    const { Kelp } = await import("./kelp");
    const k = new Kelp(canvas, { reducedMotion: mq.matches, forceGl, dpr });
    k.onState = sink.state;
    k.onShown = shown;
    const lost = (e: Event) => {
      e.preventDefault();
      fail();
    };
    canvas.addEventListener("webglcontextlost", lost);
    cleanups.push(() => canvas.removeEventListener("webglcontextlost", lost));
    return k;
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
    let fresh = true;
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
    const onMotion = () => d.motion(mq.matches);

    // POINTER
    // the cursor is the current: only its travel matters, so a press just starts a stroke
    const opts = { passive: true };
    const down = (e: PointerEvent) => {
      rect = canvas.getBoundingClientRect();
      d.move(e.clientX - rect.left, e.clientY - rect.top, true);
      fresh = false;
    };
    const move = (e: PointerEvent) => {
      d.move(e.clientX - rect.left, e.clientY - rect.top, fresh);
      fresh = false;
    };
    const leave = () => {
      fresh = true;
      d.leave();
    };
    const key = (e: KeyboardEvent) => {
      const dir = ARROWS[e.key];
      if (!dir) return;
      e.preventDefault();
      d.push(dir[0], dir[1]);
    };
    addEventListener("pointermove", move, opts);
    canvas.addEventListener("pointerdown", down, opts);
    canvas.addEventListener("pointerup", leave, opts);
    canvas.addEventListener("pointercancel", leave, opts);
    document.addEventListener("pointerleave", leave, opts);
    canvas.addEventListener("keydown", key);
    document.addEventListener("visibilitychange", show);
    mq.addEventListener("change", onMotion);
    cleanups.push(
      () => ro.disconnect(),
      () => io.disconnect(),
      () => removeEventListener("pointermove", move),
      () => canvas.removeEventListener("pointerdown", down),
      () => canvas.removeEventListener("pointerup", leave),
      () => canvas.removeEventListener("pointercancel", leave),
      () => document.removeEventListener("pointerleave", leave),
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
