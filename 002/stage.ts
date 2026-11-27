import type { Phase, Shatter } from "./shatter";

// STAGE
// page side: size, visibility, pointer, wheel; scene in a worker when OffscreenCanvas allows

export type ToScene =
  | { t: "init"; canvas: OffscreenCanvas; reduced: boolean; at: number }
  | { t: "size"; w: number; h: number; dpr: number }
  | { t: "show"; v: boolean }
  | { t: "motion"; v: boolean }
  | { t: "tap"; x: number; y: number }
  | { t: "hover"; x: number; y: number }
  | { t: "nudge"; s: number }
  | { t: "seek"; s: number }
  | { t: "go" }
  | { t: "pol"; v: boolean }
  | { t: "leave" }
  | { t: "dispose" };

export type FromScene =
  | { t: "shown" }
  | { t: "lost" }
  | {
      t: "state";
      time: number;
      real: number;
      pieces: number;
      phase: Phase;
      over: boolean;
      dur: number;
    };

const TAP_PX = 8;
const WHEEL_S_PER_PX = 0.004;
const DRAG_S_PER_PX = 0.006;
const LINE_PX = 16;

export function apply(c: Shatter, m: ToScene) {
  if (m.t === "size") c.size(m.w, m.h, m.dpr);
  else if (m.t === "show") c.show(m.v);
  else if (m.t === "motion") c.motion(m.v);
  else if (m.t === "tap") c.tap(m.x, m.y);
  else if (m.t === "hover") c.hover(m.x, m.y);
  else if (m.t === "nudge") c.nudge(m.s);
  else if (m.t === "seek") c.seek(m.s);
  else if (m.t === "go") c.go();
  else if (m.t === "pol") c.polarise(m.v);
  else if (m.t === "leave") c.leave();
  else if (m.t === "dispose") c.dispose();
}

export class Stage {
  onShown: () => void = () => {};
  onLost: () => void = () => {};
  onState: (m: Extract<FromScene, { t: "state" }>) => void = () => {};

  private cleanups: (() => void)[] = [];
  private left = 0;
  private top = 0;
  private visible = false;
  private dead = false;
  private pointer = -1;
  private downX = 0;
  private downY = 0;
  private lastY = 0;
  private dragging = false;

  private constructor(
    private canvas: HTMLCanvasElement,
    readonly post: (m: ToScene) => void,
  ) {}

  static async create(canvas: HTMLCanvasElement, at = -1) {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    let stage: Stage;
    if ("transferControlToOffscreen" in canvas && "OffscreenCanvas" in window) {
      const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      const off = canvas.transferControlToOffscreen();
      stage = new Stage(canvas, (m) => worker.postMessage(m));
      worker.onmessage = (e: MessageEvent<FromScene>) => stage.hear(e.data);
      worker.onerror = () => stage.hear({ t: "lost" });
      worker.postMessage({ t: "init", canvas: off, reduced: mq.matches, at } satisfies ToScene, [
        off,
      ]);
      stage.cleanups.push(() => setTimeout(() => worker.terminate(), 1000));
    } else {
      const { Shatter } = await import("./shatter");
      const c = new Shatter(canvas, mq.matches, at);
      stage = new Stage(canvas, (m) => apply(c, m));
      c.onShown = () => stage.hear({ t: "shown" });
      c.onLost = () => stage.hear({ t: "lost" });
      c.onState = (time, real, pieces, phase, over, dur) =>
        stage.hear({ t: "state", time, real, pieces, phase, over, dur });
    }
    stage.watch(mq);
    return stage;
  }

  private hear(m: FromScene) {
    if (this.dead) return;
    if (m.t === "shown") this.onShown();
    else if (m.t === "state") {
      this.canvas.style.cursor = m.over ? "pointer" : "";
      this.onState(m);
    } else this.onLost();
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
    addEventListener("wheel", this.wheel, opts);
    c.addEventListener("keydown", this.key);

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
      () => removeEventListener("wheel", this.wheel),
      () => c.removeEventListener("keydown", this.key),
    );
  }

  // INPUT
  // tap breaks at the hit point; vertical drag or wheel scrubs time
  private down = (e: PointerEvent) => {
    if (!e.isPrimary || this.pointer !== -1) return;
    this.pointer = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.lastY = e.clientY;
    this.dragging = false;
  };

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) {
      if (e.pointerType === "mouse" && this.pointer === -1)
        this.post({ t: "hover", x: e.clientX - this.left, y: e.clientY - this.top });
      return;
    }
    if (!this.dragging && Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > TAP_PX)
      this.dragging = true;
    if (this.dragging) this.post({ t: "nudge", s: (this.lastY - e.clientY) * DRAG_S_PER_PX });
    this.lastY = e.clientY;
  };

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    this.pointer = -1;
    if (!this.dragging) this.post({ t: "tap", x: e.clientX - this.left, y: e.clientY - this.top });
  };

  private cancel = (e: PointerEvent) => {
    if (e.pointerId === this.pointer) this.pointer = -1;
  };

  private leave = (e: PointerEvent) => {
    if (e.pointerType === "mouse") this.post({ t: "leave" });
  };

  private wheel = (e: WheelEvent) => {
    const px = e.deltaY * (e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? innerHeight : 1);
    if (px) this.post({ t: "nudge", s: px * WHEEL_S_PER_PX });
  };

  private key = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.post({ t: "go" });
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      this.post({ t: "nudge", s: e.key === "ArrowRight" ? 0.1 : -0.1 });
    }
  };

  dispose() {
    if (this.dead) return;
    this.post({ t: "dispose" });
    this.dead = true;
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
  }
}
