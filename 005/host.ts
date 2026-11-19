import type { Opts } from "./gl";
import type { Lichen } from "./lichen";

export type Sink = {
  state: (colonies: number, growing: boolean) => void;
  shown: () => void;
  fail: () => void;
};

// the calls the page makes on the scene, the same in a worker or in the page
export const CALLS = [
  "size",
  "visibility",
  "motion",
  "avoid",
  "plant",
  "plantSomewhere",
  "wipe",
] as const;
type Call = (typeof CALLS)[number];
type Driver = Pick<Lichen, Call | "dispose">;

export type ToWorker =
  { t: "init"; canvas: OffscreenCanvas; opts: Opts } | { t: Call; a: unknown[] };
export type FromWorker =
  { t: "state"; n: number; growing: boolean } | { t: "shown" } | { t: "fail" };

// HOST
// dom side of the stone: size, visibility, input and the title and hud boxes in, state out.
// the scene runs in a worker when the canvas can be handed over, so compiling and drawing
// never block the page; otherwise it runs here
export function mount(canvas: HTMLCanvasElement, avoid: HTMLElement[], sink: Sink, opts: Opts) {
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
      if (d.t === "state") sink.state(d.n, d.growing);
      else if (d.t === "shown") sink.shown();
      else fail();
    };
    worker.onerror = fail;
    const d = { dispose: () => worker.terminate() } as Record<string, unknown>;
    for (const t of CALLS) d[t] = (...a: unknown[]) => worker.postMessage({ t, a });
    return Promise.resolve(d as unknown as Driver);
  }

  async function inPage(): Promise<Driver> {
    const { Lichen } = await import("./lichen");
    const l = new Lichen(canvas, opts);
    l.onState = sink.state;
    l.onShown = sink.shown;
    const lost = (e: Event) => {
      e.preventDefault();
      fail();
    };
    canvas.addEventListener("webglcontextlost", lost);
    cleanups.push(() => canvas.removeEventListener("webglcontextlost", lost));
    return l;
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
    const boxes: number[] = [];
    const measure = () => {
      rect = canvas.getBoundingClientRect();
      boxes.length = 0;
      for (const el of avoid) {
        const b = el.getBoundingClientRect();
        boxes.push(
          (b.left - rect.left) / rect.width,
          (b.top - rect.top) / rect.height,
          (b.right - rect.left) / rect.width,
          (b.bottom - rect.top) / rect.height,
        );
      }
      d.avoid(boxes);
    };
    const show = () => d.visibility(onScreen && !document.hidden);
    const ro = new ResizeObserver(() => {
      measure();
      d.size(canvas.clientWidth, canvas.clientHeight, devicePixelRatio);
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      show();
    });
    io.observe(canvas);
    const onMotion = () => d.motion(mq.matches);
    const down = (e: PointerEvent) => {
      rect = canvas.getBoundingClientRect();
      d.plant((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      d.plantSomewhere();
    };
    canvas.addEventListener("pointerdown", down, { passive: true });
    canvas.addEventListener("keydown", key);
    document.addEventListener("visibilitychange", show);
    mq.addEventListener("change", onMotion);
    cleanups.push(
      () => ro.disconnect(),
      () => io.disconnect(),
      () => canvas.removeEventListener("pointerdown", down),
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
    plant: (x: number, y: number, s: number) => driver?.plant(x, y, s, true),
    wipe: () => driver?.wipe(),
    dispose,
  };
}
