import type { Look, Spore } from "./spore";

export type Sink = {
  puff: (n: number) => void;
  labels: (xy: number[]) => void;
  fail: () => void;
};

export type Call = "size" | "show" | "down" | "move" | "up" | "poke" | "motion";
type Driver = Pick<Spore, Call | "dispose">;

export type ToWorker =
  | { t: "init"; canvas: OffscreenCanvas; look: Look; reduced: boolean; forceGl: boolean }
  | { t: "call"; m: Call; a: (number | boolean)[] };

export type FromWorker =
  | { t: "puff"; n: number }
  | { t: "labels"; xy: number[] }
  | { t: "cursor"; c: string }
  | { t: "shown" }
  | { t: "fail" };

// HOST
// scene runs in a worker when the canvas can transfer, otherwise on the page
export function mount(
  canvas: HTMLCanvasElement,
  look: Look,
  sink: Sink,
  panel: HTMLElement | null = null,
) {
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
    const init: ToWorker = { t: "init", canvas: off, look, reduced: mq.matches, forceGl };
    worker.postMessage(init, [off]);
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const d = e.data;
      if (d.t === "puff") sink.puff(d.n);
      else if (d.t === "labels") sink.labels(d.xy);
      else if (d.t === "cursor") cursor(d.c);
      else if (d.t === "shown") shown();
      else fail();
    };
    worker.onerror = fail;
    const call =
      (m: Call) =>
      (...a: (number | boolean)[]) =>
        worker.postMessage({ t: "call", m, a } satisfies ToWorker);
    return Promise.resolve({
      size: call("size"),
      show: call("show"),
      down: call("down"),
      move: call("move"),
      up: call("up"),
      poke: call("poke"),
      motion: call("motion"),
      dispose: () => worker.terminate(),
    });
  }

  async function inPage(): Promise<Driver> {
    const { Spore } = await import("./spore");
    const s = new Spore(canvas, { look, reducedMotion: mq.matches, forceGl });
    s.onPuff = sink.puff;
    s.onLabels = sink.labels;
    s.onCursor = cursor;
    s.onShown = shown;
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
    const show = () => d.show(onScreen && !document.hidden);
    const ro = new ResizeObserver(() => {
      rect = canvas.getBoundingClientRect();
      const p = panel?.getBoundingClientRect();
      const x = p ? p.left - rect.left : 0;
      const y = p ? p.top - rect.top : 0;
      d.size(
        canvas.clientWidth,
        canvas.clientHeight,
        devicePixelRatio,
        x,
        y,
        p?.width ?? 0,
        p?.height ?? 0,
      );
    });
    ro.observe(canvas);
    if (panel) ro.observe(panel);
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      show();
    });
    io.observe(canvas);
    const onMotion = () => d.motion(mq.matches);

    const opts = { passive: true };
    const down = (e: PointerEvent) => {
      rect = canvas.getBoundingClientRect();
      canvas.setPointerCapture?.(e.pointerId);
      d.down(e.clientX - rect.left, e.clientY - rect.top, e.pointerId);
    };
    const move = (e: PointerEvent) =>
      d.move(e.clientX - rect.left, e.clientY - rect.top, e.pointerType === "mouse");
    const up = (e: PointerEvent) => d.up(e.pointerId);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      d.poke();
    };
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
    poke: () => driver?.poke(),
    dispose,
  };
}
