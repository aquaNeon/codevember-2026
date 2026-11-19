// SKY
// the renderer and its loop. no dom in here, so it runs in a worker on an offscreen canvas
// or on the page as a fallback. a pass runs at full rate; between passes, once the trail has
// faded and the camera is still, the loop sleeps until the next meteor is due

import { Director, SHOT, SHOT_NAMES } from "./director";
import {
  Fall,
  HIST_N,
  MASS0_KG,
  MAX_BODIES,
  MAX_SPARKS,
  OUT,
  ROWS,
  SPARK_STRIDE,
  pieceR,
  visR,
} from "./fall";
import { busy, finish, free, pass, raf, software, target, unraf, type Opts, type Pass } from "./gl";
import {
  BAKE_FS,
  SKY_FS,
  SPARK_FS,
  SPARK_VS,
  SPRITE_FS,
  SPRITE_VS,
  TRAIL_FS,
  TRAIL_VS,
} from "./shaders";

const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const BAKE_PX = 512;
const BAKE_OCT = 5; // octaves in the cloud sheet, a uniform so the loop is not unrolled
const FIRST_MS = 900; // the first meteor arrives this long after the sky is up
const BEAT_MS = 1800; // between passes
const AUTO_PASSES = 7; // after this many untouched passes the sky waits for a tap
const SLOW_MS = 24; // frames slower than this lower the resolution
const MIN_SCALE = 0.55;
// entry angles below the horizon, rad, in turn: medium, steep, grazing, shallow, steep-ish
const GAMMAS = [0.5, 0.82, 0.18, 0.32, 0.66, 0.42] as const;
const STRANDS_MAIN = 8;
const STRANDS_FRAG = 2;
const SPRITES = MAX_BODIES + 3;
const FLARES = 7;
const HUD_MS = 110;
const SUN = norm([0.62, -0.06, -0.78]);
const MOON = norm([0.16, 0.36, -0.92]);
const SMOKE_S = 4.5; // the debris cloud lingers this long
const WIND = [0.03, 0.004, 0.02] as const; // km/s², drifts the train
// strand params: phase, spread, width, hue
const STRAND = [
  [0, 0, 1, 0],
  [0.1, 0.7, 0.55, 0.08],
  [0.6, 0.9, 0.5, 0.18],
  [0.3, 1.4, 0.45, 0.3],
  [0.85, 1.7, 0.4, 0.42],
  [0.45, 2.2, 0.35, 0.55],
  [0.72, 1.1, 0.3, 0.12],
  [0.2, 0.3, 5, 0.03], // the soft glow round it all
] as const;
// lens ghosts along the line from the head through the centre: place, size px, kind, tint
const GHOSTS = [
  [-0.35, 26, 3, 0.25, 0.5, 1.0],
  [-0.7, 60, 5, 0.6, 0.35, 1.0],
  [-1.05, 14, 3, 1.0, 0.6, 0.3],
  [-1.3, 110, 4, 0.4, 0.7, 1.0],
  [0.45, 40, 5, 1.0, 0.4, 0.6],
] as const;

export type Hud = {
  alt: number;
  speed: number;
  mass: number;
  left: number; // share of the mass still there
  entry: number;
  phase: string;
  shot: string;
  waiting: boolean;
};

export class Sky {
  onShown: () => void = () => {};
  onHud: (h: Hud) => void = () => {};

  private gl: WebGL2RenderingContext;
  private parallel: boolean;
  private passes: Pass[];
  private bakeP: Pass;
  private skyP: Pass;
  private trailP: Pass;
  private sparkP: Pass;
  private spriteP: Pass;
  private linked = false;
  private baked = false;
  private cloudT: ReturnType<typeof target> | undefined;
  private layer: ReturnType<typeof target> | undefined;
  private histTex: WebGLTexture;
  private vaos: WebGLVertexArrayObject[] = [];
  private bufs: WebGLBuffer[] = [];
  private trailVao: WebGLVertexArrayObject;
  private trailMeta: WebGLBuffer;
  private meta = new Float32Array((STRANDS_MAIN + (MAX_BODIES - 1) * STRANDS_FRAG + 1) * 8);
  private trailN = 0;
  private sparkVao: WebGLVertexArrayObject;
  private sparkBuf: WebGLBuffer;
  private spriteVao: WebGLVertexArrayObject;
  private spriteBuf: WebGLBuffer;
  private sprites = new Float32Array(SPRITES * 10);
  private spriteN = 0;
  private flareVao: WebGLVertexArrayObject;
  private flareBuf: WebGLBuffer;
  private flares = new Float32Array(FLARES * 10);
  private flareN = 0;

  private fall = new Fall();
  private dir: Director;
  private raf = 0;
  private timer = 0;
  private last = 0;
  private visible = false;
  private sized = false;
  private drawn = false;
  private dead = false;
  private reduced: boolean;
  private hold: boolean;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private scale = 1;
  private slow = 0;
  private frames = 0;
  private due = 0; // when the next meteor arrives, performance.now ms, 0 when none
  private passN = 0;
  private untouched = 0;
  private waiting = false;
  private gamma: number = GAMMAS[0];
  private flash = 0;
  private flashGoal = 0; // the flash rises to this, then falls
  private hudAt = 0;
  private hud: Hud = {
    alt: 0,
    speed: 0,
    mass: MASS0_KG,
    left: 1,
    entry: 0,
    phase: "",
    shot: "",
    waiting: false,
  };
  private proj = { tan: 0.4, aspect: 1 };

  constructor(
    private canvas: HTMLCanvasElement | OffscreenCanvas,
    opts: Opts,
  ) {
    this.reduced = opts.reducedMotion;
    this.hold = opts.hold;
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("webgl2 unavailable");
    // SOFTWARE GL
    // cpu renderers keep the still; ?gl forces the live path
    if (!opts.forceGl && software(gl)) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      throw new Error("software gl");
    }
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("no float targets");
    this.gl = gl;
    // PROGRAMS
    // all five start compiling at once and are polled, never waited on
    this.parallel = !!gl.getExtension("KHR_parallel_shader_compile");
    this.bakeP = pass(gl, BAKE_FS);
    this.skyP = pass(gl, SKY_FS);
    this.trailP = pass(gl, TRAIL_FS, TRAIL_VS);
    this.sparkP = pass(gl, SPARK_FS, SPARK_VS);
    this.spriteP = pass(gl, SPRITE_FS, SPRITE_VS);
    this.passes = [this.bakeP, this.skyP, this.trailP, this.sparkP, this.spriteP];
    this.dir = new Director(this.reduced);

    // HISTORY
    this.histTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.histTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, HIST_N, ROWS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // TRAILS
    // one instance per strand: its params, then its body row, ring head, count and kind
    this.trailVao = this.vao();
    this.trailMeta = this.instanced(this.meta.byteLength, 0, 4, 32, 0, gl.DYNAMIC_DRAW);
    this.attr(1, 4, 32, 16);

    // SPARKS
    this.sparkVao = this.vao();
    this.sparkBuf = this.instanced(
      MAX_SPARKS * SPARK_STRIDE * 4,
      0,
      3,
      SPARK_STRIDE * 4,
      0,
      gl.DYNAMIC_DRAW,
    );
    this.attr(1, 3, SPARK_STRIDE * 4, 12);
    this.attr(2, 4, SPARK_STRIDE * 4, 24);

    // SPRITES and FLARES: position, dir or tint, radius, light, kind, seed
    this.spriteVao = this.vao();
    this.spriteBuf = this.instanced(this.sprites.byteLength, 0, 3, 40, 0, gl.DYNAMIC_DRAW);
    this.attr(1, 3, 40, 12);
    this.attr(2, 4, 40, 24);
    this.flareVao = this.vao();
    this.flareBuf = this.instanced(this.flares.byteLength, 0, 3, 40, 0, gl.DYNAMIC_DRAW);
    this.attr(1, 3, 40, 12);
    this.attr(2, 4, 40, 24);
    gl.bindVertexArray(null);

    this.fall.onEvent = (e) => {
      if (e === "burst") {
        this.flashGoal = this.reduced ? 0 : this.fall.burst[3] * 1.2;
        this.dir.shock(this.fall.burst[3]);
      }
    };
    this.fall.aim(this.gamma);
    this.dir.plan(this.fall);
  }

  // GL SETUP
  private vao() {
    const v = this.gl.createVertexArray();
    this.gl.bindVertexArray(v);
    this.vaos.push(v);
    return v;
  }

  private instanced(
    data: Float32Array | number,
    slot: number,
    size: number,
    stride: number,
    off: number,
    usage: number,
  ) {
    const gl = this.gl;
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    if (typeof data === "number") gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    else gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    this.bufs.push(b);
    this.attr(slot, size, stride, off);
    return b;
  }

  private attr(slot: number, size: number, stride: number, off: number) {
    const gl = this.gl;
    gl.enableVertexAttribArray(slot);
    gl.vertexAttribPointer(slot, size, gl.FLOAT, false, stride, off);
    gl.vertexAttribDivisor(slot, 1);
  }

  // HOST
  size(w: number, h: number, dpr: number) {
    this.cssW = Math.max(1, w);
    this.cssH = Math.max(1, h);
    this.dpr = dpr;
    this.sized = false;
    this.wake();
  }

  visibility(v: boolean) {
    this.visible = v;
    this.last = 0;
    if (!v) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    this.wake();
  }

  motion(reduced: boolean) {
    this.reduced = reduced;
    this.dir.motion(reduced);
    this.wake();
  }

  // INPUT
  // a tap, a click or Enter sends the next meteor, or cuts short the one in flight
  press(_x: number, _y: number) {
    this.wake();
  }

  drag(_x: number, _y: number) {}

  lift(tap: boolean) {
    if (tap) this.next();
  }

  key(_k: string) {
    this.next();
  }

  private next() {
    this.untouched = 0;
    if (this.fall.active && this.fall.out === OUT.flying) this.launch();
    else this.launchSoon(0);
    this.wake();
  }

  // PASSES
  private launchSoon(ms: number) {
    this.waiting = false;
    this.due = performance.now() + ms;
    this.wake();
  }

  private launch() {
    this.due = 0;
    // each pass picks its own angle: a set order for variety, a little jitter on top
    const n = this.passN++;
    if (n > 0) this.gamma = GAMMAS[n % GAMMAS.length] + (Math.random() - 0.5) * 0.08;
    this.untouched++;
    this.fall.launch(this.gamma);
    this.flash = 0;
    this.dir.start(this.fall);
  }

  // LOOP
  private wake() {
    if (this.dead || this.raf || !this.visible) return;
    clearTimeout(this.timer);
    this.timer = 0;
    this.raf = raf(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible || this.dead) return;
    const gl = this.gl;
    // ?hold: the opening frame only, for the still
    if (this.hold && this.drawn) return;
    if (!this.linked) {
      for (const p of this.passes) if (this.parallel && busy(gl, p)) return this.wake();
      for (const p of this.passes) finish(gl, p);
      this.linked = true;
    }
    if (!this.sized) this.resize();
    if (!this.baked) this.bake();
    const rawMs = this.last ? now - this.last : 0;
    const dt = this.last ? Math.min(MAX_DT_S, Math.max(0, rawMs) / 1000) : 1 / 60;
    this.last = now;

    if (!this.drawn && !this.hold) this.due = now + FIRST_MS;
    if (this.due && now >= this.due && !this.hold) this.launch();

    // SIMULATE
    const f = this.fall;
    const quiet = f.quiet();
    const busyNow = !quiet;
    // the sky moves on at the rate of the shot it is in, then the camera finds it
    const rate = this.reduced ? 0.6 : this.dir.rate;
    const close = this.dir.shot === SHOT.chase;
    if (close && f.closeUp === 1) f.ripSoon();
    f.closeUp = close ? 2 : 1;
    f.rate = rate;
    if (f.active || !quiet) f.step(dt * rate);
    this.dir.update(dt, f, this.cssW / this.cssH, !quiet);
    if (f.active && f.out !== OUT.flying && quiet) f.active = false;
    if (this.flashGoal > 0) {
      this.flash += (this.flashGoal - this.flash) * (1 - Math.exp(-dt / 0.05));
      if (this.flash > this.flashGoal * 0.92) this.flashGoal = 0;
    } else this.flash *= Math.exp(-dt / 0.55);
    if (this.flash < 0.003) this.flash = 0;

    this.adapt(rawMs, busyNow);
    this.render(now);
    if (!this.drawn) {
      this.drawn = true;
      this.onShown();
    }
    this.report(now);

    // SLEEP
    // between passes, with nothing moving, wait on a timer for the next one
    const still = quiet && this.dir.settled() && this.flash === 0;
    if (!f.active && !this.due && !this.waiting && !this.hold) {
      if (this.untouched >= AUTO_PASSES) this.waiting = true;
      else this.due = now + BEAT_MS;
    }
    if (!still || (this.due && now >= this.due - 20)) this.wake();
    else {
      this.last = 0;
      if (this.due) this.timer = setTimeout(() => this.wake(), this.due - now) as unknown as number;
    }
  };

  // QUALITY
  // a run of slow frames lowers the resolution
  private adapt(ms: number, moving: boolean) {
    if (!moving || ms <= 0 || ms > 200) return;
    this.frames++;
    if (ms > SLOW_MS) this.slow++;
    if (this.frames < 40) return;
    if (this.slow > 24 && this.scale > MIN_SCALE) {
      this.scale = Math.max(MIN_SCALE, this.scale * 0.85);
      this.sized = false;
    }
    this.frames = 0;
    this.slow = 0;
  }

  private resize() {
    const gl = this.gl;
    const dpr = Math.min(this.dpr || 1, MAX_DPR) * this.scale;
    const w = Math.max(1, Math.round(this.cssW * dpr));
    const h = Math.max(1, Math.round(this.cssH * dpr));
    this.canvas.width = w;
    this.canvas.height = h;
    // the meteor layer at about one pixel per css pixel
    const k = Math.min(1, 1.25 / dpr);
    const lw = Math.max(1, Math.round(w * k));
    const lh = Math.max(1, Math.round(h * k));
    if (!this.layer || this.layer.w !== lw || this.layer.h !== lh) {
      free(gl, this.layer);
      this.layer = target(gl, lw, lh, true);
    }
    this.sized = true;
  }

  private bake() {
    const gl = this.gl;
    this.cloudT = target(gl, BAKE_PX, BAKE_PX, false, true);
    const p = this.bakeP;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cloudT.fbo);
    gl.viewport(0, 0, BAKE_PX, BAKE_PX);
    gl.useProgram(p.prog);
    gl.uniform2f(p.u.uRes, BAKE_PX, BAKE_PX);
    gl.uniform1i(p.u.uOct, BAKE_OCT);
    gl.bindVertexArray(this.trailVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, this.cloudT.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.baked = true;
  }

  // RENDER
  private camera(p: Pass, w: number, h: number) {
    const gl = this.gl;
    const d = this.dir;
    gl.uniform3fv(p.u.uEye, d.eye);
    gl.uniform3fv(p.u.uRight, d.right);
    gl.uniform3fv(p.u.uUp, d.up);
    gl.uniform3fv(p.u.uFwd, d.fwd);
    gl.uniform1f(p.u.uTan, d.tanHalf);
    gl.uniform1f(p.u.uAspect, w / h);
    gl.uniform2fv(p.u.uShift, d.shift);
    gl.uniform2f(p.u.uRes, w, h);
  }

  private render(now: number) {
    const gl = this.gl;
    const f = this.fall;
    const L = this.layer;
    const C = this.cloudT;
    if (!L || !C) return;
    this.proj.tan = this.dir.tanHalf;
    this.proj.aspect = this.cssW / this.cssH;
    this.build();

    // METEOR LAYER
    gl.bindFramebuffer(gl.FRAMEBUFFER, L.fbo);
    gl.viewport(0, 0, L.w, L.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.histTex);
    if (f.dirty) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, HIST_N, ROWS, gl.RGBA, gl.FLOAT, f.hist);
      f.dirty = false;
    }
    if (this.trailN) {
      const p = this.trailP;
      gl.useProgram(p.prog);
      this.camera(p, L.w, L.h);
      gl.uniform1i(p.u.uHist, 1);
      gl.uniform1f(p.u.uTime, f.t);
      gl.uniform3fv(p.u.uWind, WIND);
      gl.bindVertexArray(this.trailVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.trailMeta);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.meta, 0, this.trailN * 8);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, HIST_N * 2, this.trailN);
    }
    {
      const p = this.sparkP;
      gl.useProgram(p.prog);
      this.camera(p, L.w, L.h);
      gl.uniform3fv(p.u.uCamVel, this.dir.vel);
      gl.bindVertexArray(this.sparkVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, f.sparks);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, MAX_SPARKS);
    }
    if (this.spriteN) {
      const p = this.spriteP;
      gl.useProgram(p.prog);
      this.camera(p, L.w, L.h);
      gl.uniform4fv(p.u.uBite, f.bite);
      gl.uniform4fv(p.u.uCrack, f.crack);
      gl.bindVertexArray(this.spriteVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sprites, 0, this.spriteN * 10);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.spriteN);
    }
    gl.disable(gl.BLEND);

    // COMPOSITE
    const W = this.canvas.width;
    const H = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    const p = this.skyP;
    gl.useProgram(p.prog);
    this.camera(p, W, H);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, C.tex);
    gl.uniform1i(p.u.uCloud, 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, L.tex);
    gl.uniform1i(p.u.uMeteor, 2);
    const e = this.dir.eye;
    const bx = f.alive[0] ? f.px[0] : f.burst[0];
    const by = f.alive[0] ? f.py[0] : f.burst[1];
    const bz = f.alive[0] ? f.pz[0] : f.burst[2];
    gl.uniform1f(p.u.uMeteorDist, Math.hypot(bx - e[0], by - e[1], bz - e[2]) || 100);
    gl.uniform3fv(p.u.uSun, SUN);
    gl.uniform3fv(p.u.uMoon, MOON);
    gl.uniform4f(p.u.uHead, f.px[0], f.py[0], f.pz[0], f.alive[0] ? lit(f.lum[0]) * 0.5 : 0);
    const age = f.t - f.burst[4];
    const be = f.burst[3] * Math.exp(-Math.max(0, age) / (this.reduced ? 1.2 : 0.6));
    gl.uniform4f(p.u.uBurst, f.burst[0], f.burst[1], f.burst[2], be);
    gl.uniform1f(p.u.uFlash, this.flash);
    const sk = this.reduced || f.burst[3] === 0 ? 0 : 1 - smooth(1.6, 2.5, age);
    gl.uniform2f(
      p.u.uShock,
      1 + age * 11 * f.burst[3],
      sk * f.burst[3] * 0.45 * Math.exp(-age / 0.8) * Math.min(1, age / 0.1),
    );
    gl.uniform1f(p.u.uTime, (now / 1000) % 100);
    gl.bindVertexArray(this.trailVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // LENS
    if (this.flareN) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      const q = this.spriteP;
      gl.useProgram(q.prog);
      this.camera(q, W, H);
      gl.bindVertexArray(this.flareVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.flareBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.flares, 0, this.flareN * 10);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.flareN);
      gl.disable(gl.BLEND);
    }
  }

  // INSTANCES
  // strand list, sprites and flares for this frame, into the preallocated arrays
  private build() {
    const f = this.fall;
    const m = this.meta;
    let n = 0;
    for (let b = 0; b < MAX_BODIES; b++) {
      const c = f.count[b];
      if (!c) continue;
      const strands = b === 0 ? STRANDS_MAIN : STRANDS_FRAG;
      for (let s = 0; s < strands; s++) {
        const st = STRAND[b === 0 ? s : s * 3];
        const o = n++ * 8;
        m[o] = st[0];
        m[o + 1] = st[1];
        m[o + 2] = st[2];
        m[o + 3] = st[3];
        m[o + 4] = b * 2;
        m[o + 5] = f.head[b];
        m[o + 6] = c;
        m[o + 7] = (b === 0 ? 0 : 1) + (f.alive[b] ? 0 : 0.3);
      }
    }
    this.trailN = n;

    // SPRITES
    const sp = this.sprites;
    let k = 0;
    for (let b = 0; b < MAX_BODIES; b++) {
      if (!f.alive[b]) continue;
      const o = k++ * 10;
      const v = f.speed(b) || 1;
      sp[o] = f.px[b];
      sp[o + 1] = f.py[b];
      sp[o + 2] = f.pz[b];
      sp[o + 3] = f.vx[b] / v;
      sp[o + 4] = f.vy[b] / v;
      sp[o + 5] = f.vz[b] / v;
      // a vaporising piece shrinks to nothing as it goes
      const fz = f.fuse0[b] > 0 ? Math.max(0, f.fuse[b] / f.fuse0[b]) : 1;
      sp[o + 6] = b ? pieceR(f.mass[b]) * Math.sqrt(fz) : visR(f.mass[b]);
      // heads ease in as they appear and out as the last of the mass goes
      const ease =
        Math.min(1, (f.t - f.born[b]) / (b ? 0.04 : 0.5)) * Math.min(1, f.mass[b] / (b ? 2 : 30));
      sp[o + 7] = Math.max(b ? 0.15 : 0.45, lit(f.lum[b])) * (b ? 0.7 : 1) * ease;
      sp[o + 8] = 0;
      // how worn it is rides in the whole part: 0 fresh to 15 eaten down to the burst
      const worn = Math.min(1, (1 - f.mass[b] / MASS0_KG) / 0.65);
      sp[o + 9] = Math.floor(worn * 15) + f.seed[b] * 0.99 + (b ? 0 : 100); // 100 marks the main body
    }
    // AIRBURST
    // the debris cloud first, so the fireball blooms in front of it, then the shock ring
    const age = f.t - f.burst[4];
    const e = f.burst[3];
    if (e > 0 && age < SMOKE_S) {
      const o = k++ * 10;
      const go = 3.2 * (1 - Math.exp(-age * 1.4)); // km the debris carries on along the path
      sp[o] = f.burst[0] + f.burst[5] * go + WIND[0] * 14 * age;
      sp[o + 1] = f.burst[1] + f.burst[6] * go - 0.06 * age;
      sp[o + 2] = f.burst[2] + f.burst[7] * go + WIND[2] * 14 * age;
      sp[o + 3] = Math.exp(-age / 1.1); // heat
      sp[o + 4] = 0;
      sp[o + 5] = 0;
      sp[o + 6] = (1 + 3.4 * (1 - Math.exp(-age * 0.8))) * e;
      sp[o + 7] = Math.min(1, age / 0.5) * (1 - smooth(SMOKE_S * 0.3, SMOKE_S, age)) * 0.42;
      sp[o + 8] = 7;
      sp[o + 9] = 0.37;
    }
    if (e > 0 && age < 3.5) {
      const calm = this.reduced ? 0.5 : 1;
      const o = k++ * 10;
      sp[o] = f.burst[0];
      sp[o + 1] = f.burst[1];
      sp[o + 2] = f.burst[2];
      sp[o + 3] = Math.min(1, age / 2.4); // how far it has cooled
      sp[o + 4] = 0;
      sp[o + 5] = 0;
      sp[o + 6] = (1.2 + 5.5 * (1 - Math.exp(-age * 2.2))) * e;
      sp[o + 7] =
        1.5 *
        e *
        Math.exp(-age / (0.9 * (this.reduced ? 2 : 1))) *
        calm *
        Math.min(1, age / 0.12) *
        (1 - smooth(2.2, 3.5, age));
      sp[o + 8] = 1;
      sp[o + 9] = 0;
      if (!this.reduced && age < 2.2) {
        const r = k++ * 10;
        sp[r] = f.burst[0];
        sp[r + 1] = f.burst[1];
        sp[r + 2] = f.burst[2];
        sp[r + 3] = 0;
        sp[r + 4] = 1;
        sp[r + 5] = 0;
        sp[r + 6] = 1 + age * 11 * e;
        sp[r + 7] = e * Math.exp(-age / 0.8) * Math.min(1, age / 0.1) * (1 - smooth(1.2, 2.2, age));
        sp[r + 8] = 2;
        sp[r + 9] = 0;
      }
    }
    this.spriteN = k;
    this.flareBuild();
  }

  // LENS
  // ghosts on the line from the head through the centre of the frame, and a long streak
  private flareBuild() {
    const f = this.fall;
    this.flareN = 0;
    if (!f.alive[0] || this.reduced) return;
    const d = this.dir;
    const e = d.eye;
    const x = f.px[0] - e[0];
    const y = f.py[0] - e[1];
    const z = f.pz[0] - e[2];
    const w = x * d.fwd[0] + y * d.fwd[1] + z * d.fwd[2];
    if (w < 0.01) return;
    const a = this.proj.aspect;
    const t = this.proj.tan;
    const sx = (x * d.right[0] + y * d.right[1] + z * d.right[2]) / (t * a * w) + d.shift[0];
    const sy = (x * d.up[0] + y * d.up[1] + z * d.up[2]) / (t * w) + d.shift[1];
    if (Math.abs(sx) > 1.1 || Math.abs(sy) > 1.1) return;
    const L = Math.min(1, lit(f.lum[0]) * 0.5) * (d.shot === SHOT.chase ? 0.5 : 1);
    if (L < 0.02) return;
    const fl = this.flares;
    let k = 0;
    for (let gi = 0; gi < GHOSTS.length; gi++) {
      const g = GHOSTS[gi];
      const o = k++ * 10;
      fl[o] = sx * g[0];
      fl[o + 1] = sy * g[0];
      fl[o + 2] = 0;
      fl[o + 3] = g[3] * 0.06;
      fl[o + 4] = g[4] * 0.06;
      fl[o + 5] = g[5] * 0.06;
      fl[o + 6] = g[1] * (this.cssH / 900);
      fl[o + 7] = L;
      fl[o + 8] = g[2];
      fl[o + 9] = 0;
    }
    const o = k++ * 10;
    fl[o] = sx;
    fl[o + 1] = sy;
    fl[o + 2] = 0;
    fl[o + 3] = 0.25;
    fl[o + 4] = 0.4;
    fl[o + 5] = 0.75;
    fl[o + 6] = this.cssW * 0.35;
    fl[o + 7] = L;
    fl[o + 8] = 6;
    fl[o + 9] = 0;
    this.flareN = k;
  }

  // HUD
  private report(now: number) {
    if (now - this.hudAt < HUD_MS) return;
    this.hudAt = now;
    const f = this.fall;
    const h = this.hud;
    const flying = f.active && f.out === OUT.flying;
    h.alt = flying ? f.py[0] : 0;
    h.speed = flying ? f.speed(0) : 0;
    if (f.active) h.mass = f.alive[0] ? f.mass[0] : 0;
    h.left = h.mass / MASS0_KG;
    h.entry = (this.gamma * 180) / Math.PI;
    h.phase = !f.active
      ? this.waiting
        ? "Waiting"
        : "Incoming"
      : flying
        ? f.lum[0] > 0.6
          ? "Ablating"
          : "Entering"
        : f.out === OUT.burst
          ? "Airburst"
          : f.out === OUT.skip
            ? "Skipped out"
            : "Burnt out";
    h.shot = SHOT_NAMES[this.dir.shot];
    h.waiting = this.waiting;
    this.onHud(h);
  }

  dispose() {
    this.dead = true;
    unraf(this.raf);
    clearTimeout(this.timer);
    this.raf = 0;
    const gl = this.gl;
    free(gl, this.layer);
    free(gl, this.cloudT);
    gl.deleteTexture(this.histTex);
    for (const p of this.passes) gl.deleteProgram(p.prog);
    for (const v of this.vaos) gl.deleteVertexArray(v);
    for (const b of this.bufs) gl.deleteBuffer(b);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

// light as drawn, softened so the brightest moments do not all read the same
function lit(l: number) {
  return (2.2 * Math.sqrt(l)) / (1 + 0.3 * l);
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function norm(v: number[]) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return new Float32Array([v[0] / l, v[1] / l, v[2] / l]);
}
