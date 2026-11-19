import {
  BOX_H_U,
  BOX_W_U,
  COUNT,
  KNOB_DY_U,
  KNOB_R_U,
  MARGIN,
  STRINGS,
  place,
  shoulder,
  type Place,
} from "./layout";
import { SHADOW_DX_U, SHADOW_DY_U, board, looks, paintStatic, type Ctx, type Look } from "./paint";

const MAX_DPR = 2;
const MODES = 8;
const POINTS = 41;
const GHOSTS = 7; // samples across the shutter
const SHUTTER = 0.42; // share of a period the trail covers
const VIS_PER_HZ = 1 / 15; // drawn vibration rate per hertz of pitch; change speed here
const REDUCED_AMP = 0.28;
const STILL_U = 0.04; // below this the string counts as at rest
const MAX_DT_S = 1 / 30;
const LN1000 = 6.9078;

export type Opts = { reducedMotion: boolean };
type Canvas = HTMLCanvasElement | OffscreenCanvas;

const DASH_NONE: number[] = [];
const WIND_DASH_U = [0.5, 0.75];

const frameRequest = (fn: (t: number) => void): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(fn)
    : (setTimeout(() => fn(performance.now()), 16) as unknown as number);
const frameCancel = (id: number) =>
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id);

function makeCanvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// HARP
// draws the instrument: a cached layer for the wood and brass, the speaking lengths of string
// on top. each string is a sum of standing waves set by the pluck, so its shape, speed and decay
// follow the same numbers as the sound. the loop only runs while a string still moves
export class Harp {
  onShown: (() => void) | null = null;

  private ctx: Ctx;
  private layer: Canvas | null = null;
  private look: Look[];
  private at: Place = { s: 1, ox: 0, oy: 0 };
  private dpr = 1;
  private bx = 0;
  private by = 0;
  private k = 1;
  private reduced: boolean;
  private visible = false;
  private shown = false;
  private raf = 0;
  private last = -1;
  private sel = -1;

  private amp = new Float32Array(COUNT * MODES);
  private phase = new Float32Array(COUNT * MODES);
  private visHz = new Float32Array(COUNT);
  private tau = new Float32Array(COUNT);
  private turns = new Float32Array(COUNT);
  private held = new Uint8Array(COUNT);
  private holdP = new Float32Array(COUNT);
  private holdD = new Float32Array(COUNT);
  private ys = new Float32Array(COUNT * POINTS);
  private gy = new Float32Array(POINTS);
  private lo = new Float32Array(POINTS);
  private hi = new Float32Array(POINTS);
  private cs = new Float32Array(MODES);
  private sn = new Float32Array(MODES);
  private sinTab = new Float32Array(MODES * POINTS);
  private gCos = new Float32Array(MODES * GHOSTS);
  private gSin = new Float32Array(MODES * GHOSTS);

  constructor(
    private canvas: Canvas,
    opts: Opts,
  ) {
    const ctx = canvas.getContext("2d", { alpha: true }) as Ctx | null;
    if (!ctx) throw new Error("no 2d");
    this.ctx = ctx;
    this.reduced = opts.reducedMotion;
    this.look = looks(ctx);
    for (let n = 0; n < MODES; n++) {
      for (let j = 0; j < POINTS; j++)
        this.sinTab[n * POINTS + j] = Math.sin(((n + 1) * Math.PI * j) / (POINTS - 1));
      for (let g = 0; g < GHOSTS; g++) {
        const c = (2 * Math.PI * (n + 1) * SHUTTER * g) / (GHOSTS - 1);
        this.gCos[n * GHOSTS + g] = Math.cos(c);
        this.gSin[n * GHOSTS + g] = Math.sin(c);
      }
    }
    for (let i = 0; i < COUNT; i++) {
      const s = STRINGS[i];
      this.visHz[i] = s.f0 * VIS_PER_HZ;
      this.tau[i] = s.t60 / LN1000;
    }
  }

  size(w: number, h: number, dpr: number) {
    if (w < 1 || h < 1) return;
    this.dpr = Math.min(dpr, MAX_DPR);
    const p = place(w, h, this.at);
    const k = p.s * this.dpr;
    this.k = k;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.bx = Math.round((p.ox - MARGIN.x * p.s) * this.dpr);
    this.by = Math.round((p.oy - MARGIN.top * p.s) * this.dpr);
    const lw = Math.ceil(BOX_W_U * k);
    const lh = Math.ceil(BOX_H_U * k);
    if (this.layer) {
      this.layer.width = lw;
      this.layer.height = lh;
    } else this.layer = makeCanvas(lw, lh);
    const lc = this.layer.getContext("2d") as Ctx | null;
    if (!lc) throw new Error("no 2d");
    lc.setTransform(k, 0, 0, k, MARGIN.x * k, MARGIN.top * k);
    paintStatic(lc, k);
    this.draw();
    if (!this.shown) {
      this.shown = true;
      this.onShown?.();
    }
  }

  visibility(on: boolean) {
    this.visible = on;
    if (on) this.kick();
    else this.halt();
  }

  motion(reduced: boolean) {
    this.reduced = reduced;
    this.kick();
  }

  // a finger holds string i at p (0 top, 1 bottom), pulled d units sideways
  hold(i: number, p: number, d: number) {
    this.held[i] = 1;
    this.holdP[i] = p;
    this.holdD[i] = d;
    for (let n = 0; n < MODES; n++) this.amp[i * MODES + n] = 0;
    this.kick();
  }

  release(i: number) {
    this.held[i] = 0;
    this.kick();
  }

  // let go from a triangle of height d at p: its standing-wave amplitudes
  pluck(i: number, p: number, d: number) {
    this.held[i] = 0;
    const q = Math.min(0.95, Math.max(0.05, p));
    for (let n = 0; n < MODES; n++) {
      const m = n + 1;
      this.amp[i * MODES + n] =
        (2 * d * Math.sin(m * Math.PI * q)) / (m * m * Math.PI * Math.PI * q * (1 - q));
      this.phase[i * MODES + n] = 0;
    }
    this.last = -1;
    this.kick();
  }

  tune(i: number, f: number, turn: number, t60: number) {
    this.visHz[i] = f * VIS_PER_HZ;
    this.tau[i] = t60 / LN1000;
    this.turns[i] = turn;
    this.kick();
  }

  select(i: number) {
    this.sel = i;
    this.kick();
  }

  dispose() {
    this.halt();
    if (this.layer) {
      this.layer.width = 0;
      this.layer.height = 0;
    }
    this.layer = null;
    this.onShown = null;
  }

  // LOOP
  private kick() {
    if (!this.visible || this.raf || !this.layer) return;
    this.raf = frameRequest(this.tick);
  }

  private halt() {
    if (this.raf) frameCancel(this.raf);
    this.raf = 0;
    this.last = -1;
  }

  private tick = (now: number) => {
    this.raf = 0;
    const dt = this.last < 0 ? 0 : Math.min(MAX_DT_S, (now - this.last) / 1000);
    this.last = now;
    const moving = this.step(dt);
    this.draw();
    if (moving) this.kick();
    else this.last = -1;
  };

  private step(dt: number) {
    let moving = false;
    for (let i = 0; i < COUNT; i++) {
      if (this.held[i]) continue;
      let e = 0;
      const w = 2 * Math.PI * this.visHz[i] * dt;
      for (let n = 0; n < MODES; n++) {
        const o = i * MODES + n;
        if (this.amp[o] === 0) continue;
        const m = n + 1;
        this.phase[o] = (this.phase[o] + w * m) % (2 * Math.PI);
        this.amp[o] *= Math.exp((-dt * Math.pow(m, 0.7)) / this.tau[i]);
        e += Math.abs(this.amp[o]);
      }
      if (e > STILL_U) moving = true;
      else if (e > 0) for (let n = 0; n < MODES; n++) this.amp[i * MODES + n] = 0;
    }
    return moving;
  }

  // displacement along string i for trail copy g, into out
  private shape(i: number, g: number, out: Float32Array, o: number) {
    const scale = this.reduced ? REDUCED_AMP : 1;
    for (let j = 0; j < POINTS; j++) out[o + j] = 0;
    if (this.held[i]) {
      const p = this.holdP[i];
      const d = this.holdD[i] * scale;
      for (let j = 0; j < POINTS; j++) {
        const t = j / (POINTS - 1);
        out[o + j] = d * (t < p ? t / p : (1 - t) / (1 - p));
      }
      return;
    }
    for (let n = 0; n < MODES; n++) {
      const a = this.amp[i * MODES + n];
      if (a === 0) continue;
      const c = this.cs[n] * this.gCos[n * GHOSTS + g] + this.sn[n] * this.gSin[n * GHOSTS + g];
      const ac = a * c * scale;
      for (let j = 0; j < POINTS; j++) out[o + j] += ac * this.sinTab[n * POINTS + j];
    }
  }

  private trig(i: number) {
    for (let n = 0; n < MODES; n++) {
      const ph = this.phase[i * MODES + n];
      this.cs[n] = Math.cos(ph);
      this.sn[n] = Math.sin(ph);
    }
  }

  private path(i: number, src: Float32Array, o: number, dx: number, dy: number) {
    const ctx = this.ctx;
    const s = STRINGS[i];
    const len = s.bridge - s.nut;
    ctx.beginPath();
    if (this.held[i]) {
      const p = this.holdP[i];
      ctx.moveTo(s.x + dx, s.nut + dy);
      ctx.lineTo(s.x + dx + this.holdD[i] * (this.reduced ? REDUCED_AMP : 1), s.nut + p * len + dy);
      ctx.lineTo(s.x + dx, s.bridge + dy);
      return;
    }
    for (let j = 0; j < POINTS; j++) {
      const x = s.x + dx + src[o + j];
      const y = s.nut + dy + (len * j) / (POINTS - 1);
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  private energy(i: number) {
    let e = 0;
    for (let n = 0; n < MODES; n++) e += Math.abs(this.amp[i * MODES + n]);
    return e;
  }

  // DRAW
  private draw() {
    const ctx = this.ctx;
    const layer = this.layer;
    if (!layer) return;
    const k = this.k;
    const px = 1 / k; // one device pixel, in units
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(this.bx, this.by, layer.width, layer.height);
    ctx.drawImage(layer, this.bx, this.by);
    ctx.setTransform(k, 0, 0, k, this.bx + MARGIN.x * k, this.by + MARGIN.top * k);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let i = 0; i < COUNT; i++) {
      this.trig(i);
      this.shape(i, 0, this.ys, i * POINTS);
    }

    // SHADOWS
    // on the board only, where the string hovers above the wood
    ctx.save();
    board(ctx);
    ctx.clip();
    for (let i = 0; i < COUNT; i++) {
      const w = STRINGS[i].width;
      this.path(i, this.ys, i * POINTS, SHADOW_DX_U, SHADOW_DY_U);
      ctx.strokeStyle = "rgba(60, 32, 10, 0.1)";
      ctx.lineWidth = w * 4;
      ctx.stroke();
      ctx.strokeStyle = "rgba(50, 26, 8, 0.24)";
      ctx.lineWidth = Math.max(w * 1.3, px);
      ctx.stroke();
    }
    ctx.restore();

    // STRINGS
    for (let i = 0; i < COUNT; i++) {
      const s = STRINGS[i];
      const look = this.look[i];
      const w = Math.max(s.width, 1.2 * px);
      if (!this.reduced && !this.held[i] && this.energy(i) > 0.6) {
        // MOTION BLUR
        // the band the string sweeps through over the shutter, edged where it dwells
        this.trig(i);
        const o = i * POINTS;
        for (let j = 0; j < POINTS; j++) this.lo[j] = this.hi[j] = this.ys[o + j];
        for (let g = 1; g < GHOSTS; g++) {
          this.shape(i, g, this.gy, 0);
          for (let j = 0; j < POINTS; j++) {
            const y = this.gy[j];
            if (y < this.lo[j]) this.lo[j] = y;
            if (y > this.hi[j]) this.hi[j] = y;
          }
        }
        const len = s.bridge - s.nut;
        ctx.beginPath();
        for (let j = 0; j < POINTS; j++) {
          const y = s.nut + (len * j) / (POINTS - 1);
          if (j === 0) ctx.moveTo(s.x + this.hi[j] + w * 0.5, y);
          else ctx.lineTo(s.x + this.hi[j] + w * 0.5, y);
        }
        for (let j = POINTS - 1; j >= 0; j--)
          ctx.lineTo(s.x + this.lo[j] - w * 0.5, s.nut + (len * j) / (POINTS - 1));
        ctx.closePath();
        ctx.fillStyle = s.wound ? "rgba(120, 78, 36, 0.14)" : "rgba(96, 102, 110, 0.1)";
        ctx.fill();
        ctx.strokeStyle = s.wound ? "rgba(96, 60, 26, 0.34)" : "rgba(70, 76, 84, 0.32)";
        ctx.lineWidth = w * 0.8;
        this.path(i, this.hi, 0, 0, 0);
        ctx.stroke();
        this.path(i, this.lo, 0, 0, 0);
        ctx.stroke();
      }
      this.path(i, this.ys, i * POINTS, 0, 0);
      ctx.strokeStyle = look.edge;
      ctx.lineWidth = w;
      ctx.stroke();
      ctx.strokeStyle = look.body;
      ctx.lineWidth = w * 0.62;
      ctx.stroke();
      if (s.wound) {
        ctx.setLineDash(WIND_DASH_U);
        ctx.strokeStyle = "rgba(60, 34, 12, 0.32)";
        ctx.lineWidth = w * 0.7;
        ctx.stroke();
        ctx.setLineDash(DASH_NONE);
      }
      this.path(i, this.ys, i * POINTS, -w * 0.17, 0);
      ctx.strokeStyle = look.shine;
      ctx.lineWidth = Math.max(w * 0.26, 0.7 * px);
      ctx.stroke();
    }

    // KNOB MARKS
    for (let i = 0; i < COUNT; i++) {
      const s = STRINGS[i];
      const y = shoulder(s.x) + KNOB_DY_U;
      const a = this.turns[i];
      ctx.beginPath();
      ctx.arc(s.x + Math.sin(a) * 10, y - Math.cos(a) * 10, 1.9, 0, Math.PI * 2);
      ctx.fillStyle = "#ead6a2";
      ctx.fill();
      if (i === this.sel) {
        ctx.beginPath();
        ctx.arc(s.x, y, KNOB_R_U + 5, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(240, 226, 200, 0.9)";
        ctx.lineWidth = Math.max(1.2, 1.5 * px);
        ctx.stroke();
      }
    }
  }
}
