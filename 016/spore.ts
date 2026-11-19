import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PerspectiveCamera,
  Points,
  Scene,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  ShaderMaterial,
  Vector3,
  Vector4,
  WebGLRenderer,
} from "three";
import {
  headY,
  poreY,
  profile,
  PUFF_FS,
  PUFF_VS,
  SECTION_FS,
  SECTION_VS,
  SLOTS,
  SPORE_FS,
  SPORE_VS,
  type Form,
} from "./shaders";

const MAX_DPR = 2;
const MAX_DT_S = 0.05;
const STEP_S = 1 / 120;
const SEGMENTS = { around: 192, down: 168 };
const FOV_DEG = 24;
const FIT_W = 4.6; // world width that must stay in frame
const FIT_H = 5.4; // and height
const AIM_Y = 1.75;
const AIM_X = -0.2; // nudges the cluster right of the title
// portrait: no title beside the figures, so centre them, and look lower so they rise into the space under the title
const TALL = { aimX: 0, aimY: 1.5 };
const CAM_PITCH_RAD = 0.2;
const SPORE_LIFE_S = 7;
const DEPTH = 0.3;
const PRESS = { hz: 5, zeta: 0.75 }; // the dimple goes in fast
const REFILL = { hz: 0.42, zeta: 0.82 }; // and fills back up slowly
const SETTLE = 2e-4;
const TAP_S = 0.22;
const EMITTERS = 8;
const INK_REF_PX = 166; // css px per world unit on a 1440x900 screen, where the ink marks were tuned
const LABEL_Y = -0.18; // plate labels sit just under each foot
const SECTION_TURN_RAD = -0.3; // turns the cut face a little toward the camera

export type Look = "gouache" | "plate";

// FORMS
// stem length, crown flattening, foot pinch, age
const YOUNG: Form = [0.62, 0.06, 0.05, 0];
const MATURE: Form = [1.2, 0.2, 0.14, 0.2];
const AGED: Form = [0.9, 0.3, 0.2, 1];

// x, z, scale, cut open, form
type Spot = readonly [number, number, number, boolean, Form];

const LOOKS = {
  gouache: {
    cluster: [
      [0, 0, 0.74, false, MATURE],
      [-1.3, 0.4, 0.5, false, YOUNG],
      [1.2, -0.3, 0.44, false, AGED],
    ] as Spot[],
    puff: { count: 190, spreadS: 0.45, speed: 2.6, cone: 0.38 }, // change the exhale here
    maxSpores: 6144,
    tallW: 3.9, // portrait screens crop the sides a little
    colors: {
      top: "#f3ecdd",
      foot: "#dcc6a2",
      shade: "#bf9470",
      wart: "#fbf6ea",
      ink: "#2b2017",
      gleba: "#7b5a2e",
      dust: "#8a6a44",
      dustHi: "#d9c7a3",
    },
  },
  plate: {
    cluster: [
      [-0.15, 0, 0.72, false, MATURE],
      [1.4, -0.2, 0.62, true, YOUNG],
      [-1.5, 0.35, 0.5, false, AGED],
    ] as Spot[],
    puff: { count: 1600, spreadS: 0.5, speed: 2.6, cone: 0.42 },
    maxSpores: 24576,
    tallW: 5.1, // the plate keeps all three figures inside the ruled frame
    colors: {
      top: "#f2e9d3",
      foot: "#dcbc84",
      shade: "#97663b",
      wart: "#f6efdf",
      ink: "#2a1f16",
      gleba: "#ad9a66",
      dust: "#2a1f16",
      dustHi: "#cdb184",
    },
  },
} as const;

// scratch, reused by input handlers
const ray = new Vector3();
const org = new Vector3();
const hit = new Vector3();
const proj = new Vector3();

type Slot = { dir: Vector3; x: number; v: number; target: number; held: boolean; until: number };
type Shroom = {
  mesh: Mesh;
  dents: Vector4[];
  slots: Slot[];
  deflate: { value: number };
  x: number;
  z: number;
  s: number;
  cut: boolean;
  form: Form;
  next: number;
};
type Emitter = { shroom: number; left: number; total: number; strength: number; t: number };

export class Spore {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(FOV_DEG, 1, 0.1, 60);
  private shrooms: Shroom[] = [];
  private emitters: Emitter[] = [];
  private disposables: { dispose(): void }[] = [];
  private spores: Points;
  private origin: BufferAttribute;
  private vel: BufferAttribute;
  private birth: BufferAttribute;
  private attrs: BufferAttribute[];
  private head = 0;
  private max: number;
  private tallW: number;
  private puffCfg: { count: number; spreadS: number; speed: number; cone: number };
  private dpr = { value: 1 };
  // ink marks scale with how big the figures are drawn, so a small phone plate is not coarser
  private inkScale = { value: 1 };
  private sporeUniforms: Record<string, { value: unknown }>;
  private time = 0;

  private raf = 0;
  private last = 0;
  private acc = 0;
  private airUntil = 0;
  private visible = false;
  private sized = false;
  private ready = false;
  private reducedMotion: boolean;
  private w = 1;
  private h = 1;
  private pxRatio = 1;
  private panel = new Float32Array(4);
  private framed = false;
  private pointer = -1;
  private held = -1;
  private heldSlot = -1;

  puffs = 0;
  onPuff: (n: number) => void = () => {};
  onCursor: (cursor: string) => void = () => {};
  onShown: () => void = () => {};
  // css px positions of each figure's label, x0, y0, x1, y1, ...
  onLabels: (xy: number[]) => void = () => {};

  // no dom in here, so the whole scene can live in a worker; the host feeds it size, visibility and input
  constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    opts: { look: Look; reducedMotion: boolean; forceGl: boolean },
  ) {
    const look = opts.look;
    this.reducedMotion = opts.reducedMotion;
    const r = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    // SOFTWARE GL
    // cpu renderers get the still before any shader compiles; ?gl forces the live path
    if (!opts.forceGl && software(r.getContext())) {
      r.dispose();
      r.forceContextLoss();
      throw new Error("software gl");
    }
    r.debug.checkShaderErrors = import.meta.env.DEV; // reading every shader log stalls the first frame
    r.setClearColor(0x000000, 0);
    this.renderer = r;

    const L = LOOKS[look];
    const plate = look === "plate";
    const defines: Record<string, string> = plate ? { PLATE: "" } : {};
    this.max = L.maxSpores;
    this.tallW = L.tallW;
    this.puffCfg = L.puff;
    const C = L.colors;
    const top = new Color(C.top);
    const foot = new Color(C.foot);
    const shade = new Color(C.shade);
    const wart = new Color(C.wart);
    const ink = new Color(C.ink);
    const blend = {
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
    } as const;

    // PUFFBALLS
    const geo = new SphereGeometry(1, SEGMENTS.around, SEGMENTS.down);
    this.disposables.push(geo);
    for (const [x, z, s, cut, form] of L.cluster) {
      const uForm = { value: new Vector4(form[0], form[1], form[2], form[3]) };
      const dents: Vector4[] = [];
      const slots: Slot[] = [];
      for (let i = 0; i < SLOTS; i++) {
        dents.push(new Vector4(0, 1, 0, 0));
        slots.push({ dir: new Vector3(0, 0, 1), x: 0, v: 0, target: 0, held: false, until: 0 });
      }
      const deflate = { value: 0 };
      const mat = new ShaderMaterial({
        defines: cut ? { ...defines, SECTION: "" } : defines,
        uniforms: {
          uDent: { value: dents },
          uDeflate: deflate,
          uTop: { value: top },
          uFoot: { value: foot },
          uShade: { value: shade },
          uWart: { value: wart },
          uInk: { value: ink },
          uDpr: this.dpr,
          uInkScale: this.inkScale,
          uForm,
        },
        vertexShader: PUFF_VS,
        fragmentShader: PUFF_FS,
      });
      const mesh = new Mesh(geo, mat);
      mesh.scale.setScalar(s);
      mesh.position.set(x, 0, z);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.disposables.push(mat);

      // CUTAWAY
      // the cut face, so the spore mass inside shows
      if (cut) {
        mesh.rotation.y = SECTION_TURN_RAD;
        const faceGeo = new ShapeGeometry(section(form), 4);
        const faceMat = new ShaderMaterial({
          uniforms: {
            uTop: { value: top },
            uFoot: { value: foot },
            uShade: { value: shade },
            uInk: { value: ink },
            uGleba: { value: new Color(C.gleba) },
            uDpr: this.dpr,
            uInkScale: this.inkScale,
            uForm,
          },
          vertexShader: SECTION_VS,
          fragmentShader: SECTION_FS,
        });
        mesh.add(new Mesh(faceGeo, faceMat));
        this.disposables.push(faceGeo, faceMat);
      }

      this.shrooms.push({ mesh, dents, slots, deflate, x, z, s, cut, form, next: 0 });
    }

    // SPORES
    // one ring buffer of points; each one knows where and when it was born, the shader does the rest
    const sg = new BufferGeometry();
    this.origin = new BufferAttribute(new Float32Array(this.max * 3), 3);
    this.vel = new BufferAttribute(new Float32Array(this.max * 3), 3);
    const births = new Float32Array(this.max * 2);
    for (let i = 0; i < this.max; i++) births[i * 2] = -1e3;
    this.birth = new BufferAttribute(births, 2);
    // position is unused but three wants it for the draw count
    sg.setAttribute("position", this.origin);
    sg.setAttribute("aOrigin", this.origin);
    sg.setAttribute("aVel", this.vel);
    sg.setAttribute("aBirth", this.birth);
    this.attrs = [this.origin, this.vel, this.birth];
    this.sporeUniforms = {
      uTime: { value: 0 },
      uPx: { value: 1 },
      uDpr: this.dpr,
      uInkScale: this.inkScale,
      uInk: { value: ink },
      uDust: { value: new Color(C.dust) },
      uDustHi: { value: new Color(C.dustHi) },
    };
    const sm = new ShaderMaterial({
      defines,
      uniforms: this.sporeUniforms,
      vertexShader: SPORE_VS,
      fragmentShader: SPORE_FS,
      ...blend,
    });
    this.spores = new Points(sg, sm);
    this.spores.frustumCulled = false;
    this.spores.renderOrder = 2;
    this.scene.add(this.spores);
    this.disposables.push(sg, sm);

    for (let i = 0; i < EMITTERS; i++)
      this.emitters.push({ shroom: 0, left: 0, total: 0, strength: 0, t: 0 });

    r.compileAsync(this.scene, this.camera)
      .catch(() => {})
      .then(() => {
        this.ready = true;
        this.onShown();
        this.wake();
      });
  }

  // PUBLIC
  // px, py, pw, ph: the plate panel inside the canvas, in css px; the figures are fitted and centred in it
  size(w: number, h: number, dpr: number, px: number, py: number, pw: number, ph: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    const has = pw > 1 && ph > 1;
    this.panel[0] = has ? px : 0;
    this.panel[1] = has ? py : 0;
    this.panel[2] = has ? pw : this.w;
    this.panel[3] = has ? ph : this.h;
    this.framed = has;
    this.pxRatio = Math.min(dpr || 1, MAX_DPR);
    this.sized = false;
    this.wake();
  }

  show(visible: boolean) {
    this.visible = visible;
    this.last = 0;
    this.wake();
  }

  motion(reduced: boolean) {
    this.reducedMotion = reduced;
  }

  // a tap on the big one's shoulder, for keys and the button
  poke() {
    hit.set(-0.35, 0.35, 0.87).normalize();
    const k = this.press(0, hit);
    // a tap holds for a beat so the dimple has time to go in
    this.shrooms[0].slots[k].until = this.time + TAP_S;
  }

  // PRESS
  private press(i: number, dir: Vector3) {
    const m = this.shrooms[i];
    const k = m.next;
    m.next = (m.next + 1) % SLOTS;
    const s = m.slots[k];
    s.dir.copy(dir);
    s.target = DEPTH;
    s.held = true;
    s.until = 0;
    // an empty puffball has less to give
    this.puff(i, Math.max(0.25, 1 - m.deflate.value));
    this.wake();
    return k;
  }

  private release(i: number, k: number) {
    const s = this.shrooms[i].slots[k];
    s.held = false;
    s.target = 0;
    this.wake();
  }

  private puff(i: number, strength: number) {
    let e = this.emitters[0];
    for (let j = 1; j < EMITTERS; j++) if (this.emitters[j].left < e.left) e = this.emitters[j];
    e.shroom = i;
    e.total = e.left = Math.round(this.puffCfg.count * strength * (0.5 + 0.5 * this.shrooms[i].s));
    e.strength = strength;
    e.t = 0;
    this.puffs++;
    this.onPuff(this.puffs);
  }

  // INPUT
  // ray against each head as a sphere; nearest hit wins, as a unit direction in body space
  // x, y in css px from the canvas corner
  private pick(x: number, y: number) {
    const cam = this.camera;
    ray.set((x / this.w) * 2 - 1, 1 - (y / this.h) * 2, 0.5);
    ray.unproject(cam).sub(cam.position).normalize();
    let best = -1;
    let near = Infinity;
    for (let i = 0; i < this.shrooms.length; i++) {
      const m = this.shrooms[i];
      // the cut one is a specimen, not a living puffball
      if (m.cut) continue;
      const s = m.s;
      const ox = (cam.position.x - m.x) / s;
      const oy = (cam.position.y - headY(m.form) * s) / s;
      const oz = (cam.position.z - m.z) / s;
      const dx = ray.x / s;
      const dy = ray.y / s;
      const dz = ray.z / s;
      const a = dx * dx + dy * dy + dz * dz;
      const b = ox * dx + oy * dy + oz * dz;
      const c = ox * ox + oy * oy + oz * oz - 1;
      const disc = b * b - a * c;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / a;
      if (t > 0 && t < near) {
        near = t;
        best = i;
        org.set(ox + dx * t, oy + dy * t, oz + dz * t);
      }
    }
    if (best >= 0) hit.copy(org).normalize();
    return best;
  }

  down(x: number, y: number, id: number) {
    if (this.pointer !== -1) return;
    const i = this.pick(x, y);
    if (i < 0) return;
    this.pointer = id;
    this.held = i;
    this.heldSlot = this.press(i, hit);
  }

  move(x: number, y: number, mouse: boolean) {
    if (this.pointer !== -1 || !mouse) return;
    this.onCursor(this.pick(x, y) >= 0 ? "pointer" : "");
  }

  up(id: number) {
    if (id !== this.pointer) return;
    this.pointer = -1;
    if (this.held >= 0) this.release(this.held, this.heldSlot);
    this.held = -1;
  }

  // LOOP
  private wake() {
    if (!this.raf && this.ready && this.visible) this.raf = raf(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible) return;
    const dt = this.last ? Math.min(MAX_DT_S, (now - this.last) / 1000) : 0;
    this.last = now;
    if (!this.sized) this.resize();
    const moving = this.step(dt);
    this.renderer.render(this.scene, this.camera);
    // nothing breathes here: once the air is clear and the heads are full, the loop sleeps
    if (moving || this.time < this.airUntil) this.wake();
    else this.last = 0;
  };

  private step(dt: number) {
    this.time += dt;
    this.sporeUniforms.uTime.value = this.time;
    let moving = false;

    // SPRINGS
    // designed: in quick on the press, back up slow like air seeping in
    this.acc += dt;
    while (this.acc >= STEP_S) {
      this.acc -= STEP_S;
      for (let i = 0; i < this.shrooms.length; i++) {
        const slots = this.shrooms[i].slots;
        for (let k = 0; k < SLOTS; k++) {
          const s = slots[k];
          if (s.until && this.time >= s.until) {
            s.until = 0;
            s.held = false;
            s.target = 0;
          }
          const p = s.held ? PRESS : REFILL;
          const w = p.hz * Math.PI * 2;
          const z = this.reducedMotion ? 1 : p.zeta;
          s.v += (w * w * (s.target - s.x) - 2 * z * w * s.v) * STEP_S;
          s.x += s.v * STEP_S;
        }
      }
    }
    for (let i = 0; i < this.shrooms.length; i++) {
      const m = this.shrooms[i];
      let sum = 0;
      for (let k = 0; k < SLOTS; k++) {
        const s = m.slots[k];
        m.dents[k].set(s.dir.x, s.dir.y, s.dir.z, s.x);
        sum += Math.max(0, s.x);
        if (Math.abs(s.x - s.target) > SETTLE || Math.abs(s.v) > SETTLE) moving = true;
      }
      m.deflate.value = Math.min(1, sum / DEPTH);
    }

    // EXHALE
    // each puff leaves the pore over a short breath, strong first then trailing off
    const from = this.head;
    let born = 0;
    for (let j = 0; j < EMITTERS; j++) {
      const e = this.emitters[j];
      if (e.left <= 0) continue;
      moving = true;
      e.t += dt;
      const f = Math.min(1, e.t / this.puffCfg.spreadS);
      // share of the puff that should be out by now, front-loaded
      const due = Math.round(e.total * (1 - (1 - f) * (1 - f)));
      let n = due - (e.total - e.left);
      if (f >= 1) n = e.left;
      for (; n > 0; n--, born++) this.emit(e, f);
      this.airUntil = this.time + SPORE_LIFE_S;
    }
    if (born) this.upload(from, born);
    return moving;
  }

  private emit(e: Emitter, f: number) {
    const m = this.shrooms[e.shroom];
    const P = this.puffCfg;
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    e.left--;
    const o = this.origin.array as Float32Array;
    const v = this.vel.array as Float32Array;
    const b = this.birth.array as Float32Array;
    const s = m.s;
    const sq = 1 - 0.16 * m.deflate.value;
    o[i * 3] = m.x + (Math.random() - 0.5) * 0.06 * s;
    o[i * 3 + 1] = (m.form[0] + (poreY(m.form) - m.form[0]) * sq) * s;
    o[i * 3 + 2] = m.z + (Math.random() - 0.5) * 0.06 * s;
    // a cone around up, narrower and faster at the start of the breath
    const cone = P.cone * (0.5 + 1.2 * f);
    const a = Math.random() * Math.PI * 2;
    const rad = Math.sqrt(Math.random()) * cone;
    const sp =
      P.speed * e.strength * (0.35 + 0.9 * Math.random()) * (1 - 0.6 * f) * (0.6 + 0.4 * s);
    v[i * 3] = Math.cos(a) * rad * sp;
    v[i * 3 + 1] = sp;
    v[i * 3 + 2] = Math.sin(a) * rad * sp;
    b[i * 2] = this.time;
    b[i * 2 + 1] = Math.random();
  }

  // one upload range per frame for what was born; a wrap past the end sends the whole buffer
  private upload(from: number, count: number) {
    const wrap = from + count > this.max;
    for (let k = 0; k < 3; k++) {
      const a = this.attrs[k];
      a.clearUpdateRanges();
      if (!wrap) a.addUpdateRange(from * a.itemSize, count * a.itemSize);
      a.needsUpdate = true;
    }
  }

  // RESIZE
  private resize() {
    const w = this.w;
    const h = this.h;
    const dpr = this.pxRatio;
    this.dpr.value = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    const aspect = w / Math.max(1, h);
    const cam = this.camera;
    cam.aspect = aspect;
    const v = (FOV_DEG * Math.PI) / 360;
    // fit the figures to the panel, not the whole canvas
    const [px, py, pw, ph] = this.panel;
    const tall = aspect < 0.8;
    const fitW = tall ? this.tallW : FIT_W;
    const dist = Math.max(
      (FIT_H * h) / (2 * Math.tan(v) * ph),
      (fitW * h) / (2 * Math.tan(v) * pw),
    );
    const ax = this.framed ? 0 : tall ? TALL.aimX : AIM_X;
    const ay = tall ? TALL.aimY : AIM_Y;
    cam.position.set(ax, ay + Math.sin(CAM_PITCH_RAD) * dist, Math.cos(CAM_PITCH_RAD) * dist);
    cam.lookAt(ax, ay, 0);
    // and move the projection centre to the panel's centre
    if (this.framed) cam.setViewOffset(w, h, w / 2 - (px + pw / 2), h / 2 - (py + ph / 2), w, h);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.sporeUniforms.uPx.value = (h * dpr) / (2 * Math.tan(v));
    const unitPx = h / (2 * Math.tan(v)) / dist;
    this.inkScale.value = Math.min(1.3, Math.max(0.5, unitPx / INK_REF_PX));

    // LABELS
    // each plate figure gets its number under its foot
    const xy: number[] = [];
    for (let i = 0; i < this.shrooms.length; i++) {
      const m = this.shrooms[i];
      proj.set(m.x, LABEL_Y, m.z).project(cam);
      xy.push((proj.x * 0.5 + 0.5) * w, (0.5 - proj.y * 0.5) * h);
    }
    this.onLabels(xy);
    this.sized = true;
  }

  dispose() {
    unraf(this.raf);
    this.raf = 0;
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
    this.renderer.dispose();
  }
}

// the body's outline in its own xy plane, same curve as the shader, for the cut face
function section(form: Form) {
  const N = 128;
  const shape = new Shape();
  const r = new Float32Array(N + 1);
  const y = new Float32Array(N + 1);
  const out = new Float32Array(2);
  for (let i = 0; i <= N; i++) {
    profile(i / N, form, out);
    r[i] = out[0];
    y[i] = out[1];
  }
  shape.moveTo(0, y[0]);
  for (let i = 1; i <= N; i++) shape.lineTo(r[i], y[i]);
  for (let i = N - 1; i >= 1; i--) shape.lineTo(-r[i], y[i]);
  shape.closePath();
  return shape;
}

// workers without rAF fall back to a timer
const raf = (fn: (now: number) => void) =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(fn)
    : (setTimeout(() => fn(performance.now()), 16) as unknown as number);
const unraf = (id: number) =>
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id);

function software(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}
