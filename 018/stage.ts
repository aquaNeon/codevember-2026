// STAGE
// page side: size, visibility, pointer; scene in a worker when possible, else here

const TAP_MS = 250;
const TAP_PX = 6;
const KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", " "]);

export type ToWorker =
  | { t: "init"; canvas: OffscreenCanvas; reduced: boolean }
  | { t: "size"; w: number; h: number; dpr: number }
  | { t: "show"; v: boolean }
  | { t: "motion"; v: boolean }
  | { t: "down"; x: number; y: number; ms: number }
  | { t: "move"; x: number; y: number; ms: number }
  | { t: "up"; x: number; tap: boolean; ms: number }
  | { t: "key"; k: string }
  | { t: "spin" }
  | { t: "dispose" };

export type FromWorker = { t: "shown" } | { t: "lost" };

export class Stage {
  onShown: () => void = () => {};
  onLost: () => void = () => {};

  private cleanups: (() => void)[] = [];
  private left = 0;
  private top = 0;
  private pointer = -1;
  private downX = 0;
  private downY = 0;
  private downT = 0;
  private visible = false;
  private dead = false;

  private constructor(
    private canvas: HTMLCanvasElement,
    private post: (m: ToWorker) => void,
  ) {}

  static async create(canvas: HTMLCanvasElement) {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    let stage: Stage;
    if ("transferControlToOffscreen" in canvas && "OffscreenCanvas" in window) {
      const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      const off = canvas.transferControlToOffscreen();
      stage = new Stage(canvas, (m) => worker.postMessage(m));
      worker.onmessage = (e: MessageEvent<FromWorker>) => stage.hear(e.data);
      worker.onerror = () => stage.hear({ t: "lost" });
      worker.postMessage({ t: "init", canvas: off, reduced: mq.matches } satisfies ToWorker, [off]);
      stage.cleanups.push(() => setTimeout(() => worker.terminate(), 1000));
    } else {
      const [{ Pendulum }, { apply }] = await Promise.all([
        import("./pendulum"),
        import("./apply"),
      ]);
      const p = new Pendulum(canvas, mq.matches);
      stage = new Stage(canvas, (m) => apply(p, m));
      p.onShown = () => stage.onShown();
      p.onLost = () => stage.onLost();
    }
    stage.watch(mq);
    return stage;
  }

  spin() {
    this.post({ t: "spin" });
  }

  private hear(m: FromWorker) {
    if (this.dead) return;
    if (m.t === "shown") this.onShown();
    else this.onLost();
  }

  // OBSERVERS
  private watch(mq: MediaQueryList) {
    const c = this.canvas;
    const ro = new ResizeObserver(([e]) => {
      const r = c.getBoundingClientRect();
      this.left = r.left;
      this.top = r.top;
      const box = e.contentRect;
      this.post({ t: "size", w: box.width, h: box.height, dpr: window.devicePixelRatio || 1 });
    });
    ro.observe(c);
    const show = () => this.post({ t: "show", v: this.visible && !document.hidden });
    const io = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      show();
    });
    io.observe(c);
    const onMotion = () => this.post({ t: "motion", v: mq.matches });
    document.addEventListener("visibilitychange", show);
    mq.addEventListener("change", onMotion);

    const opts = { passive: true };
    c.addEventListener("pointerdown", this.down, opts);
    c.addEventListener("pointermove", this.move, opts);
    c.addEventListener("pointerup", this.up, opts);
    c.addEventListener("pointercancel", this.up, opts);
    c.addEventListener("keydown", this.key);

    this.cleanups.push(
      () => ro.disconnect(),
      () => io.disconnect(),
      () => document.removeEventListener("visibilitychange", show),
      () => mq.removeEventListener("change", onMotion),
      () => c.removeEventListener("pointerdown", this.down),
      () => c.removeEventListener("pointermove", this.move),
      () => c.removeEventListener("pointerup", this.up),
      () => c.removeEventListener("pointercancel", this.up),
      () => c.removeEventListener("keydown", this.key),
    );
  }

  // INPUT
  private down = (e: PointerEvent) => {
    if (this.pointer !== -1) return;
    this.pointer = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = "grabbing";
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.downT = performance.now();
    this.post({ t: "down", x: e.clientX - this.left, y: e.clientY - this.top, ms: e.timeStamp });
  };

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    this.post({ t: "move", x: e.clientX - this.left, y: e.clientY - this.top, ms: e.timeStamp });
  };

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    this.pointer = -1;
    this.canvas.style.cursor = "";
    const tap =
      performance.now() - this.downT < TAP_MS &&
      Math.hypot(e.clientX - this.downX, e.clientY - this.downY) < TAP_PX;
    this.post({ t: "up", x: e.clientX - this.left, tap, ms: e.timeStamp });
  };

  private key = (e: KeyboardEvent) => {
    if (!KEYS.has(e.key)) return;
    e.preventDefault();
    this.post({ t: "key", k: e.key });
  };

  dispose() {
    if (this.dead) return;
    this.post({ t: "dispose" });
    this.dead = true;
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
  }
}
