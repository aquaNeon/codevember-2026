// STAGE
// the page side: watches size, visibility and the pointer, and passes them to the scene.
// the scene runs in a worker on an offscreen canvas where it can, on this thread otherwise

export type ToWorker =
  | { t: "init"; canvas: OffscreenCanvas; reduced: boolean; at: number; bg: number }
  | { t: "size"; w: number; h: number; dpr: number }
  | { t: "show"; v: boolean }
  | { t: "motion"; v: boolean }
  | { t: "down"; x: number; y: number; touch: boolean }
  | { t: "move"; x: number; y: number }
  | { t: "up" }
  | { t: "leave" }
  | { t: "angle"; v: number }
  | { t: "dispose" };

export type FromWorker = { t: "shown" } | { t: "lost" } | { t: "light"; l: string };

export class Stage {
  onShown: () => void = () => {};
  onLost: () => void = () => {};
  onLight: (light: string) => void = () => {};

  private cleanups: (() => void)[] = [];
  private left = 0;
  private top = 0;
  private visible = false;
  private dead = false;
  private pointer = -1;

  private constructor(
    private canvas: HTMLCanvasElement,
    private post: (m: ToWorker) => void,
  ) {}

  static async create(canvas: HTMLCanvasElement, at = 0, bg = 0) {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    let stage: Stage;
    if ("transferControlToOffscreen" in canvas && "OffscreenCanvas" in window) {
      const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      const off = canvas.transferControlToOffscreen();
      stage = new Stage(canvas, (m) => worker.postMessage(m));
      worker.onmessage = (e: MessageEvent<FromWorker>) => stage.hear(e.data);
      worker.onerror = () => stage.hear({ t: "lost" });
      worker.postMessage(
        { t: "init", canvas: off, reduced: mq.matches, at, bg } satisfies ToWorker,
        [off],
      );
      stage.cleanups.push(() => setTimeout(() => worker.terminate(), 1000));
    } else {
      const [{ Cocoon }, { apply }] = await Promise.all([import("./cocoon"), import("./apply")]);
      const c = new Cocoon(canvas, mq.matches, at, bg);
      stage = new Stage(canvas, (m) => apply(c, m));
      c.onShown = () => stage.hear({ t: "shown" });
      c.onLost = () => stage.hear({ t: "lost" });
      c.onLight = (l) => stage.hear({ t: "light", l });
    }
    stage.watch(mq);
    return stage;
  }

  angle(v: number) {
    this.post({ t: "angle", v });
  }

  private hear(m: FromWorker) {
    if (this.dead) return;
    if (m.t === "shown") this.onShown();
    else if (m.t === "light") this.onLight(m.l);
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
    c.addEventListener("pointercancel", this.cancel, opts);
    c.addEventListener("pointerleave", this.leave, opts);

    this.cleanups.push(
      () => ro.disconnect(),
      () => io.disconnect(),
      () => document.removeEventListener("visibilitychange", show),
      () => mq.removeEventListener("change", onMotion),
      () => c.removeEventListener("pointerdown", this.down),
      () => c.removeEventListener("pointermove", this.move),
      () => c.removeEventListener("pointerup", this.up),
      () => c.removeEventListener("pointercancel", this.cancel),
      () => c.removeEventListener("pointerleave", this.leave),
    );
  }

  // INPUT
  // a mouse carries the light as it moves; a finger drags it and leaves it where it lifts
  private down = (e: PointerEvent) => {
    if (!e.isPrimary || this.pointer !== -1) return;
    this.pointer = e.pointerId;
    if (e.pointerType !== "mouse") this.canvas.setPointerCapture(e.pointerId);
    const touch = e.pointerType !== "mouse";
    this.post({ t: "down", x: e.clientX - this.left, y: e.clientY - this.top, touch });
  };

  private move = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" && e.pointerId !== this.pointer) return;
    this.post({ t: "move", x: e.clientX - this.left, y: e.clientY - this.top });
  };

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    this.pointer = -1;
    this.post({ t: "up" });
  };

  private cancel = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    this.pointer = -1;
    this.post({ t: "up" });
  };

  private leave = (e: PointerEvent) => {
    if (e.pointerType === "mouse") this.post({ t: "leave" });
  };

  dispose() {
    if (this.dead) return;
    this.post({ t: "dispose" });
    this.dead = true;
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
  }
}
