import {
  BufferGeometry,
  DepthTexture,
  DoubleSide,
  FrontSide,
  Float32BufferAttribute,
  GLSL3,
  HalfFloatType,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PerspectiveCamera,
  Points,
  RawShaderMaterial,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
  type IUniform,
  type Material,
} from "three";
import { INK_FS, INK_VS, ORBIT_FS, ORBIT_VS, POST_FS, POST_VS } from "./shaders";
import { PLANETS, PLANET_Y, RATIO, build, pose, type Kind, type Rig } from "./parts";

const MAX_DT_S = 1 / 20;
const FOV_DEG = 26;
const PITCH_RAD = 0.36;
const FIT_W = 6.7;
const FIT_W_NARROW = 4.1;
const FIT_H = 3.2;
const REF_PX_PER_UNIT = 228;
const TARGET_Y = 1.42;
const SHIFT = 0.05;
const SPACING_PX = 4.6; // change line spacing here
const EDGE_PX = 0.85;
const IDLE_RAD_S = 0.075;
const DRAG_TAU_S = 0.06;
const VEL_TAU_S = 0.08;
const COAST_TAU_S = 1.8;
const MAX_COAST_RAD_S = 2.5;
const PICK_PX = 22;
const PICK_TOUCH_PX = 46;
const INK = [0.15, 0.11, 0.075];
const DOT_GAP = 0.036;
const DOT_PX = 1.7;
const DOT_ALPHA = 0.75;
const TRACE_GAP = 0.006;
const TRACE_TAU_S = 0.22;

// HATCH AXES
// plane normals of the two object-space line families per kind
const AXES: Record<Kind, [number[], number[]]> = {
  drum: [
    [1, 0, 0.25],
    [0, 1, 0],
  ],
  brass: [
    [1, 0, 0.15],
    [0.55, 0.75, 0.35],
  ],
  rod: [
    [1, 0, 0.2],
    [0.5, 0.8, 0],
  ],
  arm: [
    [0, 0.6, 0.8],
    [0.8, 0.5, 0],
  ],
  gear: [
    [0.9, 0.3, 0.3],
    [0.2, 0.3, 0.95],
  ],
  plate: [
    [0.95, 0.2, 0.25],
    [0.3, 0.2, 0.95],
  ],
  globe: [
    [0.3, 1, 0.15],
    [0.9, -0.2, 0.4],
  ],
  sun: [
    [0.2, 1, 0.1],
    [1, 0, 0.3],
  ],
  ground: [
    [0, 0, 1],
    [0.6, 0, 0.8],
  ],
  band: [
    [0.3, 1, 0.2],
    [1, 0.2, 0.1],
  ],
  ray: [
    [1, 0, 0],
    [0, 1, 0],
  ],
};
const TONE: Partial<Record<Kind, number>> = { sun: 1.25, globe: 1.05, plate: 1.02, gear: 1.22 };
const SCALE: Partial<Record<Kind, number>> = { ground: 0.32, gear: 0.7 };

const v3 = new Vector3();
const ndc = new Vector2();
const hit = new Vector3();

const raf: (fn: (t: number) => void) => number =
  typeof requestAnimationFrame === "function"
    ? (fn) => requestAnimationFrame(fn)
    : (fn) => setTimeout(() => fn(performance.now()), 16) as unknown as number;
const unraf: (id: number) => void =
  typeof cancelAnimationFrame === "function" ? (id) => cancelAnimationFrame(id) : clearTimeout;

// RENDERER
// no dom: runs in a worker, or on the page as fallback
export class Orrery {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(FOV_DEG, 1, 0.5, 30);
  private post = new Scene();
  private flat = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private marks = new Scene();
  private traces: RawShaderMaterial[] = [];
  private res = { value: new Vector2(1, 1) };
  private dot = { value: DOT_PX };
  private ink = { value: new Vector3(INK[0], INK[1], INK[2]) };
  private target: WebGLRenderTarget;
  private postMat: RawShaderMaterial;
  private rig: Rig | null = null;
  private ready = false;
  private shown = false;
  private dead = false;
  private mats = new Map<Kind, RawShaderMaterial>();
  private disposables: { dispose(): void }[] = [];
  private shared = {
    uLight: { value: new Vector3(-0.55, 0.8, 0.45).normalize() },
    uDensity: { value: 40 },
    uSpacing: { value: 9 },
  };

  private frameId = 0;
  private last = 0;
  private visible = false;
  private sized = false;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private cursor = "";

  // MOTION
  private theta = 0;
  private goal = 0;
  private vel: number;
  private pointer = -1;
  private driver = -1;
  private phi = 0;
  private reported = NaN;

  onState: (years: number, driver: string) => void = () => {};
  onCursor: (cursor: string) => void = () => {};
  onReady: () => void = () => {};
  onFail: () => void = () => {};

  constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    private reducedMotion: boolean,
    forceGL: boolean,
  ) {
    this.vel = reducedMotion ? 0 : IDLE_RAD_S;
    const r = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      premultipliedAlpha: true,
    });
    // SOFTWARE GL
    // cpu renderers get the still before any shader compiles; ?gl forces the live path
    if (!forceGL && software(r.getContext())) {
      r.dispose();
      r.forceContextLoss();
      throw new Error("software gl");
    }
    r.debug.checkShaderErrors = import.meta.env.DEV;
    r.setClearColor(0x000000, 0);
    r.autoClear = false;
    this.renderer = r;
    const lost = (e: Event) => {
      e.preventDefault();
      this.stop();
      this.onFail();
    };
    canvas.addEventListener("webglcontextlost", lost);

    this.target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      depthTexture: new DepthTexture(1, 1),
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });
    this.disposables.push(this.target, {
      dispose: () => canvas.removeEventListener("webglcontextlost", lost),
    });

    // PRINT
    const tri = new BufferGeometry();
    tri.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.postMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: POST_VS,
      fragmentShader: POST_FS,
      uniforms: {
        uG: { value: this.target.texture },
        uDepth: { value: this.target.depthTexture },
        uTexel: { value: new Vector2(1, 1) },
        uNear: { value: this.camera.near },
        uFar: { value: this.camera.far },
        uReach: { value: 1 },
        uInk: this.ink,
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new Mesh(tri, this.postMat);
    quad.frustumCulled = false;
    this.post.add(quad);
    this.disposables.push(tri, this.postMat);

    // ORBITS
    // dotted paths; the dragged one inks in solid
    const dotted = this.markMat(DOT_ALPHA);
    for (const s of PLANETS) {
      const dots = new Points(circle(s.orbit, DOT_GAP), dotted);
      const trace = this.markMat(0);
      const line = new Points(circle(s.orbit, TRACE_GAP), trace);
      dots.position.y = line.position.y = PLANET_Y;
      dots.frustumCulled = line.frustumCulled = false;
      this.marks.add(dots, line);
      this.traces.push(trace);
      this.disposables.push(dots.geometry, line.geometry);
    }

    void this.boot();
  }

  private markMat(alpha: number) {
    const m = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: ORBIT_VS,
      fragmentShader: ORBIT_FS,
      uniforms: {
        uDepth: { value: this.target.depthTexture },
        uRes: this.res,
        uInk: this.ink,
        uSize: this.dot,
        uAlpha: { value: alpha },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.disposables.push(m);
    return m;
  }

  private mat(k: Kind): Material {
    const hit = this.mats.get(k);
    if (hit) return hit;
    const [a, b] = AXES[k];
    const m = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: INK_VS,
      fragmentShader: INK_FS,
      uniforms: {
        ...(this.shared as Record<string, IUniform>),
        uAxisA: { value: new Vector3(a[0], a[1], a[2]).normalize() },
        uAxisB: { value: new Vector3(b[0], b[1], b[2]).normalize() },
        uTone: { value: TONE[k] ?? 1 },
        uScale: { value: SCALE[k] ?? 1 },
        uEdge: { value: k === "ground" || k === "ray" ? 0 : 1 },
        uSolid: { value: k === "ray" ? 1 : 0 },
        uPool: { value: k === "ground" ? 1 : 0 },
        uTicks: { value: k === "band" ? 1 : 0 },
      },
      side: k === "rod" || k === "ray" ? DoubleSide : FrontSide,
    });
    this.mats.set(k, m);
    this.disposables.push(m);
    return m;
  }

  // BOOT
  // geometry, then shader compile, then the first draw, each in its own task
  private async boot() {
    await nextTask();
    if (this.dead) return;
    const rig = build((k) => this.mat(k));
    this.scene.add(rig.root);
    this.disposables.push(...rig.geos);
    pose(rig, this.theta);
    this.rig = rig;
    await nextTask();
    if (this.dead) return;
    const r = this.renderer;
    await Promise.all([
      r.compileAsync(this.scene, this.camera),
      r.compileAsync(this.post, this.flat),
      r.compileAsync(this.marks, this.camera),
    ]).catch(() => {});
    if (this.dead) return;
    this.ready = true;
    this.wake();
  }

  // PUBLIC
  resize(w: number, h: number, dpr: number) {
    this.w = w || 1;
    this.h = h || 1;
    this.dpr = dpr;
    this.sized = false;
    this.wake();
  }

  show(on: boolean) {
    this.visible = on;
    this.last = 0;
    this.wake();
  }

  motion(reduced: boolean) {
    this.reducedMotion = reduced;
    this.wake();
  }

  nudge(dir: number) {
    this.vel += dir * 0.6;
    this.wake();
  }

  down(x: number, y: number, id: number, touch: boolean) {
    if (this.pointer !== -1) return;
    const i = this.pick(x, y, touch);
    const a = this.angle(x, y);
    if (i < 0 || Number.isNaN(a)) return;
    this.pointer = id;
    this.driver = i;
    this.phi = a;
    this.goal = this.theta;
    this.point("grabbing");
    this.wake();
  }

  move(x: number, y: number, id: number, touch: boolean) {
    if (id !== this.pointer) {
      if (this.pointer === -1 && !touch) this.point(this.pick(x, y, false) >= 0 ? "grab" : "");
      return;
    }
    const a = this.angle(x, y);
    if (Number.isNaN(a)) return;
    let d = a - this.phi;
    if (d > Math.PI) d -= Math.PI * 2;
    else if (d < -Math.PI) d += Math.PI * 2;
    this.phi = a;
    this.goal += d / RATIO[this.driver];
    this.wake();
  }

  up(id: number) {
    if (id !== this.pointer) return;
    this.pointer = -1;
    this.driver = -1;
    this.vel = Math.max(-MAX_COAST_RAD_S, Math.min(MAX_COAST_RAD_S, this.vel));
    this.point("grab");
    this.wake();
  }

  private point(c: string) {
    if (c === this.cursor) return;
    this.cursor = c;
    this.onCursor(c);
  }

  // LOOP
  private wake() {
    if (!this.frameId && this.visible && !this.dead) this.frameId = raf(this.frame);
  }

  private stop() {
    unraf(this.frameId);
    this.frameId = 0;
  }

  private frame = (now: number) => {
    this.frameId = 0;
    if (!this.visible || this.dead) return;
    const dt = this.last ? Math.min(MAX_DT_S, (now - this.last) / 1000) : 0;
    this.last = now;
    if (!this.ready) return;
    if (!this.sized) this.layout();
    this.step(dt);
    this.draw();
    if (!this.shown) {
      this.shown = true;
      this.onReady();
    }
    if (this.animating()) this.wake();
    else this.last = 0;
  };

  private step(dt: number) {
    if (this.driver >= 0) {
      const prev = this.theta;
      this.theta += (this.goal - this.theta) * (1 - Math.exp(-dt / DRAG_TAU_S));
      if (dt > 0)
        this.vel += ((this.theta - prev) / dt - this.vel) * (1 - Math.exp(-dt / VEL_TAU_S));
    } else {
      const idle = this.reducedMotion ? 0 : IDLE_RAD_S;
      this.vel += (idle - this.vel) * (1 - Math.exp(-dt / COAST_TAU_S));
      this.theta += this.vel * dt;
    }
    if (this.rig) pose(this.rig, this.theta);
    const k = 1 - Math.exp(-dt / TRACE_TAU_S);
    for (let i = 0; i < this.traces.length; i++) {
      const u = this.traces[i].uniforms.uAlpha;
      u.value += ((i === this.driver ? 1 : 0) - u.value) * k;
    }
    const years = Math.round((this.theta / (Math.PI * 2)) * 100);
    if (years !== this.reported) {
      this.reported = years;
      this.onState(years / 100, this.driver >= 0 ? PLANETS[this.driver].name : "—");
    }
  }

  private animating() {
    for (let i = 0; i < this.traces.length; i++) {
      const v = this.traces[i].uniforms.uAlpha.value as number;
      if (Math.abs((i === this.driver ? 1 : 0) - v) > 1e-3) return true;
    }
    if (this.driver >= 0)
      return Math.abs(this.goal - this.theta) > 1e-4 || Math.abs(this.vel) > 1e-4;
    return !this.reducedMotion || Math.abs(this.vel) > 1e-4;
  }

  private draw() {
    if (this.rig) this.rig.rays.quaternion.copy(this.camera.quaternion);
    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.clear();
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    r.clear();
    r.render(this.post, this.flat);
    r.render(this.marks, this.camera);
  }

  // INPUT
  private pick(x: number, y: number, touch: boolean) {
    let best = -1;
    if (!this.rig || !this.sized) return best;
    let bestD = Infinity;
    const ppu = this.pxPerUnit();
    for (let i = 0; i < this.rig.globes.length; i++) {
      this.rig.globes[i].getWorldPosition(v3).project(this.camera);
      const px = (v3.x * 0.5 + 0.5) * this.w;
      const py = (0.5 - v3.y * 0.5) * this.h;
      const d = Math.hypot(px - x, py - y);
      const reach = (touch ? PICK_TOUCH_PX : PICK_PX) + PLANETS[i].radius * ppu;
      if (d < reach && d < bestD) {
        best = i;
        bestD = d;
      }
    }
    return best;
  }

  private pxPerUnit() {
    const dist = this.camera.position.distanceTo(v3.set(0, TARGET_Y, 0));
    return this.h / 2 / (dist * Math.tan((FOV_DEG * Math.PI) / 360));
  }

  private angle(x: number, y: number) {
    ndc.set((x / this.w) * 2 - 1, 1 - (y / this.h) * 2);
    v3.set(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    const o = this.camera.position;
    const t = (PLANET_Y - o.y) / (v3.y || -1e-5);
    if (t <= 0) return NaN;
    hit.set(o.x + v3.x * t, PLANET_Y, o.z + v3.z * t);
    return Math.atan2(-hit.z, hit.x);
  }

  // LAYOUT
  // resizing clears the canvas, so only right before a draw
  private layout() {
    const { w: sw, h: sh, dpr } = this;
    const aspect = sw / sh;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(sw, sh, false);
    const w = Math.round(sw * dpr);
    const h = Math.round(sh * dpr);
    this.target.setSize(w, h);

    const halfV = (FOV_DEG * Math.PI) / 360;
    const halfH = Math.atan(Math.tan(halfV) * aspect);
    const fitW = aspect < 1 ? FIT_W_NARROW : FIT_W;
    const dist = Math.max(fitW / 2 / Math.tan(halfH), FIT_H / 2 / Math.tan(halfV));
    const cam = this.camera;
    cam.aspect = aspect;
    cam.position.set(0, TARGET_Y + Math.sin(PITCH_RAD) * dist, Math.cos(PITCH_RAD) * dist);
    cam.lookAt(0, TARGET_Y, 0);
    if (aspect > 1.25) cam.setViewOffset(sw, sh, -SHIFT * sw, 0, sw, sh);
    else cam.clearViewOffset();
    cam.near = dist * 0.4;
    cam.far = dist * 2;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    const ppu = this.pxPerUnit();
    const fine = Math.min(1, Math.max(0.6, ppu / REF_PX_PER_UNIT));
    this.shared.uDensity.value = ppu / (SPACING_PX * fine);
    this.shared.uSpacing.value = SPACING_PX * fine * dpr * Math.SQRT2;
    const u = this.postMat.uniforms;
    (u.uTexel.value as Vector2).set(1 / w, 1 / h);
    this.res.value.set(w, h);
    this.dot.value = DOT_PX * dpr * Math.max(0.8, fine);
    u.uReach.value = EDGE_PX * fine * dpr;
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    this.sized = true;
  }

  dispose() {
    this.dead = true;
    this.stop();
    this.target.depthTexture?.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
    this.renderer.dispose();
    if (!this.renderer.getContext().isContextLost()) this.renderer.forceContextLoss();
  }
}

function circle(radius: number, gap: number) {
  const n = Math.round((Math.PI * 2 * radius) / gap);
  const pos = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    pos[k * 3] = radius * Math.cos(a);
    pos[k * 3 + 2] = -radius * Math.sin(a);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  return g;
}

const nextTask = () => new Promise<void>((done) => setTimeout(done, 0));

function software(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}
