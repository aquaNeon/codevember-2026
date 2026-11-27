import type { Opts } from "./gl";
import type { Hud, Veil } from "./veil";

export type Sink = {
  hud: (h: Hud) => void;
  shown: () => void;
  fail: () => void;
};

export const CALLS = ["size", "visibility", "motion", "point", "leave"] as const;
type Call = (typeof CALLS)[number];
type Driver = Pick<Veil, Call | "dispose">;

export type ToWorker =
  { t: "init"; canvas: OffscreenCanvas; opts: Opts } | { t: Call; a: unknown[] };
export type FromWorker = { t: "hud"; h: Hud } | { t: "shown" } | { t: "fail" };

// HOST
// dom side: size, visibility, pointer in, hud out; the veil runs in a worker when it can
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
    const { Veil } = await import("./veil");
    const v = new Veil(canvas, opts);
    if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { veil: v });
    v.onHud = sink.hud;
    v.onShown = sink.shown;
    const lost = (e: Event) => {
      e.preventDefault();
      fail();
    };
    canvas.addEventListener("webglcontextlost", lost);
    cleanups.push(() => canvas.removeEventListener("webglcontextlost", lost));
    return v;
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
    // mouse moves the air on hover; touch drags it
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" && e.buttons === 0) return;
      d.point(e.clientX - rect.left, e.clientY - rect.top, e.timeStamp);
    };
    const leave = () => d.leave();
    const opts = { passive: true };
    addEventListener("pointermove", move, opts);
    addEventListener("pointerdown", move, opts);
    addEventListener("pointerup", leave, opts);
    addEventListener("pointercancel", leave, opts);
    document.documentElement.addEventListener("pointerleave", leave, opts);
    document.addEventListener("visibilitychange", show);
    mq.addEventListener("change", onMotion);
    cleanups.push(
      () => ro.disconnect(),
      () => io.disconnect(),
      () => removeEventListener("pointermove", move),
      () => removeEventListener("pointerdown", move),
      () => removeEventListener("pointerup", leave),
      () => removeEventListener("pointercancel", leave),
      () => document.documentElement.removeEventListener("pointerleave", leave),
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
