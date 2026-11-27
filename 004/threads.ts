// THREADS
// damped verlet chains at fixed spacing; upper thread drawn over lower at crossings

const MAX_DPR = 2;
const MAX_DT_S = 1 / 30;
const SUBSTEPS = 2;
const ITERS = 6;
const DAMP = 0.86; // change lower for calmer threads
const BEND = 0.08;
const ANCHOR = 0.006;
const SEG_PX = 7;
const MIN_SPAN = 0.99;
const MIN_SPAN_WIDE = 0.955;
const MAX_STEP_PX = 5;

// HANDS
const REACH_PX = 90;
const STIR_R = 170;
const STIR_DRAG = 0.05;
const STIR_SPIN = 0.32; // change for tighter winding
const STIR_PULL = 0;
const CENTRE_TAU_S = 0.35;
const CORE = 0.6;
const COMB = 1.5;
const COMB_ALONG = 0.6;
const END_COMB = 0.05;
const SETTLE_K = 0.06;
const SETTLE_S = 1.4;
const END_PX = 26;
const TURN_TAU_S = 0.08;

// INK
const INKS = ["#161a2c", "#2d3a78", "#161a2c", "#8e3a2c", "#161a2c", "#2d3a78", "#5c4a3a"];
const WIDTH_PX = 1.6;
const INTRO_S = 1.8;
const MAX_CROSS = 800;
const CELL_PX = 28;

export class Threads {
  private ctx: CanvasRenderingContext2D;
  private k = INKS.length;
  private n = 0;
  private px = new Float32Array(0);
  private py = new Float32Array(0);
  private ox = new Float32Array(0);
  private oy = new Float32Array(0);
  private hx = new Float32Array(0);
  private hy = new Float32Array(0);
  private z = new Float32Array(0);
  private order = new Int32Array(0);
  private settle = new Float32Array(0);
  private rest = new Float32Array(0);
  private stirR = STIR_R;
  private x0 = 0;
  private span = 1;
  private reach = REACH_PX;
  private w = 1;
  private h = 1;
  private dpr = 1;

  // CROSSINGS
  private cn = 0;
  private head = new Int32Array(0);
  private link = new Int32Array(0);
  private gw = 1;
  private gh = 1;
  private reported = -1;

  // HANDS
  private down = false;
  private pointer = -1;
  private cx = 0;
  private cy = 0;
  private lx = 0;
  private ly = 0;
  private vx = 0;
  private vy = 0;
  private heading = 0;
  private sx = 0;
  private sy = 0;
  private turn = 0;
  private moved = false;
  private pin = -1;
  private auto = 0;
  private autoT = 0;

  private raf = 0;
  private last = 0;
  private visible = false;
  private sized = false;
  private reveal = 0;
  private calm = 0;
  private reducedMotion: boolean;
  private cleanups: (() => void)[] = [];
  private rect = { left: 0, top: 0 };

  onState: (crossings: number) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d unavailable");
    this.ctx = ctx;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion = mq.matches;
    const onMotion = () => (this.reducedMotion = mq.matches);
    mq.addEventListener("change", onMotion);
    this.reveal = this.reducedMotion ? 1 : 0;

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
    canvas.addEventListener("pointerdown", this.press, opts);
    canvas.addEventListener("pointermove", this.move, opts);
    canvas.addEventListener("pointerup", this.release, opts);
    canvas.addEventListener("pointercancel", this.release, opts);
    canvas.addEventListener("pointerleave", this.leave, opts);
    canvas.addEventListener("keydown", this.key);
    this.cleanups.push(
      () => mq.removeEventListener("change", onMotion),
      () => ro.disconnect(),
      () => io.disconnect(),
      () => document.removeEventListener("visibilitychange", onVisibility),
      () => canvas.removeEventListener("pointerdown", this.press),
      () => canvas.removeEventListener("pointermove", this.move),
      () => canvas.removeEventListener("pointerup", this.release),
      () => canvas.removeEventListener("pointercancel", this.release),
      () => canvas.removeEventListener("pointerleave", this.leave),
      () => canvas.removeEventListener("keydown", this.key),
    );
  }

  // PUBLIC
  stir() {
    this.auto = 1;
    this.autoT = 0;
    this.wake();
  }

  comb() {
    this.auto = 2;
    this.autoT = 0;
    this.wake();
  }

  // LAYOUT
  private lay() {
    const w = this.w;
    const h = this.h;
    const narrow = w < 640;
    const x0 = w * (narrow ? 0.03 : 0.04);
    const x1 = w * (narrow ? 0.97 : 0.96);
    const yMid = h * (narrow ? 0.57 : 0.47);
    const gap = Math.min(h * 0.058, narrow ? 34 : 50);
    const span = x1 - x0;
    this.x0 = x0;
    this.span = span;
    this.stirR = Math.min(STIR_R, w * 0.36);
    this.reach = Math.min(REACH_PX, w * 0.14);
    const waves = narrow ? 2.6 : 1.8;
    const n = Math.max(80, Math.min(340, Math.round((span * 1.3) / SEG_PX)));
    this.n = n;
    const total = this.k * n;
    this.px = new Float32Array(total);
    this.py = new Float32Array(total);
    this.ox = new Float32Array(total);
    this.oy = new Float32Array(total);
    this.hx = new Float32Array(total);
    this.hy = new Float32Array(total);
    this.z = new Float32Array(total);
    this.settle = new Float32Array(total);
    this.rest = new Float32Array(this.k);
    for (let s = 0; s < this.k; s++) {
      const y = yMid + (s - (this.k - 1) / 2) * gap;
      const f1 = waves + s * 0.37;
      const f2 = waves * 2.3 + s * 0.61;
      let len = 0;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const o = s * n + i;
        const x = x0 + span * t;
        const yy =
          y +
          Math.sin(t * Math.PI * f1 + s * 1.7) * gap * 0.36 +
          Math.sin(t * Math.PI * f2 + s) * gap * 0.08;
        this.hx[o] = this.px[o] = this.ox[o] = x;
        this.hy[o] = this.py[o] = this.oy[o] = yy;
        if (i > 0) len += Math.hypot(x - this.hx[o - 1], yy - this.hy[o - 1]);
        this.z[o] = Math.sin(i * 0.071 + s * 2.3) + 0.6 * Math.sin(i * 0.173 + s * 5.1);
      }
      this.rest[s] = len / (n - 1);
    }
    this.gw = Math.ceil(w / CELL_PX) + 1;
    this.gh = Math.ceil(h / CELL_PX) + 1;
    this.head = new Int32Array(this.gw * this.gh);
    this.link = new Int32Array(total);
    const order = Array.from({ length: total }, (_, i) => i);
    order.sort((a, b) => this.z[a] - this.z[b]);
    this.order = Int32Array.from(order);
  }

  private lineAt(i: number, x: number) {
    const n = this.n;
    const s = (i / n) | 0;
    const f = Math.min(n - 1.001, Math.max(0, ((x - this.x0) / this.span) * (n - 1)));
    const j = f | 0;
    const o = s * n + j;
    return this.hy[o] + (this.hy[o + 1] - this.hy[o]) * (f - j);
  }

  // INPUT
  private local(e: PointerEvent) {
    this.cx = e.clientX - this.rect.left;
    this.cy = e.clientY - this.rect.top;
  }

  private nearestEnd() {
    let best = -1;
    let bd = END_PX * END_PX;
    for (let s = 0; s < this.k; s++) {
      for (let e = 0; e < 2; e++) {
        const o = s * this.n + (e ? this.n - 1 : 0);
        const dx = this.px[o] - this.cx;
        const dy = this.py[o] - this.cy;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
    }
    return best;
  }

  private press = (e: PointerEvent) => {
    if (this.pointer !== -1) return;
    this.pointer = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.local(e);
    this.lx = this.cx;
    this.ly = this.cy;
    this.vx = this.vy = 0;
    this.sx = this.cx;
    this.sy = this.cy;
    this.turn = 0;
    this.down = true;
    this.auto = 0;
    this.pin = this.nearestEnd();
    this.canvas.style.cursor = this.pin >= 0 ? "grabbing" : "";
    this.wake();
  };

  private move = (e: PointerEvent) => {
    if (this.pointer !== -1 && e.pointerId !== this.pointer) return;
    this.local(e);
    this.moved = true;
    if (this.pointer === -1 && e.pointerType === "mouse")
      this.canvas.style.cursor = this.nearestEnd() >= 0 ? "grab" : "";
    this.wake();
  };

  private release = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    this.pointer = -1;
    this.down = false;
    this.pin = -1;
    this.canvas.style.cursor = "";
    this.wake();
  };

  private leave = (e: PointerEvent) => {
    if (this.pointer === -1 && e.pointerType === "mouse") {
      this.vx = this.vy = this.turn = 0;
      this.moved = false;
    }
  };

  private key = (e: KeyboardEvent) => {
    if (e.key === "s" || e.key === "S") this.stir();
    else if (e.key === "c" || e.key === "C" || e.key === "Enter") this.comb();
  };

  // LOOP
  private wake() {
    if (!this.raf && this.visible && !document.hidden) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible || document.hidden) return;
    const dt = this.last ? Math.min(MAX_DT_S, Math.max(1e-3, (now - this.last) / 1000)) : 1 / 60;
    this.last = now;
    if (!this.sized) this.resize();

    if (this.reveal < 1) this.reveal = Math.min(1, this.reveal + dt / INTRO_S);
    this.autopilot(dt);
    this.track(dt);
    const motion = this.step(dt);
    this.cross();
    this.draw();
    this.report();

    this.calm = motion < 0.02 * this.k ? this.calm + dt : 0;
    const busy = this.reveal < 1 || this.down || this.auto !== 0 || this.moved || this.calm < 0.25;
    this.moved = false;
    if (busy) this.wake();
    else this.last = 0;
  };

  // HAND TRACKING
  // smoothed velocity and turn rate; a looping path reads as a stir
  private track(dt: number) {
    const k = 1 - Math.exp(-dt / TURN_TAU_S);
    const nvx = (this.cx - this.lx) / dt;
    const nvy = (this.cy - this.ly) / dt;
    this.lx = this.cx;
    this.ly = this.cy;
    const ks = 1 - Math.exp(-dt / CENTRE_TAU_S);
    this.sx += (this.cx - this.sx) * ks;
    this.sy += (this.cy - this.sy) * ks;
    this.vx += (nvx - this.vx) * k;
    this.vy += (nvy - this.vy) * k;
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > 60) {
      const hd = Math.atan2(this.vy, this.vx);
      let d = hd - this.heading;
      if (d > Math.PI) d -= Math.PI * 2;
      else if (d < -Math.PI) d += Math.PI * 2;
      this.heading = hd;
      this.turn += (d / dt - this.turn) * k;
    } else this.turn *= 1 - k;
  }

  // AUTOPILOT
  private autopilot(dt: number) {
    if (this.auto === 0) return;
    this.autoT += dt;
    const mx = this.w * 0.5;
    const my = this.h * (this.w < 640 ? 0.57 : 0.47);
    if (this.auto === 1) {
      const a = this.autoT * 4.5;
      const r = Math.min(60, this.w * 0.1) + 10 * Math.sin(this.autoT * 1.3);
      this.cx = mx + Math.cos(a) * r;
      this.cy = my + Math.sin(a) * r;
      this.down = true;
      if (this.autoT > 3.4) this.stopAuto();
    } else {
      const t = Math.min(1, this.autoT / 3);
      this.cx = this.w * (0.04 + 0.92 * t);
      this.cy = my + Math.sin(this.autoT * 5) * this.h * 0.09;
      this.down = true;
      if (t >= 1) this.stopAuto();
    }
    this.moved = true;
  }

  private stopAuto() {
    this.auto = 0;
    if (this.pointer === -1) this.down = false;
  }

  // STEP
  private step(dt: number) {
    const n = this.n;
    const total = this.k * n;
    const px = this.px;
    const py = this.py;
    const ox = this.ox;
    const oy = this.oy;
    const speed = Math.hypot(this.vx, this.vy);
    const turn = this.auto === 2 ? 0 : this.turn;
    const loop = smooth((Math.abs(turn) - 1.5) / 3);
    const stir = loop * (this.down ? 1 : smooth((speed - 500) / 500));
    const comb = this.down && this.pin < 0 ? (1 - loop) * (1 - smooth((speed - 900) / 900)) : 0;
    const h = dt / SUBSTEPS;
    let motion = 0;

    for (let sub = 0; sub < SUBSTEPS; sub++) {
      // VERLET
      for (let i = 0; i < total; i++) {
        const vx = (px[i] - ox[i]) * DAMP;
        const vy = (py[i] - oy[i]) * DAMP;
        ox[i] = px[i];
        oy[i] = py[i];
        px[i] += vx;
        py[i] += vy;
      }

      // STIR
      // swirl about the loop centre; upper strands spin faster so they pass over lower
      if (stir > 0.01 && this.pin < 0) {
        const r2 = this.stirR * this.stirR;
        const base = turn * h * STIR_SPIN * stir;
        for (let i = 0; i < total; i++) {
          const dx = px[i] - this.sx;
          const dy = py[i] - this.sy;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const r = Math.sqrt(d2) / this.stirR;
          const f = r < CORE ? 1 : smooth((1 - r) / (1 - CORE));
          this.settle[i] = 0;
          const lift = 0.2 + 0.8 * Math.min(1, Math.max(0, (this.z[i] + 1.6) / 3.2));
          const a = base * f * lift;
          const cs = Math.cos(a);
          const sn = Math.sin(a);
          let mx = dx * cs - dy * sn - dx - dx * STIR_PULL * f * stir;
          let my = dx * sn + dy * cs - dy - dy * STIR_PULL * f * stir;
          mx += this.vx * h * STIR_DRAG * f * f * stir;
          my += this.vy * h * STIR_DRAG * f * f * stir;
          const ml = Math.hypot(mx, my);
          if (ml > MAX_STEP_PX) {
            mx *= MAX_STEP_PX / ml;
            my *= MAX_STEP_PX / ml;
          }
          px[i] += mx;
          py[i] += my;
        }
      }

      // COMB
      if (comb > 0.01) {
        const r2 = this.reach * this.reach;
        const reach = Math.min(1, (speed * h) / this.reach);
        for (let i = 0; i < total; i++) {
          const dx = px[i] - this.cx;
          const dy = py[i] - this.cy;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const f = 1 - Math.sqrt(d2) / this.reach;
          const k = Math.min(0.5, COMB * comb * f * f * reach);
          if (f * comb > this.settle[i]) this.settle[i] = f * comb;
          px[i] += (this.hx[i] - px[i]) * k * COMB_ALONG;
          py[i] += (this.lineAt(i, px[i]) - py[i]) * k;
          const j = i % this.n;
          if (j > 0 && j < this.n - 1) {
            px[i] += ((px[i - 1] + px[i + 1]) * 0.5 - px[i]) * k;
            py[i] += ((py[i - 1] + py[i + 1]) * 0.5 - py[i]) * k;
          }
        }
      }

      // SETTLE
      // combed points keep easing home after the pass, so loosened curls slip free
      const fade = Math.exp(-h / SETTLE_S);
      for (let i = 0; i < total; i++) {
        const st = this.settle[i];
        if (st < 1e-3) continue;
        px[i] += (this.hx[i] - px[i]) * st * SETTLE_K;
        py[i] += (this.hy[i] - py[i]) * st * SETTLE_K;
        this.settle[i] = st * fade;
      }

      // ENDS
      for (let s = 0; s < this.k; s++) {
        for (let e = 0; e < 2; e++) {
          const o = s * n + (e ? n - 1 : 0);
          if (o === this.pin) continue;
          const pull = ANCHOR + comb * END_COMB;
          px[o] += (this.hx[o] - px[o]) * pull;
          py[o] += (this.hy[o] - py[o]) * pull;
        }
      }
      if (this.pin >= 0) {
        px[this.pin] = this.cx;
        py[this.pin] = this.cy;
      }

      // LENGTH
      // distance constraints, swept both directions so neither end leads
      for (let it = 0; it < ITERS; it++) {
        const fwd = (it & 1) === 0;
        for (let s = 0; s < this.k; s++) {
          const base = s * n;
          const rest = this.rest[s];
          for (let q = 0; q < n - 1; q++) {
            const j = fwd ? q : n - 2 - q;
            const a = base + j;
            const b = a + 1;
            const dx = px[b] - px[a];
            const dy = py[b] - py[a];
            const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
            const c = (d - rest) / d;
            const wa = a === this.pin ? 0 : 1;
            const wb = b === this.pin ? 0 : 1;
            const sum = wa + wb;
            if (sum === 0) continue;
            px[a] += dx * c * (wa / sum);
            py[a] += dy * c * (wa / sum);
            px[b] -= dx * c * (wb / sum);
            py[b] -= dy * c * (wb / sum);
          }
          // BEND LIMIT
          // minimum distance between points 2 and 4 apart caps curvature
          for (let reachK = 1; reachK <= 2; reachK++) {
            const min = rest * 2 * reachK * (reachK === 1 ? MIN_SPAN : MIN_SPAN_WIDE);
            for (let j = reachK; j < n - reachK; j++) {
              if (this.settle[base + j] > 0.12) continue;
              const a = base + j - reachK;
              const b = base + j + reachK;
              const dx = px[b] - px[a];
              const dy = py[b] - py[a];
              const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
              if (d >= min) continue;
              const c = ((min - d) / d) * 0.5;
              const wa = a === this.pin ? 0 : 1;
              const wb = b === this.pin ? 0 : 1;
              px[a] -= dx * c * wa;
              py[a] -= dy * c * wa;
              px[b] += dx * c * wb;
              py[b] += dy * c * wb;
            }
          }
        }
      }

      // BEND
      // laplacian smoothing
      for (let pass = 0; pass < 2; pass++)
        for (let s = 0; s < this.k; s++) {
          const base = s * n;
          for (let j = 1; j < n - 1; j++) {
            const o = base + j;
            if (o === this.pin) continue;
            px[o] += ((px[o - 1] + px[o + 1]) * 0.5 - px[o]) * BEND;
            py[o] += ((py[o - 1] + py[o + 1]) * 0.5 - py[o]) * BEND;
          }
        }
    }
    for (let i = 0; i < total; i++) motion += Math.abs(px[i] - ox[i]) + Math.abs(py[i] - oy[i]);
    return motion / n;
  }

  // CROSSINGS
  // uniform grid broad phase, segment pairs tested per cell
  private cross() {
    const n = this.n;
    const total = this.k * n;
    const px = this.px;
    const py = this.py;
    const head = this.head;
    const link = this.link;
    head.fill(-1);
    const gw = this.gw;
    const gh = this.gh;
    for (let i = 0; i < total; i++) {
      if (i % n === n - 1) continue;
      const mx = (px[i] + px[i + 1]) * 0.5;
      const my = (py[i] + py[i + 1]) * 0.5;
      const gx = Math.min(gw - 1, Math.max(0, Math.floor(mx / CELL_PX)));
      const gy = Math.min(gh - 1, Math.max(0, Math.floor(my / CELL_PX)));
      const c = gy * gw + gx;
      link[i] = head[c];
      head[c] = i;
    }
    let cn = 0;
    for (let i = 0; i < total && cn < MAX_CROSS; i++) {
      if (i % n === n - 1) continue;
      const mx = (px[i] + px[i + 1]) * 0.5;
      const my = (py[i] + py[i + 1]) * 0.5;
      const gx = Math.floor(mx / CELL_PX);
      const gy = Math.floor(my / CELL_PX);
      for (let yy = gy - 1; yy <= gy + 1; yy++) {
        if (yy < 0 || yy >= gh) continue;
        for (let xx = gx - 1; xx <= gx + 1; xx++) {
          if (xx < 0 || xx >= gw) continue;
          for (let j = head[yy * gw + xx]; j !== -1; j = link[j]) {
            if (j <= i) continue;
            if (Math.floor(j / n) === Math.floor(i / n) && j - i < 3) continue;
            const t = hit(px[i], py[i], px[i + 1], py[i + 1], px[j], py[j], px[j + 1], py[j + 1]);
            if (t < 0 || cn >= MAX_CROSS) continue;
            cn++;
          }
        }
      }
    }
    this.cn = cn;
  }

  // DRAW
  // segments sorted back to front by height, so upper threads overdraw lower
  private draw() {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    c.lineJoin = "round";
    c.lineCap = "round";
    const n = this.n;
    const px = this.px;
    const py = this.py;
    const order = this.order;
    for (let q = 0; q < order.length; q++) {
      const o = order[q];
      const s = (o / n) | 0;
      const i = o - s * n;
      const lead = 0.06 * (this.k - 1);
      const shown = Math.min(1, Math.max(0, (this.reveal - s * 0.06) / (1 - lead))) * (n - 1);
      if (i > shown) continue;
      const first = i === 0;
      const last = i === n - 1;
      const ax = first ? px[o] : (px[o - 1] + px[o]) * 0.5;
      const ay = first ? py[o] : (py[o - 1] + py[o]) * 0.5;
      const bx = last ? px[o] : (px[o] + px[o + 1]) * 0.5;
      const by = last ? py[o] : (py[o] + py[o + 1]) * 0.5;
      const width = WIDTH_PX * (0.82 + 0.3 * Math.sin(i * 0.13 + s * 2) * Math.sin(i * 0.041 + s));
      c.beginPath();
      c.moveTo(ax, ay);
      c.quadraticCurveTo(px[o], py[o], bx, by);
      c.strokeStyle = INKS[s];
      c.lineWidth = width;
      c.stroke();
    }
  }

  private report() {
    const count = this.reveal < 1 ? 0 : this.cn;
    if (count === this.reported) return;
    this.reported = count;
    this.onState(count);
  }

  // RESIZE
  private queueResize() {
    this.sized = false;
    this.wake();
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.rect.left = r.left;
    this.rect.top = r.top;
    const w = Math.max(1, r.width);
    const h = Math.max(1, r.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    if (Math.abs(w - this.w) > 1 || this.n === 0) {
      this.w = w;
      this.h = h;
      this.lay();
    } else if (Math.abs(h - this.h) > 1) {
      const dy = (h - this.h) * 0.5;
      for (let i = 0; i < this.px.length; i++) {
        this.py[i] += dy;
        this.oy[i] += dy;
        this.hy[i] += dy;
      }
      this.h = h;
      this.gh = Math.ceil(h / CELL_PX) + 1;
      this.head = new Int32Array(this.gw * this.gh);
    }
    this.sized = true;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
  }
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

// SEGMENT INTERSECTION
// parameter along p, or -1
function hit(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
) {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return -1;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}
