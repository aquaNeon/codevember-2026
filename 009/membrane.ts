import {
  BackSide,
  BoxGeometry,
  Color,
  CustomBlending,
  FrontSide,
  Group,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Vector3,
  Vector4,
  WebGLRenderer,
} from "three";
import { SAC_FS, SAC_VS, SLOTS, SOLID_FS, SOLID_VS } from "./shaders";

const MAX_DPR = 2;
const MAX_DT_S = 0.05;
const STEP_S = 1 / 120;
const SKIN_DETAIL = 48;
const FORM_BOX = 1.95; // proxy box the form is marched in, just larger than the arms
const FOV_DEG = 28;
const FIT_R = 1.4; // world radius that must stay in frame
const FIT_TALL_R = 1.15; // portrait screens: closer, the form is the page
const PICK_R = 0.85; // the form as a sphere, for picking
const BREATH = { periodS: 7.5, amp: 0.022 }; // change breathing here
const SPRING = { hz: 1.3, zeta: 0.34, press: 0.34, hover: 0.035, followS: 0.09 };
const SNAP = { hz: 2.4, zeta: 0.22 }; // a lifted tent lets go faster, with a little ring
const TENT = { max: 0.45, startPx: 6, fullPx: 160 }; // drag to lift the skin off the form
const SETTLE = 1e-4;
const DRIFT = { spinRadS: 0.14, bobPeriodS: 9, bob: 0.03, tiltRad: 0.55 };

export const LOOKS = {
  dark: { lit: "#f2ede6", shade: "#7d7b84", rim: "#b9c6dc", paper: 0 }, // porcelain-white clay, so the film colours show
  paper: { lit: "#d9967a", shade: "#7a4a3e", rim: "#ffffff", paper: 1 },
} as const;
export type Look = keyof typeof LOOKS;

// scratch, reused by input handlers
const ray = new Vector3();
const org = new Vector3();
const hit = new Vector3();
const inv = new Matrix4();

type Slot = { dir: Vector3; goal: Vector3; x: number; v: number; target: number; snap: boolean };

export class Membrane {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(FOV_DEG, 1, 0.1, 40);
  private body = new Group();
  // camera position in the body's own space, for the form's ray march
  private camObj = new Vector3();
  private dents: Vector4[] = [];
  private slots: Slot[] = [];
  private active = 0;
  private uniforms = {
    uTime: { value: 0 },
    uBreath: { value: 0 },
    uDent: { value: this.dents },
    uPaper: { value: 0 },
  };
  private disposables: { dispose(): void }[] = [];

  private raf = 0;
  private last = 0;
  private acc = 0;
  private time = 0;
  private visible = false;
  private sized = false;
  private ready = false;
  private reducedMotion: boolean;
  private w = 1;
  private h = 1;
  private dpr = 1;

  // GESTURE
  private pointer = -1;
  private hovering = false;
  private downX = 0;
  private downY = 0;
  private tenting = false;

  pokes = 0;
  onPoke: (n: number) => void = () => {};
  onCursor: (cursor: string) => void = () => {};
  onShown: () => void = () => {};

  // no dom in here, so the whole scene can live in a worker; the host feeds it size, visibility and input
  constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    opts: { look: Look; reducedMotion: boolean; forceGl: boolean },
  ) {
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

    for (let i = 0; i < SLOTS; i++) {
      this.dents.push(new Vector4(0, 1, 0, 0));
      this.slots.push({
        dir: new Vector3(0, 0, 1),
        goal: new Vector3(0, 0, 1),
        x: 0,
        v: 0,
        target: 0,
        snap: false,
      });
    }

    // SKIN
    // one geometry, drawn twice: the far side first, then the near side over the form
    const L = LOOKS[opts.look];
    this.uniforms.uPaper.value = L.paper;
    const skinGeo = new IcosahedronGeometry(1, SKIN_DETAIL);
    const wall = (side: typeof FrontSide | typeof BackSide) =>
      new ShaderMaterial({
        uniforms: { ...this.uniforms, uSide: { value: side === FrontSide ? 1 : -1 } },
        vertexShader: SAC_VS,
        fragmentShader: SAC_FS,
        side,
        transparent: true,
        depthWrite: false,
        blending: CustomBlending,
        blendSrc: OneFactor,
        blendDst: OneMinusSrcAlphaFactor,
      });
    const backMat = wall(BackSide);
    const frontMat = wall(FrontSide);
    const back = new Mesh(skinGeo, backMat);
    const front = new Mesh(skinGeo, frontMat);
    back.renderOrder = 1;
    front.renderOrder = 2;
    back.frustumCulled = front.frustumCulled = false;
    this.disposables.push(skinGeo, backMat, frontMat);

    // FORM
    // a 3d cross, ray-marched inside this box; it gives a little under a press
    const formGeo = new BoxGeometry(FORM_BOX, FORM_BOX, FORM_BOX);
    const formMat = new ShaderMaterial({
      uniforms: {
        uDent: this.uniforms.uDent,
        uCam: { value: this.camObj },
        uLit: { value: new Color(L.lit) },
        uShade: { value: new Color(L.shade) },
        uRim: { value: new Color(L.rim) },
      },
      vertexShader: SOLID_VS,
      fragmentShader: SOLID_FS,
    });
    const form = new Mesh(formGeo, formMat);
    this.disposables.push(formGeo, formMat);

    this.body.add(form, back, front);
    this.body.rotation.set(DRIFT.tiltRad, 0.6, 0.15);
    this.scene.add(this.body);

    r.compileAsync(this.scene, this.camera)
      .catch(() => {})
      .then(() => {
        this.ready = true;
        this.onShown();
        this.wake();
      });
  }

  // PUBLIC
  size(w: number, h: number, dpr: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.dpr = Math.min(dpr || 1, MAX_DPR);
    this.sized = false;
    this.wake();
  }

  // the host calls this from its IntersectionObserver and document.hidden, so the loop pauses offscreen and in hidden tabs
  show(visible: boolean) {
    this.visible = visible;
    this.last = 0;
    this.wake();
  }

  motion(reduced: boolean) {
    this.reducedMotion = reduced;
    this.wake();
  }

  // a poke on the face toward the camera, for keys and the button
  poke() {
    const s = this.slots[this.free()];
    this.body.updateMatrixWorld();
    inv.copy(this.body.matrixWorld).invert();
    s.dir.set(0.2, 0.15, 1).transformDirection(inv);
    s.goal.copy(s.dir);
    s.snap = false;
    s.v += SPRING.press * 9;
    this.count();
    this.wake();
  }

  // INPUT
  // ray against the form as a sphere, in the body's own space; hit as a unit direction
  // x, y in css px from the canvas corner
  private pick(x: number, y: number) {
    ray.set((x / this.w) * 2 - 1, 1 - (y / this.h) * 2, 0.5);
    ray.unproject(this.camera).sub(this.camera.position).normalize();
    inv.copy(this.body.matrixWorld).invert();
    org.copy(this.camera.position).applyMatrix4(inv);
    ray.transformDirection(inv);
    const b = org.dot(ray);
    const c = org.dot(org) - PICK_R * PICK_R;
    const disc = b * b - c;
    if (disc < 0) return false;
    const t = -b - Math.sqrt(disc);
    hit.copy(org).addScaledVector(ray, t).normalize();
    return true;
  }

  down(x: number, y: number, id: number) {
    if (this.pointer !== -1 || !this.pick(x, y)) return;
    this.pointer = id;
    this.downX = x;
    this.downY = y;
    this.tenting = false;
    const s = this.slots[this.active];
    // a fresh touch starts where the finger lands, a hovered dent is already there
    if (!this.hovering) s.dir.copy(hit);
    s.goal.copy(hit);
    s.snap = false;
    s.target = SPRING.press;
    this.count();
    this.wake();
  }

  move(x: number, y: number, id: number, mouse: boolean) {
    const s = this.slots[this.active];
    if (id === this.pointer) {
      // DRAG
      // pulling away from where it was pressed lifts the skin into a tent, pinned at the grab
      const d = Math.hypot(x - this.downX, y - this.downY);
      if (d > TENT.startPx) this.tenting = true;
      if (this.tenting) {
        const k = Math.min(1, (d - TENT.startPx) / (TENT.fullPx - TENT.startPx));
        s.target = -TENT.max * Math.max(0, k);
        s.goal.copy(s.dir);
      } else if (this.pick(x, y)) s.goal.copy(hit);
    } else if (this.pointer === -1 && mouse) {
      const over = this.pick(x, y);
      if (over && !this.hovering) s.dir.copy(hit);
      if (over) s.goal.copy(hit);
      this.hovering = over;
      s.target = over ? SPRING.hover : 0;
      this.onCursor(over ? "grab" : "");
    }
    this.wake();
  }

  up(x: number, y: number, id: number, mouse: boolean) {
    if (id !== this.pointer) return;
    this.pointer = -1;
    // let go: this dent springs back on its own, the next one takes the cursor
    const s = this.slots[this.active];
    s.snap = this.tenting;
    s.target = 0;
    this.tenting = false;
    this.active = this.free();
    this.hovering = false;
    if (mouse && this.pick(x, y)) this.move(x, y, id, mouse);
    this.wake();
  }

  leave(mouse: boolean) {
    if (this.pointer !== -1 || !mouse) return;
    this.hovering = false;
    this.slots[this.active].target = 0;
    this.onCursor("");
    this.wake();
  }

  // quietest slot that is not under the cursor
  private free() {
    let best = -1;
    let low = Infinity;
    for (let i = 0; i < SLOTS; i++) {
      if (i === this.active && (this.pointer !== -1 || this.hovering)) continue;
      const s = this.slots[i];
      const e = Math.abs(s.x) + Math.abs(s.v) * 0.2 + Math.abs(s.target);
      if (e < low) {
        low = e;
        best = i;
      }
    }
    return best;
  }

  private count() {
    this.pokes++;
    this.onPoke(this.pokes);
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
    // breathing never settles; with reduced motion only the springs keep it awake
    if (!this.reducedMotion || moving) this.wake();
    else this.last = 0;
  };

  private step(dt: number) {
    if (!this.reducedMotion) this.time += dt;
    const t = this.time;
    const u = this.uniforms;
    u.uTime.value = t;
    u.uBreath.value = BREATH.amp * Math.sin((t / BREATH.periodS) * Math.PI * 2);

    // SPRINGS
    // designed, not simulated: one damped spring per dent, fixed substeps so it feels the same at any rate
    this.acc += dt;
    let moving = false;
    while (this.acc >= STEP_S) {
      this.acc -= STEP_S;
      for (let i = 0; i < SLOTS; i++) {
        const s = this.slots[i];
        const p = s.snap ? SNAP : SPRING;
        const w = p.hz * Math.PI * 2;
        const zeta = this.reducedMotion ? 1 : p.zeta;
        s.v += (w * w * (s.target - s.x) - 2 * zeta * w * s.v) * STEP_S;
        s.x += s.v * STEP_S;
      }
    }
    const follow = 1 - Math.exp(-dt / SPRING.followS);
    for (let i = 0; i < SLOTS; i++) {
      const s = this.slots[i];
      s.dir.lerp(s.goal, follow).normalize();
      this.dents[i].set(s.dir.x, s.dir.y, s.dir.z, s.x);
      if (Math.abs(s.x - s.target) > SETTLE || Math.abs(s.v) > SETTLE) moving = true;
      else if (s.snap && s.target === 0) s.snap = false;
    }

    // BODY
    // floats and turns slowly; held still while a finger is on it so the grab stays put
    if (this.pointer === -1)
      this.body.rotation.y += dt * DRIFT.spinRadS * (this.reducedMotion ? 0 : 1);
    this.body.position.y = DRIFT.bob * Math.sin((t / DRIFT.bobPeriodS) * Math.PI * 2);
    this.body.rotation.x = DRIFT.tiltRad + Math.sin(t * 0.11) * 0.12;
    this.body.updateMatrixWorld();
    inv.copy(this.body.matrixWorld).invert();
    this.camObj.copy(this.camera.position).applyMatrix4(inv);
    return moving;
  }

  // RESIZE
  private resize() {
    const w = this.w;
    const h = this.h;
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    const aspect = w / Math.max(1, h);
    const cam = this.camera;
    cam.aspect = aspect;
    // fit FIT_R in the tighter of the two fields of view
    const v = (FOV_DEG * Math.PI) / 360;
    const half = Math.min(v, Math.atan(Math.tan(v) * aspect));
    cam.position.set(0, 0.05, (aspect < 0.8 ? FIT_TALL_R : FIT_R) / Math.sin(half));
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
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
