// VEIL
// no dom, so it runs in a worker; passes: lamp opacity, weighted blended cloth, composite

import { Cloth, LENGTH_M, N, NX, NY, SPAN_MAX_M, STEP_S, WIDTH_M } from "./cloth";
import { busy, finish, pass, raf, software, unraf, type Opts, type Pass } from "./gl";
import { CLOTH_FS, CLOTH_VS, COMP_FS, OPAC_FS, OPAC_VS } from "./shaders";

const MAX_DPR = 2;
const MAX_DT_S = 1 / 15;
const MAX_STEPS = 3;
const WARM_S = 6;
const OPAC_PX = 384;
const SUB = 3;
const END_OUT = 1.2;
const FOV_DEG = 36;
const EYE_Z = 4.1;
const FREQ = 420; // change thread density here
const SHEER = 0.055; // change single-layer cover here
const SLOW_MS = 26;
const MIN_SCALE = 0.6;
const HUD_MS = 160;
// LAMP
// key light behind the cloth, high right
const LIGHT = norm([0.5, 0.55, -0.68]);
const CLEAR_ACCUM = new Float32Array([0, 0, 0, 1]);
const CLEAR_WEIGHT = new Float32Array([0, 0, 0, 0]);
const FILL = norm([-0.6, 0.15, 0.78]);

export type Hud = { drift: number; span: number };

type Target = { fbo: WebGLFramebuffer; tex: WebGLTexture[] };

export class Veil {
  onShown: () => void = () => {};
  onHud: (h: Hud) => void = () => {};

  private gl: WebGL2RenderingContext;
  private parallel: boolean;
  private opacP: Pass;
  private clothP: Pass;
  private compP: Pass;
  private passes: Pass[];
  private linked = false;
  private vao: WebGLVertexArrayObject;
  private empty: WebGLVertexArrayObject;
  private bufs: WebGLBuffer[] = [];
  private texX: WebGLTexture;
  private texN: WebGLTexture;
  private indexN: number;
  private opac: Target;
  private oit: Target | null = null;

  private cloth = new Cloth();
  private raf = 0;
  private last = 0;
  private acc = 0;
  private visible = false;
  private sized = false;
  private drawn = false;
  private dead = false;
  private reduced: boolean;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private scale = 1;
  private slow = 0;
  private frames = 0;
  private W = 1;
  private H = 1;
  private tanX = 1;
  private tanY = 1;
  private eyeZ = EYE_Z;
  private vp = new Float32Array(16);
  private lx = new Float32Array(3);
  private ly = new Float32Array(3);
  private rect = new Float32Array(4);
  private depth = new Float32Array(2);
  // POINTER
  private mx = 0;
  private my = 0;
  private mT = -1;
  private hudAt = 0;
  private hud: Hud = { drift: 0, span: 0 };

  constructor(
    private canvas: HTMLCanvasElement | OffscreenCanvas,
    opts: Opts,
  ) {
    this.reduced = opts.reducedMotion;
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
    if (!gl.getExtension("EXT_color_buffer_float")) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      throw new Error("no float targets");
    }
    this.gl = gl;
    this.parallel = !!gl.getExtension("KHR_parallel_shader_compile");
    this.opacP = pass(gl, OPAC_FS, OPAC_VS);
    this.clothP = pass(gl, CLOTH_FS, CLOTH_VS);
    this.compP = pass(gl, COMP_FS);
    this.passes = [this.opacP, this.clothP, this.compP];
    this.opac = this.target(OPAC_PX, OPAC_PX, 1);

    // MESH
    // the particles stream in as two small float textures; the drawn grid is fixed
    const c = this.cloth;
    this.texX = this.grid();
    this.texN = this.grid();
    this.empty = gl.createVertexArray();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const GX = (NX - 1) * SUB + 1;
    const GY = (NY - 1) * SUB + 1;
    const g = new Float32Array(GX * GY * 2);
    for (let j = 0; j < GY; j++)
      for (let i = 0; i < GX; i++) {
        g[(j * GX + i) * 2] = i / SUB;
        g[(j * GX + i) * 2 + 1] = j / SUB;
      }
    this.buffer(gl.ARRAY_BUFFER, g, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    const idx = new Uint16Array((GX - 1) * (GY - 1) * 6);
    let k = 0;
    for (let j = 0; j < GY - 1; j++)
      for (let i = 0; i < GX - 1; i++) {
        const a = j * GX + i;
        idx[k++] = a;
        idx[k++] = a + GX;
        idx[k++] = a + 1;
        idx[k++] = a + 1;
        idx[k++] = a + GX;
        idx[k++] = a + GX + 1;
      }
    this.indexN = k;
    this.buffer(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    // WARM START
    if (this.reduced) c.wind *= 0.5;
    for (let s = 0; s < WARM_S / STEP_S; s++) {
      c.normals();
      c.step(STEP_S);
    }
    c.normals();
    this.lamp();
  }

  private buffer(target: number, data: ArrayBufferView, usage: number) {
    const gl = this.gl;
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, usage);
    this.bufs.push(b);
    return b;
  }

  private grid() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB32F, NX, NY);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  }

  private target(w: number, h: number, count: number): Target {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const tex: WebGLTexture[] = [];
    const bufs: number[] = [];
    for (let i = 0; i < count; i++) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      tex.push(t);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    }
    gl.drawBuffers(bufs);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("framebuffer");
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex };
  }

  private drop(t: Target | null) {
    if (!t) return;
    const gl = this.gl;
    for (const x of t.tex) gl.deleteTexture(x);
    gl.deleteFramebuffer(t.fbo);
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
    this.wake();
  }

  motion(reduced: boolean) {
    this.reduced = reduced;
    this.wake();
  }

  // INPUT
  // pointer is air: the cloth is pushed along and lifted where it passes
  point(x: number, y: number, ms: number) {
    const s = ms / 1000;
    const nx = (x / this.cssW) * 2 - 1;
    const ny = 1 - (y / this.cssH) * 2;
    if (this.mT >= 0 && s > this.mT && s - this.mT < 0.2) {
      const dt = s - this.mT;
      // VELOCITY
      // at the cloth's depth, capped so a flick stays gentle
      const k = (this.eyeZ / dt) * (this.reduced ? 0.4 : 1);
      let vx = (nx - this.mx) * this.tanX * k;
      let vy = (ny - this.my) * this.tanY * k;
      const sp = Math.hypot(vx, vy);
      if (sp > 1.6) {
        vx *= 1.6 / sp;
        vy *= 1.6 / sp;
      }
      const dx = nx * this.tanX;
      const dy = ny * this.tanY;
      const l = Math.hypot(dx, dy, 1);
      this.cloth.breath(0, 0, this.eyeZ, dx / l, dy / l, -1 / l, vx, vy, 0);
    }
    this.mx = nx;
    this.my = ny;
    this.mT = s;
    this.wake();
  }

  leave() {
    this.mT = -1;
  }

  // LOOP
  // the cloth never stops, so this runs whenever the canvas is on screen
  private wake() {
    if (this.dead || this.raf || !this.visible) return;
    this.raf = raf(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible || this.dead) return;
    const gl = this.gl;
    if (!this.linked) {
      for (const p of this.passes) if (this.parallel && busy(gl, p)) return this.wake();
      for (const p of this.passes) finish(gl, p);
      this.linked = true;
    }
    if (!this.sized) this.resize();
    const rawMs = this.last ? now - this.last : 0;
    const dt = this.last ? Math.min(MAX_DT_S, Math.max(0, rawMs) / 1000) : STEP_S;
    this.last = now;

    // SIMULATE
    // fixed step; reduced motion slows the air
    const c = this.cloth;
    c.wind = this.reduced ? 0.2 : 0.7;
    this.acc = Math.min(this.acc + dt * (this.reduced ? 0.35 : 1), MAX_STEPS * STEP_S);
    let stepped = false;
    while (this.acc >= STEP_S) {
      c.normals();
      c.step(STEP_S);
      this.acc -= STEP_S;
      stepped = true;
    }
    if (stepped || !this.drawn) {
      c.normals();
      this.lamp();
      this.adapt(rawMs);
      this.render();
    }
    if (!this.drawn) {
      this.drawn = true;
      this.onShown();
    }
    this.report(now);
    this.wake();
  };

  // QUALITY
  private adapt(ms: number) {
    if (ms <= 0 || ms > 200) return;
    this.frames++;
    if (ms > SLOW_MS) this.slow++;
    if (this.frames < 50) return;
    if (this.slow > 30 && this.scale > MIN_SCALE) {
      this.scale = Math.max(MIN_SCALE, this.scale * 0.85);
      this.sized = false;
    }
    this.frames = 0;
    this.slow = 0;
  }

  // FRAMING
  // long lens; tall screens step back to keep the cloth width
  private resize() {
    const a = this.cssW / this.cssH;
    // DPR FLOOR
    // 1.5 minimum so the thin hems hold
    const dpr = Math.min(Math.max(this.dpr || 1, 1.5), MAX_DPR) * this.scale;
    this.W = Math.max(1, Math.round(this.cssW * dpr));
    this.H = Math.max(1, Math.round(this.cssH * dpr));
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.tanY = Math.tan(((FOV_DEG / 2) * Math.PI) / 180);
    this.tanX = this.tanY * a;
    this.eyeZ = Math.max(EYE_Z, 1.75 / this.tanX);
    // LEAN
    // tall screens stand the path up the frame
    const lean = Math.min(1, Math.max(0, (1.05 - a) / 0.55));
    const tilt = lean * 1.15;
    this.cloth.tilt = tilt;
    if (a < 1) this.eyeZ = Math.max(EYE_Z, (1.6 + 0.6 * lean) / this.tanY);
    // ENDS OUT OF FRAME
    // reaches past the frame along the lean; on ultrawide the eye steps in instead
    const reach = (z: number) =>
      2 *
      Math.min(
        (z * this.tanX) / Math.max(Math.cos(tilt), 1e-3),
        (z * this.tanY) / Math.max(Math.sin(tilt), 1e-3),
      );
    const need = reach(this.eyeZ) * END_OUT;
    if (need > SPAN_MAX_M) this.eyeZ *= SPAN_MAX_M / need;
    this.cloth.span = Math.min(SPAN_MAX_M, need);
    if (!this.drawn) this.cloth.settle(STEP_S, 90);
    const f = 1 / this.tanY;
    const near = 0.1;
    const far = 20;
    const m = this.vp;
    m.fill(0);
    m[0] = f / a;
    m[5] = f;
    m[10] = (far + near) / (near - far);
    m[11] = -1;
    m[14] = (2 * far * near) / (near - far);
    // VIEW
    // eye at (0, 0, eyeZ) looking down -z, folded into the projection
    m[14] += m[10] * -this.eyeZ;
    m[15] = this.eyeZ;
    this.drop(this.oit);
    this.oit = this.target(this.W, this.H, 2);
    this.sized = true;
  }

  // LAMP FRAME
  // refitted round the cloth every frame
  private lamp() {
    const L = LIGHT;
    const lx = this.lx;
    const ly = this.ly;
    lx[0] = -L[2];
    lx[1] = 0;
    lx[2] = L[0];
    const ll = Math.hypot(lx[0], lx[2]);
    lx[0] /= ll;
    lx[2] /= ll;
    ly[0] = L[1] * lx[2] - L[2] * lx[1];
    ly[1] = L[2] * lx[0] - L[0] * lx[2];
    ly[2] = L[0] * lx[1] - L[1] * lx[0];
    const x = this.cloth.x;
    let x0 = 1e9;
    let x1 = -1e9;
    let y0 = 1e9;
    let y1 = -1e9;
    let z0 = 1e9;
    let z1 = -1e9;
    for (let i = 0; i < N; i++) {
      const px = x[i * 3];
      const py = x[i * 3 + 1];
      const pz = x[i * 3 + 2];
      const a = px * lx[0] + py * lx[1] + pz * lx[2];
      const b = px * ly[0] + py * ly[1] + pz * ly[2];
      const d = px * L[0] + py * L[1] + pz * L[2];
      if (a < x0) x0 = a;
      if (a > x1) x1 = a;
      if (b < y0) y0 = b;
      if (b > y1) y1 = b;
      if (d < z0) z0 = d;
      if (d > z1) z1 = d;
    }
    const r = this.rect;
    r[0] = (x0 + x1) / 2;
    r[1] = (y0 + y1) / 2;
    r[2] = (x1 - x0) / 2 + 0.05;
    r[3] = (y1 - y0) / 2 + 0.05;
    this.depth[0] = z0 - 0.02;
    this.depth[1] = z1 + 0.02;
  }

  private lampUniforms(p: Pass) {
    const gl = this.gl;
    gl.uniform3fv(p.u.uLX, this.lx);
    gl.uniform3fv(p.u.uLY, this.ly);
    gl.uniform3f(p.u.uLZ, LIGHT[0], LIGHT[1], LIGHT[2]);
    gl.uniform4fv(p.u.uLRect, this.rect);
    gl.uniform2fv(p.u.uLDepth, this.depth);
    gl.uniform1f(p.u.uSheer, SHEER);
    gl.uniform2f(p.u.uSize, WIDTH_M, LENGTH_M);
    gl.uniform1i(p.u.uX, 1);
    gl.uniform1i(p.u.uN, 2);
  }

  private render() {
    const gl = this.gl;
    const oit = this.oit;
    if (!oit) return;
    const c = this.cloth;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texX);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NX, NY, gl.RGB, gl.FLOAT, c.x);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.texN);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NX, NY, gl.RGB, gl.FLOAT, c.n);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);

    // OPACITY
    // optical depth per slice, from the lamp
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.opac.fbo);
    gl.viewport(0, 0, OPAC_PX, OPAC_PX);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    let p = this.opacP;
    gl.useProgram(p.prog);
    this.lampUniforms(p);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawElements(gl.TRIANGLES, this.indexN, gl.UNSIGNED_SHORT, 0);

    // CLOTH
    // colour weighted by cover, plus remaining ground transmittance
    gl.bindFramebuffer(gl.FRAMEBUFFER, oit.fbo);
    gl.viewport(0, 0, this.W, this.H);
    gl.clearBufferfv(gl.COLOR, 0, CLEAR_ACCUM);
    gl.clearBufferfv(gl.COLOR, 1, CLEAR_WEIGHT);
    p = this.clothP;
    gl.useProgram(p.prog);
    this.lampUniforms(p);
    gl.uniformMatrix4fv(p.u.uVP, false, this.vp);
    gl.uniform3f(p.u.uEye, 0, 0, this.eyeZ);
    gl.uniform3f(p.u.uLight, LIGHT[0], LIGHT[1], LIGHT[2]);
    gl.uniform3f(p.u.uLightC, 6.2, 5.3, 4.3);
    gl.uniform3f(p.u.uFill, FILL[0], FILL[1], FILL[2]);
    gl.uniform3f(p.u.uTint, 1.0, 0.94, 0.87);
    gl.uniform1f(p.u.uFreq, FREQ);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.opac.tex[0]);
    gl.uniform1i(p.u.uOpac, 0);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawElements(gl.TRIANGLES, this.indexN, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.BLEND);

    // COMPOSITE
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    p = this.compP;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, oit.tex[0]);
    gl.uniform1i(p.u.uAccum, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, oit.tex[1]);
    gl.uniform1i(p.u.uWeight, 1);
    gl.uniform2f(p.u.uRes, this.W, this.H);
    gl.uniform2f(p.u.uGlow, 0.64, 0.62);
    gl.uniform1f(p.u.uAspect, this.W / this.H);
    gl.bindVertexArray(this.empty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }

  // HUD
  private report(now: number) {
    if (now - this.hudAt < HUD_MS) return;
    this.hudAt = now;
    const x = this.cloth.x;
    const a = 0;
    const b = (N - NX) * 3;
    const h = this.hud;
    h.drift = this.cloth.speed * 100;
    h.span = Math.hypot(x[b] - x[a], x[b + 1] - x[a + 1], x[b + 2] - x[a + 2]);
    this.onHud(h);
  }

  dispose() {
    this.dead = true;
    unraf(this.raf);
    this.raf = 0;
    const gl = this.gl;
    for (const p of this.passes) gl.deleteProgram(p.prog);
    this.drop(this.opac);
    this.drop(this.oit);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.texX);
    gl.deleteTexture(this.texN);
    gl.deleteVertexArray(this.empty);
    for (const b of this.bufs) gl.deleteBuffer(b);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function norm(v: [number, number, number]) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l] as const;
}
