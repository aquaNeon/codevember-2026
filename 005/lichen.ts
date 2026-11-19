// LICHEN
// colonies spread over a half resolution arrival-time field: every texel stores when the
// nearest colony reaches it, so growth is a smooth front and two colonies stop where they meet.
// the loop only runs while some colony is still spreading; then the frame just stays.
// no dom in here, so the whole scene can run in a worker on an offscreen canvas

import {
  busy,
  finish,
  free,
  pass,
  raf,
  software,
  target,
  unraf,
  type Opts,
  type Pass,
  type Target,
} from "./gl";
import { COPY_FS, GROW_FS, MAX_AGE_S, MAX_COLONIES, SHOW_FS, STONE_FS } from "./shaders";

const MAX_DPR = 2;
const SIM_SCALE = 0.5;
const MAX_DT_S = 1 / 20;
const UNITS = 60; // the short side of the screen is this many units, lichen is sized in units
const SPEED_U = 2.1; // young spread speed in units per second, change for bigger colonies
const SETTLE_S = MAX_AGE_S + 6; // cups and rims finish this long after the last planting
const SPECIES = 4;
const LOBE_MAX = 1.9; // fastest lobe relative to the mean, sets how many passes a frame needs
const EMPTY = new Float32Array([64, 64, -1, 0]); // matches SENT in the shaders

export type Colony = { x: number; y: number; species: number; size: number };

export class Lichen {
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private grow: Pass;
  private copy: Pass;
  private stonePass: Pass;
  private show: Pass;
  private parallel: boolean;
  private linked = false;
  private linkedCount = 0;
  private pending: Pass[];
  private state: Target[] = [];
  private stone: Target | undefined;
  private seeds = new Float32Array(MAX_COLONIES * 4);
  private colonies: Colony[] = [];
  private queue: Colony[] = [];
  private raf = 0;
  private last = 0;
  private time = 0;
  private lastPlant = -1e9;
  private visible = false;
  private sized = false;
  private clear = false;
  private reducedMotion: boolean;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private drawn = false;

  onState: (colonies: number, growing: boolean) => void = () => {};
  onShown: () => void = () => {};

  // AVOID
  // the title and hud: colonies are seeded away from them and only creep in slowly
  private boxes = new Float32Array([-1e4, -1e4, -1e4, -1e4, -1e4, -1e4, -1e4, -1e4]);
  private uvBoxes = new Float32Array(8); // the same, in 0..1 from the top left
  private probe = new Float32Array(4);

  constructor(
    private canvas: HTMLCanvasElement | OffscreenCanvas,
    opts: Opts,
  ) {
    this.reducedMotion = opts.reducedMotion;
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: true,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("webgl2 unavailable");
    // SOFTWARE GL
    // cpu renderers get the still before any shader compiles; ?gl forces the live path
    if (!opts.forceGl && software(gl)) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      throw new Error("software gl");
    }
    if (
      !gl.getExtension("EXT_color_buffer_float") &&
      !gl.getExtension("EXT_color_buffer_half_float")
    )
      throw new Error("no float targets");
    this.gl = gl;
    this.parallel = !!gl.getExtension("KHR_parallel_shader_compile");
    const slate = opts.variant === "b";
    this.grow = pass(gl, GROW_FS);
    this.copy = pass(gl, COPY_FS);
    this.stonePass = pass(gl, slate ? STONE_FS.replace("#ifdef SLATE", "#if 1") : STONE_FS);
    this.show = pass(gl, SHOW_FS);
    this.pending = [this.grow, this.copy, this.stonePass, this.show];
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("no vao");
    this.vao = vao;
  }

  // HOST
  // css size and device pixel ratio of the canvas
  size(w: number, h: number, dpr: number) {
    this.cssW = Math.max(1, w);
    this.cssH = Math.max(1, h);
    this.dpr = dpr;
    this.sized = false;
    this.wake();
  }

  // on screen and the tab visible
  visibility(v: boolean) {
    this.visible = v;
    this.last = 0;
    this.wake();
  }

  motion(reduced: boolean) {
    this.reducedMotion = reduced;
    this.wake();
  }

  // the title and hud, as two boxes in 0..1 from the top left
  avoid(b: number[]) {
    for (let i = 0; i < 8; i++) this.uvBoxes[i] = b[i] ?? -1;
    this.sized = false;
    this.wake();
  }

  get count() {
    return this.colonies.length + this.queue.length;
  }

  // PUBLIC
  // x, y in 0..1 from the top left
  // false when there is no room: the stone is full, or that spot is already lichen
  // with fallback, a spot in the title or hud, or on lichen, goes somewhere else instead
  plant(x: number, y: number, species = -1, fallback = false) {
    if (fallback && (this.inBox(x, y) || this.covered(x, y))) return this.plantSomewhere();
    if (this.count >= MAX_COLONIES || this.covered(x, y)) return false;
    if (species < 0) species = this.pick(x, y);
    this.queue.push({ x, y: 1 - y, species, size: 0.75 + Math.random() * 0.5 });
    this.wake();
    return true;
  }

  // somewhere bare, clear of the title and hud
  plantSomewhere() {
    for (let i = 0; i < 24; i++) {
      const x = 0.08 + Math.random() * 0.84;
      const y = 0.12 + Math.random() * 0.76;
      if (this.inBox(x, y)) continue;
      if (this.plant(x, y)) return true;
    }
    return false;
  }

  private inBox(x: number, y: number) {
    const b = this.uvBoxes;
    for (let i = 0; i < 8; i += 4)
      if (x > b[i] && x < b[i + 2] && y > b[i + 1] && y < b[i + 3]) return true;
    return false;
  }

  // reads the one texel under a click; a click is rare enough for the stall
  private covered(x: number, y: number) {
    const t = this.state[0];
    if (!t) return false;
    const gl = this.gl;
    const px = Math.min(t.w - 1, Math.max(0, Math.floor(x * t.w)));
    const py = Math.min(t.h - 1, Math.max(0, Math.floor((1 - y) * t.h)));
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.FLOAT, this.probe);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (gl.getError() !== gl.NO_ERROR) return false;
    const [r, a, id] = this.probe;
    return id >= 0 && a < MAX_AGE_S && r < 0.5;
  }

  wipe() {
    this.colonies.length = 0;
    this.queue.length = 0;
    this.seeds.fill(0);
    this.clear = true;
    this.lastPlant = -1e9;
    this.wake();
  }

  // a species unlike the nearest neighbour, so meeting colonies read as two
  private pick(x: number, y: number) {
    let near = -1;
    let best = Infinity;
    for (const c of this.colonies.concat(this.queue)) {
      const d = (c.x - x) ** 2 + (1 - c.y - y) ** 2;
      if (d < best) {
        best = d;
        near = c.species;
      }
    }
    let s = Math.floor(Math.random() * SPECIES);
    if (s === near) s = (s + 1 + Math.floor(Math.random() * (SPECIES - 1))) % SPECIES;
    return s;
  }

  // LOOP
  private wake() {
    if (!this.raf && this.visible) this.raf = raf(this.frame);
  }

  private growing() {
    return this.queue.length > 0 || this.clear || this.time - this.lastPlant < SETTLE_S;
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible) return;
    const gl = this.gl;
    if (!this.linked) {
      // one program per frame, so a driver without parallel compile blocks in short bursts
      const p = this.pending[this.linkedCount];
      if (!(this.parallel && busy(gl, p))) {
        finish(gl, p);
        this.linkedCount++;
      }
      this.linked = this.linkedCount === this.pending.length;
      this.wake();
      return;
    }
    const dt = this.last ? Math.min(MAX_DT_S, Math.max(0, now - this.last) / 1000) : 1 / 60;
    this.last = now;
    const resized = !this.sized;
    if (resized) this.resize();
    const active = this.growing();
    if (this.reducedMotion) {
      if (active) this.settle();
    } else if (active) this.step(dt);
    if (active || resized) this.draw();
    if (!this.drawn) {
      this.drawn = true;
      this.onShown();
    }
    this.onState(this.count, this.growing());
    if (!this.reducedMotion && this.growing()) this.wake();
    else this.last = 0;
  };

  // one frame of growth: several passes so the computed front stays ahead of the shown one
  private step(dt: number) {
    this.time += dt;
    const fresh = this.queue.shift();
    if (fresh) {
      this.colonies.push(fresh);
      this.lastPlant = this.time;
      this.upload();
    }
    const t = this.state[0];
    const unit = Math.min(t.w, t.h) / UNITS;
    const fastest = SPEED_U * unit * 1.25 * LOBE_MAX;
    const passes = Math.min(6, Math.ceil(fastest * dt * 1.5) + 1);
    for (let i = 0; i < passes; i++) this.pass(i === 0 ? dt : 0, i === 0 ? fresh : undefined);
    this.clear = false;
  }

  // reduced motion: run the whole growth out of sight, then show the end
  private settle() {
    while (this.queue.length) {
      this.colonies.push(this.queue.shift() as Colony);
      this.upload();
      this.pass(0, this.colonies[this.colonies.length - 1]);
    }
    const t = this.state[0];
    const unit = Math.min(t.w, t.h) / UNITS;
    const stepS = 1 / Math.max(1, SPEED_U * unit * 1.25 * LOBE_MAX);
    for (let s = 0; s < SETTLE_S; s += stepS) this.pass(stepS);
    this.clear = false;
    this.time += SETTLE_S;
    this.lastPlant = -1e9;
  }

  private upload() {
    const s = this.seeds;
    const t = this.state[0];
    for (let i = 0; i < this.colonies.length; i++) {
      const c = this.colonies[i];
      s[i * 4] = c.x * t.w;
      s[i * 4 + 1] = c.y * t.h;
      s[i * 4 + 2] = c.species;
      s[i * 4 + 3] = c.size;
    }
  }

  private pass(shift: number, fresh?: Colony) {
    const gl = this.gl;
    const p = this.grow;
    const src = this.state[0];
    const dst = this.state[1];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.useProgram(p.prog);
    this.tex(p, "uPrev", 0, src.tex);
    gl.uniform4fv(p.u.uSeeds, this.seeds);
    const unit = Math.min(src.w, src.h) / UNITS;
    if (fresh)
      gl.uniform4f(p.u.uNew, fresh.x * src.w, fresh.y * src.h, this.colonies.length - 1, 1);
    else gl.uniform4f(p.u.uNew, 0, 0, 0, 0);
    gl.uniform1f(p.u.uShift, shift);
    gl.uniform1f(p.u.uSpeed, SPEED_U * unit);
    gl.uniform1f(p.u.uUnit, unit);
    gl.uniform1f(p.u.uClear, this.clear ? 1 : 0);
    gl.uniform4fv(p.u.uAvoid, this.boxes);
    this.draw3();
    this.state.reverse();
  }

  private draw() {
    const gl = this.gl;
    const p = this.show;
    const t = this.state[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(p.prog);
    this.tex(p, "uState", 0, t.tex);
    if (this.stone) this.tex(p, "uStone", 1, this.stone.tex);
    gl.uniform2f(p.u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform2f(p.u.uSim, t.w, t.h);
    gl.uniform4fv(p.u.uSeeds, this.seeds);
    const unit = Math.min(t.w, t.h) / UNITS;
    gl.uniform1f(p.u.uSpeed, SPEED_U * unit);
    gl.uniform1f(p.u.uUnit, unit);
    this.draw3();
  }

  // GL HELPERS
  private tex(p: Pass, name: string, unit: number, t: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(p.u[name], unit);
  }

  private draw3() {
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  // RESIZE
  // the field is carried over to the new size, the stone is drawn again
  private resize() {
    const gl = this.gl;
    const dpr = Math.min(this.dpr || 1, MAX_DPR);
    const w = Math.max(1, Math.round(this.cssW * dpr));
    const h = Math.max(1, Math.round(this.cssH * dpr));
    this.canvas.width = w;
    this.canvas.height = h;
    const sw = Math.max(2, Math.round(w * SIM_SCALE));
    const sh = Math.max(2, Math.round(h * SIM_SCALE));
    const old = this.state[0];
    if (!old || old.w !== sw || old.h !== sh) {
      const next = [target(gl, sw, sh, true), target(gl, sw, sh, true)];
      if (old) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, next[0].fbo);
        gl.viewport(0, 0, sw, sh);
        gl.useProgram(this.copy.prog);
        this.tex(this.copy, "uPrev", 0, old.tex);
        gl.uniform2f(this.copy.u.uRatio, old.w / sw, old.h / sh);
        this.draw3();
      } else this.clear = true;
      for (const t of this.state) free(gl, t);
      this.state = next;
      if (this.clear) {
        // first fill: everything empty
        for (const t of next) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
          gl.clearBufferfv(gl.COLOR, 0, EMPTY);
        }
        this.clear = false;
      }
      this.upload();
    }
    const t = this.state[0];
    for (let i = 0; i < 2; i++) {
      const u = this.uvBoxes;
      if (u[i * 4 + 2] <= u[i * 4]) continue;
      // y flips: sim px are y up
      this.boxes[i * 4] = u[i * 4] * t.w;
      this.boxes[i * 4 + 1] = (1 - u[i * 4 + 3]) * t.h;
      this.boxes[i * 4 + 2] = u[i * 4 + 2] * t.w;
      this.boxes[i * 4 + 3] = (1 - u[i * 4 + 1]) * t.h;
    }
    free(gl, this.stone);
    this.stone = target(gl, w, h, false);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stone.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.stonePass.prog);
    gl.uniform2f(this.stonePass.u.uRes, w, h);
    gl.uniform1f(this.stonePass.u.uUnit, Math.min(w, h) / UNITS);
    this.draw3();
    this.sized = true;
  }

  dispose() {
    unraf(this.raf);
    this.raf = 0;
    const gl = this.gl;
    for (const t of this.state) free(gl, t);
    this.state = [];
    free(gl, this.stone);
    for (const p of [this.grow, this.copy, this.stonePass, this.show]) gl.deleteProgram(p.prog);
    gl.deleteVertexArray(this.vao);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
