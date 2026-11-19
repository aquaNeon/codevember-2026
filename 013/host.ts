import type { Garden, Phase } from "./garden";

export type Sink = {
  state: (circuit: number, raked: number, phase: Phase, out: boolean) => void;
  fail: () => void;
};

type Driver = Pick<
  Garden,
  "size" | "show" | "down" | "move" | "up" | "key" | "walk" | "motion" | "dispose"
>;

export type FromWorker =
  | { t: "state"; c: number; m: number; phase: Phase; out: boolean }
  | { t: "cursor"; c: string }
  | { t: "shown" }
  | { t: "fail" };

const ARROWS = new Set(["ArrowRight", "ArrowUp", "ArrowLeft", "ArrowDown"]);

// HOST
// dom side of the garden: events, size and visibility in, state out. the scene runs in a
// worker when the canvas can be handed over, so compiling and drawing never block the page
export function mount(canvas: HTMLCanvasElement, sink: Sink) {
  const cleanups: (() => void)[] = [];
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  const forceGl = new URLSearchParams(location.search).has("gl");
  let driver: Driver | null = null;
  let dead = false;

  const shown = () => canvas.setAttribute("data-cv-shown", "");
  const cursor = (c: string) => (canvas.style.cursor = c);
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
    worker.postMessage({ t: "init", canvas: off, reduced: mq.matches, forceGl }, [off]);
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const d = e.data;
      if (d.t === "state") sink.state(d.c, d.m, d.phase, d.out);
      else if (d.t === "cursor") cursor(d.c);
      else if (d.t === "shown") shown();
      else fail();
    };
    worker.onerror = fail;
    const post = (msg: unknown) => worker.postMessage(msg);
    return Promise.resolve({
      size: (w, h, dpr) => post({ t: "size", w, h, dpr }),
      show: (v) => post({ t: "show", v }),
      down: (x, y, id) => post({ t: "down", x, y, id }),
      move: (x, y, id, mouse) => post({ t: "move", x, y, id, mouse }),
      up: (id) => post({ t: "up", id }),
      key: (k) => post({ t: "key", k }),
      walk: () => post({ t: "walk" }),
      motion: (v) => post({ t: "motion", v }),
      dispose: () => worker.terminate(),
    });
  }

  async function inPage(): Promise<Driver> {
    const { Garden } = await import("./garden");
    const g = new Garden(canvas, { reducedMotion: mq.matches, forceGl });
    g.onState = sink.state;
    g.onCursor = cursor;
    g.onShown = shown;
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
      d.move(e.clientX - rect.left, e.clientY - rect.top, e.pointerId, e.pointerType === "mouse");
    const up = (e: PointerEvent) => d.up(e.pointerId);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        d.walk();
      } else if (ARROWS.has(e.key)) {
        e.preventDefault();
        d.key(e.key);
      }
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

  return {
    walk: () => driver?.walk(),
    dispose,
  };
}
