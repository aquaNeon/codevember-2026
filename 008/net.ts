const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const EYE_4D = 4;
const EYE_3D = 16;
const PITCH_RAD = 0.34;
const MAX_PITCH_RAD = 0.9;
const FIT = 0.074;
const FIT_NARROW = 0.095;
const FOLDED_ZOOM = 1.45;
const YAW_RAD_S = 0.11;
const FOLD_PERIOD_S = 16;
const SCRUB_PX = 0.0032;
const TILT_RAD_PX = 0.004;
const LINE_PX = 1.1;
const GLASS_ALPHA = 0.34;
const SHADE_ALPHA = 0.55;
const HATCH_PX = 5;
const INK = "rgb(38 28 19)";
const TINTS = [
  "#d8b675",
  "#a8b896",
  "#9cadc3",
  "#d3a395",
  "#b6a6c8",
  "#cbbd9a",
  "#97bfb5",
  "#c89874",
];

// NET
// double-cross net; each cell folds about its parent face, in its axis-w plane
interface Cell {
  at: [number, number, number];
  folds: [number, number, number, number][];
}
const CELLS: Cell[] = [
  { at: [0, 0, 0], folds: [] },
  { at: [2, 0, 0], folds: [[0, 1, 1, 0]] },
  { at: [-2, 0, 0], folds: [[0, -1, -1, 0]] },
  { at: [0, 0, 2], folds: [[2, 1, 1, 0]] },
  { at: [0, 0, -2], folds: [[2, -1, -1, 0]] },
  { at: [0, 2, 0], folds: [[1, 1, 1, 0]] },
  { at: [0, -2, 0], folds: [[1, -1, -1, 0]] },
  {
    at: [0, -4, 0],
    folds: [
      [1, -1, -3, 1],
      [1, -1, -1, 0],
    ],
  },
];
const N_CELLS = CELLS.length;
const N_VERTS = N_CELLS * 8;
const N_FACES = N_CELLS * 6;
const FACE = new Uint8Array(N_FACES * 4);
for (let c = 0; c < N_CELLS; c++)
  for (let a = 0; a < 3; a++)
    for (let s = 0; s < 2; s++) {
      const b = (a + 1) % 3;
      const d = (a + 2) % 3;
      const o = (c * 6 + a * 2 + s) * 4;
      const corner = (u: number, v: number) => c * 8 + ((s << a) | (u << b) | (v << d));
      FACE[o] = corner(0, 0);
      FACE[o + 1] = corner(1, 0);
      FACE[o + 2] = corner(1, 1);
      FACE[o + 3] = corner(0, 1);
    }

export class Net {
  private ctx: CanvasRenderingContext2D;
  private hatch: CanvasPattern | null = null;
  private raf = 0;
  private last = 0;
  private visible = false;
  private sized = false;
  private reducedMotion: boolean;
  private cleanups: (() => void)[] = [];
  private dpr = 1;
  private w = 1;
  private h = 1;
  private cx = 0;
  private cy = 0;
  private unit = 1;
  private dirty = true;

  // STATE
  private phase = 0.18;
  private fold = cycle(0.18);
  private yaw = 0.6;
  private pitch = PITCH_RAD;
  private pointer = -1;
  private px = 0;
  private py = 0;
  private reported = NaN;

  private p4 = new Float64Array(4);
  private vx = new Float64Array(N_VERTS);
  private vy = new Float64Array(N_VERTS);
  private vz = new Float64Array(N_VERTS);
  private sx = new Float64Array(N_VERTS);
  private sy = new Float64Array(N_VERTS);
  private sf = new Float64Array(N_VERTS);
  private depth = new Float64Array(N_FACES);
  private shade = new Float64Array(N_FACES);
  private order = new Uint8Array(N_FACES);

  onState: (fold: number, turn: number) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d unavailable");
    this.ctx = ctx;
    for (let i = 0; i < N_FACES; i++) this.order[i] = i;

    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion = mq.matches;
    const onMotion = () => {
      this.reducedMotion = mq.matches;
      this.wake();
    };
    mq.addEventListener("change", onMotion);

    const ro = new ResizeObserver(() => this.queueResize());
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      this.wake();
    });
    io.observe(canvas);
    const onVisibility = () => {
      this.last = 0;
      this.wake();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const opts = { passive: true };
    canvas.addEventListener("pointerdown", this.down, opts);
    canvas.addEventListener("pointermove", this.move, opts);
    canvas.addEventListener("pointerup", this.up, opts);
    canvas.addEventListener("pointercancel", this.up, opts);
    canvas.addEventListener("keydown", this.key);

    this.cleanups.push(
      () => mq.removeEventListener("change", onMotion),
      () => ro.disconnect(),
      () => io.disconnect(),
      () => document.removeEventListener("visibilitychange", onVisibility),
      () => canvas.removeEventListener("pointerdown", this.down),
      () => canvas.removeEventListener("pointermove", this.move),
      () => canvas.removeEventListener("pointerup", this.up),
      () => canvas.removeEventListener("pointercancel", this.up),
      () => canvas.removeEventListener("keydown", this.key),
    );
  }

  // LOOP
  private wake() {
    if (!this.raf && this.visible && !document.hidden) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible || document.hidden) return;
    const dt = this.last ? Math.min(MAX_DT_S, (now - this.last) / 1000) : 0;
    this.last = now;
    if (!this.sized) this.resize();
    this.step(dt);
    if (this.dirty) this.draw();
    if (this.animating()) this.wake();
    else this.last = 0;
  };

  private step(dt: number) {
    if (this.reducedMotion || !dt) return;
    this.yaw += YAW_RAD_S * dt;
    if (this.pointer === -1) {
      this.phase = (this.phase + dt / FOLD_PERIOD_S) % 1;
      this.fold = cycle(this.phase);
    }
    this.dirty = true;
  }

  private animating() {
    return this.dirty || (!this.reducedMotion && this.pointer === -1);
  }

  // DRAW
  private place() {
    const f = this.fold;
    const main = ease(clamp01((f - 0.3) / 0.7)) * Math.PI * 0.5;
    const tail = ease(clamp01(f / 0.55)) * Math.PI * 0.5;
    const c0 = Math.cos(main);
    const s0 = Math.sin(main);
    const c1 = Math.cos(tail);
    const s1 = Math.sin(tail);
    const cyaw = Math.cos(this.yaw);
    const syaw = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const lift = 1 - ease(f);
    const p = this.p4;
    for (let k = 0; k < N_CELLS; k++) {
      const cell = CELLS[k];
      for (let v = 0; v < 8; v++) {
        p[0] = cell.at[0] + (v & 1 ? 1 : -1);
        p[1] = cell.at[1] + (v & 2 ? 1 : -1);
        p[2] = cell.at[2] + (v & 4 ? 1 : -1);
        p[3] = -1;
        for (let n = 0; n < cell.folds.length; n++) {
          const [axis, side, hinge, which] = cell.folds[n];
          const c = which ? c1 : c0;
          const s = which ? s1 : s0;
          const u = side * (p[axis] - hinge);
          const dw = p[3] + 1;
          p[axis] = hinge + side * (u * c - dw * s);
          p[3] = u * s + dw * c - 1;
        }
        const f4 = EYE_4D / (EYE_4D - p[3]);
        const X = p[0] * f4;
        const Y = (p[1] + lift) * f4;
        const Z = p[2] * f4;
        const x = cyaw * X + syaw * Z;
        const z0 = -syaw * X + cyaw * Z;
        const y = cp * Y - sp * z0;
        const z = sp * Y + cp * z0;
        const i = k * 8 + v;
        const f3 = EYE_3D / (EYE_3D - z);
        this.vx[i] = x;
        this.vy[i] = y;
        this.vz[i] = z;
        this.sx[i] = this.cx + x * f3 * this.unit;
        this.sy[i] = this.cy - y * f3 * this.unit;
        this.sf[i] = f4 * f3;
      }
    }
  }

  private draw() {
    this.dirty = false;
    const zoom = 1 + (FOLDED_ZOOM - 1) * ease(this.fold);
    this.unit = Math.min(this.w, this.h) * (this.w < this.h ? FIT_NARROW : FIT) * zoom;
    this.place();
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.clearRect(0, 0, this.w, this.h);

    // FACES
    // back to front; two-sided lighting, the glass is clear
    for (let f = 0; f < N_FACES; f++) {
      const a = FACE[f * 4];
      const b = FACE[f * 4 + 1];
      const d = FACE[f * 4 + 3];
      const ux = this.vx[b] - this.vx[a];
      const uy = this.vy[b] - this.vy[a];
      const uz = this.vz[b] - this.vz[a];
      const wx = this.vx[d] - this.vx[a];
      const wy = this.vy[d] - this.vy[a];
      const wz = this.vz[d] - this.vz[a];
      const nx = uy * wz - uz * wy;
      const ny = uz * wx - ux * wz;
      const nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz) || 1;
      const lit = Math.abs(-0.45 * nx + 0.72 * ny + 0.53 * nz) / l;
      this.shade[f] = 1 - lit;
      this.depth[f] = this.vz[a] + this.vz[b] + this.vz[FACE[f * 4 + 2]] + this.vz[d];
    }
    const order = this.order;
    for (let i = 1; i < N_FACES; i++) {
      const o = order[i];
      const dz = this.depth[o];
      let j = i - 1;
      while (j >= 0 && this.depth[order[j]] > dz) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = o;
    }

    ctx.strokeStyle = INK;
    for (let n = 0; n < N_FACES; n++) {
      const f = order[n];
      const cell = (f / 6) | 0;
      this.path(f);
      ctx.globalAlpha = GLASS_ALPHA;
      ctx.fillStyle = TINTS[cell];
      ctx.fill();
      const dark = this.shade[f];
      if (this.hatch && dark > 0.5) {
        ctx.globalAlpha = Math.min(1, (dark - 0.5) * 2.2) * SHADE_ALPHA;
        ctx.fillStyle = this.hatch;
        ctx.fill();
      }
      const near = (this.sf[FACE[f * 4]] + this.sf[FACE[f * 4 + 2]]) * 0.5;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = LINE_PX * dpr * Math.min(1.8, Math.pow(near / 0.75, 1.2));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const fold = Math.round(this.fold * 100);
    if (fold !== this.reported) {
      this.reported = fold;
      this.onState(fold, ((((this.yaw * 180) / Math.PI) % 360) + 360) % 360);
    }
  }

  private path(f: number) {
    const ctx = this.ctx;
    const o = f * 4;
    ctx.beginPath();
    ctx.moveTo(this.sx[FACE[o]], this.sy[FACE[o]]);
    ctx.lineTo(this.sx[FACE[o + 1]], this.sy[FACE[o + 1]]);
    ctx.lineTo(this.sx[FACE[o + 2]], this.sy[FACE[o + 2]]);
    ctx.lineTo(this.sx[FACE[o + 3]], this.sy[FACE[o + 3]]);
    ctx.closePath();
  }

  // INPUT
  // horizontal drag scrubs the fold, vertical tilts
  private down = (e: PointerEvent) => {
    if (this.pointer !== -1) return;
    this.pointer = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.px = e.clientX;
    this.py = e.clientY;
    this.canvas.style.cursor = "grabbing";
  };

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    const dx = e.clientX - this.px;
    const dy = e.clientY - this.py;
    this.px = e.clientX;
    this.py = e.clientY;
    this.scrub(-dx * SCRUB_PX);
    this.pitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, this.pitch + dy * TILT_RAD_PX));
    this.dirty = true;
    this.wake();
  };

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    this.pointer = -1;
    this.canvas.style.cursor = "";
    this.wake();
  };

  private key = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    this.scrub(e.key === "ArrowRight" ? -0.05 : 0.05);
    this.dirty = true;
    this.wake();
  };

  private scrub(d: number) {
    this.fold = Math.max(0, Math.min(1, this.fold + d));
    const half = Math.acos(1 - 2 * (1 - this.fold)) / (Math.PI * 2);
    this.phase = this.phase < 0.5 ? half : 1 - half;
  }

  // RESIZE
  private queueResize() {
    this.sized = false;
    this.dirty = true;
    this.wake();
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    this.dpr = dpr;
    this.w = Math.round(cw * dpr);
    this.h = Math.round(ch * dpr);
    if (this.canvas.width !== this.w || this.canvas.height !== this.h) {
      this.canvas.width = this.w;
      this.canvas.height = this.h;
    }
    this.cx = this.w * (cw / ch > 1.25 ? 0.56 : 0.5);
    this.cy = this.h * (cw < ch ? 0.5 : 0.46);
    this.hatch = hatching(this.ctx, Math.round(HATCH_PX * dpr), dpr);
    this.ctx.lineJoin = "round";
    this.sized = true;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
  }
}

// FOLD CYCLE
// folded at 0 and 1, flat at 0.5
function cycle(t: number) {
  return 0.5 + 0.5 * Math.cos(t * Math.PI * 2);
}

function ease(t: number) {
  return t * t * (3 - 2 * t);
}

// HATCH
// diagonal line tile for faces turned from the light
function hatching(ctx: CanvasRenderingContext2D, size: number, dpr: number) {
  const tile = document.createElement("canvas");
  tile.width = tile.height = size;
  const t = tile.getContext("2d");
  if (!t) return null;
  t.strokeStyle = INK;
  t.lineWidth = 0.9 * dpr;
  t.beginPath();
  t.moveTo(-1, size + 1);
  t.lineTo(size + 1, -1);
  t.moveTo(-1, 1);
  t.lineTo(1, -1);
  t.moveTo(size - 1, size + 1);
  t.lineTo(size + 1, size - 1);
  t.stroke();
  return ctx.createPattern(tile, "repeat");
}

function clamp01(t: number) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
