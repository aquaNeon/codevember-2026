const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const EYE_4D = 3; // distance of the 4D eye from the centre, in cube half-widths
const EYE_3D = 6.5;
const VIEW_YAW_RAD = 0.62;
const VIEW_PITCH_RAD = 0.38;
const FIT = 0.118; // cube half-width as a share of the short side
const FIT_NARROW = 0.14;
const SHIFT = 0.06; // on wide screens the figure sits right of the title
const FLOOR_Y = -3.1; // plane the figure casts its plan onto
const FLOOR_ALPHA = 0.22;
const LINE_PX = 1.25; // ink weight at the middle depth, css px
const HALO_PX = 3.2; // paper left either side of a front line where it crosses another
const DOT_PX = 2.4;
const MAX_NEAR = 1.6; // caps how heavy the nearest corner gets
const LABEL_PX = 15;
const LABEL_GAP_PX = 13;
const DRAG_RAD_PX = 0.0085;
const IDLE_XW_RAD_S = 0.16;
const IDLE_ZW_RAD_S = 0.07;
const COAST_TAU_S = 1.6;
const VEL_TAU_S = 0.07;
const MAX_VEL_RAD_S = 4;
const DASH = [3.5, 4]; // css px, scaled by dpr on resize
const NONE: number[] = [];
const INK = "rgb(38 28 19)";
const MUTED = "rgb(38 28 19 / 0.5)";
const LABELS = "ABCDEFGHIJKLMNOP";

// EDGES
// vertices are the 16 corners of [-1, 1]^4, edges join corners one coordinate apart
const VERTS = new Float64Array(64);
for (let i = 0; i < 16; i++) for (let k = 0; k < 4; k++) VERTS[i * 4 + k] = (i >> k) & 1 ? 1 : -1;
const EDGES: number[] = [];
for (let i = 0; i < 16; i++)
  for (let k = 0; k < 4; k++) if (!((i >> k) & 1)) EDGES.push(i, i | (1 << k));
const N_EDGES = EDGES.length / 2;

export class Tesseract {
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private last = 0;
  private visible = false;
  private sized = false;
  private reducedMotion: boolean;
  private cleanups: (() => void)[] = [];
  private dpr = 1;
  private w = 1;
  private h = 1;
  private unit = 1;
  private dash = DASH.slice();

  // STATE
  // one 4x4 rotation, row-major, turned a little each frame
  private m = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  private vxw = IDLE_XW_RAD_S;
  private vyw = 0;
  private xw = 0;
  private yw = 0;
  private pointer = -1;
  private px = 0;
  private py = 0;
  private pt = 0;
  private dirty = true;
  private reported = NaN;

  // scratch, filled every frame
  private sx = new Float64Array(16);
  private sy = new Float64Array(16);
  private sz = new Float64Array(16);
  private sf = new Float64Array(16);
  private fx = new Float64Array(16);
  private fy = new Float64Array(16);
  private cx = 0;
  private cy = 0;
  private depth = new Float64Array(N_EDGES);
  private order = new Uint8Array(N_EDGES);

  private view = new Float64Array(9);

  onState: (xw: number, yw: number) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d unavailable");
    this.ctx = ctx;
    for (let i = 0; i < N_EDGES; i++) this.order[i] = i;

    const cy = Math.cos(VIEW_YAW_RAD);
    const sy = Math.sin(VIEW_YAW_RAD);
    const cp = Math.cos(VIEW_PITCH_RAD);
    const sp = Math.sin(VIEW_PITCH_RAD);
    // yaw about y, then pitch about x
    this.view.set([cy, 0, sy, sp * sy, cp, -sp * cy, -cp * sy, sp, cp * cy]);

    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion = mq.matches;
    if (this.reducedMotion) this.vxw = 0;
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
    this.draw();
    if (this.animating()) this.wake();
    else this.last = 0;
  };

  private step(dt: number) {
    if (this.pointer === -1) {
      // a flick keeps spinning, then settles into the drift
      const k = 1 - Math.exp(-dt / COAST_TAU_S);
      const idle = this.reducedMotion ? 0 : 1;
      this.vxw += (IDLE_XW_RAD_S * idle - this.vxw) * k;
      this.vyw += (0 - this.vyw) * k;
      this.turn(0, 3, this.vxw * dt);
      this.turn(1, 3, this.vyw * dt);
      this.turn(2, 3, IDLE_ZW_RAD_S * idle * dt);
      this.xw += this.vxw * dt;
      this.yw += this.vyw * dt;
    }
    const key = Math.round(deg(this.xw)) * 1000 + Math.round(deg(this.yw));
    if (key !== this.reported) {
      this.reported = key;
      this.onState(deg(this.xw), deg(this.yw));
    }
  }

  private animating() {
    if (this.dirty) return true;
    if (this.pointer !== -1) return false;
    return !this.reducedMotion || Math.abs(this.vxw) + Math.abs(this.vyw) > 1e-4;
  }

  // rotate the frame by a in the plane of axes i and j
  private turn(i: number, j: number, a: number) {
    if (!a) return;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const m = this.m;
    for (let col = 0; col < 4; col++) {
      const mi = m[i * 4 + col];
      const mj = m[j * 4 + col];
      m[i * 4 + col] = c * mi - s * mj;
      m[j * 4 + col] = s * mi + c * mj;
    }
    this.dirty = true;
  }

  // DRAW
  private project() {
    const m = this.m;
    const v = this.view;
    for (let i = 0; i < 16; i++) {
      const a = VERTS[i * 4];
      const b = VERTS[i * 4 + 1];
      const c = VERTS[i * 4 + 2];
      const d = VERTS[i * 4 + 3];
      const x = m[0] * a + m[1] * b + m[2] * c + m[3] * d;
      const y = m[4] * a + m[5] * b + m[6] * c + m[7] * d;
      const z = m[8] * a + m[9] * b + m[10] * c + m[11] * d;
      const w = m[12] * a + m[13] * b + m[14] * c + m[15] * d;
      // 4D to 3D: what lies further along w shrinks toward the centre
      const f4 = EYE_4D / (EYE_4D - w);
      const X = x * f4;
      const Y = y * f4;
      const Z = z * f4;
      const vx = v[0] * X + v[1] * Y + v[2] * Z;
      const vy = v[3] * X + v[4] * Y + v[5] * Z;
      const vz = v[6] * X + v[7] * Y + v[8] * Z;
      const f3 = EYE_3D / (EYE_3D - vz);
      this.sx[i] = this.cx + vx * f3 * this.unit;
      this.sy[i] = this.cy - vy * f3 * this.unit;
      // its plan, dropped straight down onto the floor
      const fy = v[3] * X + v[4] * FLOOR_Y + v[5] * Z;
      const fz = v[6] * X + v[7] * FLOOR_Y + v[8] * Z;
      const ff = EYE_3D / (EYE_3D - fz);
      this.fx[i] = this.cx + vx * ff * this.unit;
      this.fy[i] = this.cy - fy * ff * this.unit;
      this.sz[i] = vz;
      this.sf[i] = f4 * f3;
    }
  }

  private draw() {
    this.dirty = false;
    this.project();
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.clearRect(0, 0, this.w, this.h);

    // PLAN
    ctx.globalAlpha = FLOOR_ALPHA;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.75 * dpr;
    ctx.beginPath();
    for (let e = 0; e < N_EDGES; e++) {
      const a = EDGES[e * 2];
      const b = EDGES[e * 2 + 1];
      ctx.moveTo(this.fx[a], this.fy[a]);
      ctx.lineTo(this.fx[b], this.fy[b]);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // back to front, so front lines can cut their halo through what is behind
    for (let e = 0; e < N_EDGES; e++)
      this.depth[e] = this.sz[EDGES[e * 2]] + this.sz[EDGES[e * 2 + 1]];
    const order = this.order;
    for (let i = 1; i < N_EDGES; i++) {
      const o = order[i];
      const d = this.depth[o];
      let j = i - 1;
      while (j >= 0 && this.depth[order[j]] > d) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = o;
    }

    for (let n = 0; n < N_EDGES; n++) {
      const e = order[n];
      const a = EDGES[e * 2];
      const b = EDGES[e * 2 + 1];
      // hidden edges dash out smoothly as they pass behind the middle
      const front = smooth(-0.3, 0.3, this.depth[e] * 0.5);
      const weight =
        LINE_PX * dpr * Math.pow(Math.min(MAX_NEAR, (this.sf[a] + this.sf[b]) * 0.5), 1.3);
      if (front > 0.02) {
        ctx.globalCompositeOperation = "destination-out";
        ctx.globalAlpha = front;
        ctx.setLineDash(NONE);
        ctx.lineWidth = weight + HALO_PX * 2 * dpr;
        this.segment(a, b, 0.12);
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = INK;
        ctx.lineWidth = weight;
        this.segment(a, b, 0);
      }
      if (front < 0.98) {
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = (1 - front) * 0.75;
        ctx.setLineDash(this.dash);
        ctx.strokeStyle = INK;
        ctx.lineWidth = Math.max(0.8 * dpr, weight * 0.7);
        this.segment(a, b, 0);
      }
    }
    ctx.setLineDash(NONE);
    ctx.globalAlpha = 1;

    // CORNERS
    ctx.lineWidth = 1 * dpr;
    for (let i = 0; i < 16; i++) {
      const x = this.sx[i];
      const y = this.sy[i];
      const front = smooth(-0.3, 0.3, this.sz[i]);
      const r = DOT_PX * dpr * Math.pow(Math.min(MAX_NEAR, this.sf[i]), 1.2);
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(x, y, r + 1.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = INK;
      ctx.globalAlpha = front;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = INK;
      ctx.stroke();
      // letter pushed outward from the centre
      const dx = x - this.cx;
      const dy = y - this.cy;
      const l = Math.hypot(dx, dy) || 1;
      const gap = LABEL_GAP_PX * dpr;
      ctx.fillStyle = front > 0.5 ? INK : MUTED;
      ctx.fillText(LABELS[i], x + (dx / l) * gap, y + (dy / l) * gap);
    }
  }

  // a line between two corners, trimmed by a share at each end
  private segment(a: number, b: number, trim: number) {
    const ax = this.sx[a];
    const ay = this.sy[a];
    const dx = this.sx[b] - ax;
    const dy = this.sy[b] - ay;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(ax + dx * trim, ay + dy * trim);
    ctx.lineTo(ax + dx * (1 - trim), ay + dy * (1 - trim));
    ctx.stroke();
  }

  // INPUT
  private down = (e: PointerEvent) => {
    if (this.pointer !== -1) return;
    this.pointer = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.px = e.clientX;
    this.py = e.clientY;
    this.pt = e.timeStamp;
    this.vxw = 0;
    this.vyw = 0;
    this.canvas.style.cursor = "grabbing";
  };

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    const a = (e.clientX - this.px) * DRAG_RAD_PX;
    const b = (e.clientY - this.py) * DRAG_RAD_PX;
    const dt = Math.max(1e-3, (e.timeStamp - this.pt) / 1000);
    this.px = e.clientX;
    this.py = e.clientY;
    this.pt = e.timeStamp;
    this.turn(0, 3, a);
    this.turn(1, 3, b);
    this.xw += a;
    this.yw += b;
    const k = 1 - Math.exp(-dt / VEL_TAU_S);
    this.vxw += (a / dt - this.vxw) * k;
    this.vyw += (b / dt - this.vyw) * k;
    this.wake();
  };

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    this.pointer = -1;
    // a pointer that stopped before letting go should not fling
    if (e.timeStamp - this.pt > 80) this.vxw = this.vyw = 0;
    this.vxw = clamp(this.vxw, MAX_VEL_RAD_S);
    this.vyw = clamp(this.vyw, MAX_VEL_RAD_S);
    this.canvas.style.cursor = "";
    this.wake();
  };

  private key = (e: KeyboardEvent) => {
    const step = 0.6;
    if (e.key === "ArrowLeft") this.vxw -= step;
    else if (e.key === "ArrowRight") this.vxw += step;
    else if (e.key === "ArrowUp") this.vyw -= step;
    else if (e.key === "ArrowDown") this.vyw += step;
    else return;
    e.preventDefault();
    this.wake();
  };

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
    this.unit = Math.min(this.w, this.h) * (cw < ch ? FIT_NARROW : FIT);
    this.cx = this.w * (cw / ch > 1.25 ? 0.5 + SHIFT : 0.5);
    this.cy = this.h * (cw < ch ? 0.47 : 0.4);
    // canvas state resets with its size, and setting it per frame would build strings
    const ctx = this.ctx;
    ctx.font = `italic ${LABEL_PX * dpr}px "Instrument Serif", Georgia, serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineCap = "round";
    for (let i = 0; i < DASH.length; i++) this.dash[i] = DASH[i] * dpr;
    this.sized = true;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
  }
}

const deg = (r: number) => ((((r * 180) / Math.PI) % 360) + 360) % 360;
const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
