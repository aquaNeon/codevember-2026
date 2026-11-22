import { textBoxes } from "./frame";
import type { Mirage } from "./mirage";

export type Sink = {
  avoid: HTMLElement[];
  state: (driven: number, ahead: number) => void;
  ready: () => void;
  fail: () => void;
};

type Driver = Pick<
  Mirage,
  | "size"
  | "avoid"
  | "show"
  | "motion"
  | "point"
  | "down"
  | "drag"
  | "up"
  | "leave"
  | "wheel"
  | "keys"
> & { dispose: () => void };

export type ToWorker =
  | {
      t: "init";
      canvas: OffscreenCanvas;
      reduced: boolean;
      forceGl: boolean;
    }
  | { t: "size"; w: number; h: number; dpr: number }
  | { t: "avoid"; b: number[] }
  | { t: "show"; v: boolean }
  | { t: "motion"; v: boolean }
  | { t: "point"; x: number }
  | { t: "down"; y: number }
  | { t: "drag"; y: number }
  | { t: "up" }
  | { t: "leave" }
  | { t: "wheel"; px: number }
  | { t: "keys"; dir: number };

export type FromWorker = { t: "state"; d: number; a: number } | { t: "ready" } | { t: "fail" };

// HOST
// the page side of the mirage: events, size and visibility in, numbers out. the scene
// runs in a worker when the canvas can be handed over, so the gpu warming up, compiling
// and drawing never hold up the page; otherwise it runs here
export function mount(canvas: HTMLCanvasElement, sink: Sink) {
  const cleanups: (() => void)[] = [];
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  const forceGl = new URLSearchParams(location.search).has("gl");
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
    const post = (msg: ToWorker, transfer?: Transferable[]) =>
      transfer ? worker.postMessage(msg, transfer) : worker.postMessage(msg);
    post({ t: "init", canvas: off, reduced: mq.matches, forceGl }, [off]);
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const d = e.data;
      if (d.t === "state") sink.state(d.d, d.a);
      else if (d.t === "ready") sink.ready();
      else fail();
    };
    worker.onerror = fail;
    return Promise.resolve({
      size: (w, h, dpr) => post({ t: "size", w, h, dpr }),
      avoid: (b) => post({ t: "avoid", b: Array.from(b) }),
      show: (v) => post({ t: "show", v }),
      motion: (v) => post({ t: "motion", v }),
      point: (x) => post({ t: "point", x }),
      down: (y) => post({ t: "down", y }),
      drag: (y) => post({ t: "drag", y }),
      up: () => post({ t: "up" }),
      leave: () => post({ t: "leave" }),
      wheel: (px) => post({ t: "wheel", px }),
      keys: (dir) => post({ t: "keys", dir }),
      dispose: () => worker.terminate(),
    });
  }

  async function inPage(): Promise<Driver> {
    const { Mirage } = await import("./mirage");
    const m = new Mirage(canvas, { reducedMotion: mq.matches, forceGl });
    // only touch the dom when a shown number changes
    let d = -1;
    let a = -1;
    m.onState = (travelled, ahead) => {
      const nd = Math.round(travelled);
      const na = Math.round(ahead);
      if (nd === d && na === a) return;
      d = nd;
      a = na;
      sink.state(d, a);
    };
    m.onReady = sink.ready;
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

  // EVENTS
  function wire(d: Driver) {
    let onScreen = false;
    let rect = canvas.getBoundingClientRect();
    let keys = 0; // bit 1 forward, bit 2 back
    let dragId = -1;
    const show = () => d.show(onScreen && !document.hidden);
    const ro = new ResizeObserver(() => {
      rect = canvas.getBoundingClientRect();
      d.size(rect.width, rect.height, devicePixelRatio);
      keepClear();
    });
    // FRAMING
    // the text in the bottom corners, for the scene to frame the road between
    const boxes: number[] = [];
    const keepClear = () =>
      d.avoid(textBoxes(sink.avoid, rect.width || 1, rect.height || 1, boxes));
    document.fonts?.ready.then(() => {
      if (!dead) keepClear();
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      show();
    });
    io.observe(canvas);

    const point = (e: PointerEvent) => d.point((e.clientX - rect.left) / (rect.width || 1));
    const move = (e: PointerEvent) => {
      point(e);
      if (e.pointerId === dragId) d.drag(e.clientY);
    };
    const down = (e: PointerEvent) => {
      canvas.setPointerCapture?.(e.pointerId);
      dragId = e.pointerId;
      point(e);
      d.down(e.clientY);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== dragId) return;
      dragId = -1;
      d.up();
    };
    const leave = () => {
      dragId = -1;
      d.leave();
    };
    const wheel = (e: WheelEvent) =>
      d.wheel(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY);
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const bit = k === "arrowup" || k === "w" ? 1 : k === "arrowdown" || k === "s" ? 2 : 0;
      if (!bit) return;
      e.preventDefault();
      if (e.type === "keydown") keys |= bit;
      else keys &= ~bit;
      d.keys((keys & 1 ? 1 : 0) - (keys & 2 ? 1 : 0));
    };
    const blur = () => {
      keys = 0;
      dragId = -1;
      d.keys(0);
      d.up();
    };
    const onMotion = () => d.motion(mq.matches);

    const opts = { passive: true };
    canvas.addEventListener("pointermove", move, opts);
    canvas.addEventListener("pointerdown", down, opts);
    canvas.addEventListener("pointerup", up, opts);
    canvas.addEventListener("pointercancel", up, opts);
    canvas.addEventListener("pointerleave", leave, opts);
    addEventListener("wheel", wheel, opts);
    addEventListener("keydown", key);
    addEventListener("keyup", key);
    addEventListener("blur", blur);
    document.addEventListener("visibilitychange", show);
    mq.addEventListener("change", onMotion);
    cleanups.push(
      () => ro.disconnect(),
      () => io.disconnect(),
      () => canvas.removeEventListener("pointermove", move),
      () => canvas.removeEventListener("pointerdown", down),
      () => canvas.removeEventListener("pointerup", up),
      () => canvas.removeEventListener("pointercancel", up),
      () => canvas.removeEventListener("pointerleave", leave),
      () => removeEventListener("wheel", wheel),
      () => removeEventListener("keydown", key),
      () => removeEventListener("keyup", key),
      () => removeEventListener("blur", blur),
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
