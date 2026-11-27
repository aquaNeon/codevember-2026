import {
  BackSide,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshDepthMaterial,
  MeshPhysicalMaterial,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  ShaderChunk,
  Vector3,
  Vector4,
  type WebGLProgramParametersWithUniforms,
  WebGLRenderer,
} from "three";
import { Cloth } from "./cloth";
import { DoughSim, GRIP, SHAPE, icosphere } from "./sim";
import { Blobs, type Skin } from "./blobs";
import { Board } from "./board";
import { Puff } from "./puff";
import { BENCH, benchY } from "./bench";
import {
  DOUGH_FS_COLOR,
  DOUGH_FS_ENV,
  DOUGH_FS_LIGHT,
  DOUGH_FS_NORMAL,
  DOUGH_FS_PARS,
  DOUGH_FS_ROUGH,
  DOUGH_SSS,
  DOUGH_VS,
  DOUGH_VS_PARS,
} from "./shaders";

const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const STEP_S = 1 / 60;
const MAX_STEPS = 2;
const SHELL_LEVEL = 3;
const FOV_DEG = 26;
const CAM_PITCH_RAD = 0.44;
const CAM_FIT = 4.5;
const TARGET_Y = 0.25;
const SETTLE_FRAMES = 30;
const FOLD_LIFT = 0.25;
const FOLD_TRAVEL = 0.3;
const FOLDS_TO_REST = 4;
const SHADOW_PX = 1536;
const SHADOW_SPAN = 4.6;
const ROUGH = 0.8;
const DROP_Y = 2.0;
const INTRO = { height: 1.6, fallS: 0.42, wobbleS: 0.7, squash: 0.08, decay: 5 }; // change first-load drop feel here
const OFFSCREEN_S = 0.45;
const EDGE_NDC = 1.0;
const LOST_SHARE = 0.3;
const LOST_STRIDE = 6;
const FOLD_ASSIST = 1.3; // change fold assist strength here
const FOLD_OVERSHOOT = 1.5;
const THROW_SPAN = 2.2;
const FOLD_REACH = 2.6;
const COLORS = {
  dough: "#efe4cf",
  tack: "#e9d5b0",
  flour: "#f8f6f1",
  key: "#fff0dc",
  fill: "#dfe7f5",
  sky: "#fff3e2",
  bounce: "#c9a47e",
  window: "#fff1de",
};
const SSS = [0.55, 0.28, 0.12] as const; // change wrap-light tint, linear rgb
const BUMP = 0.008; // change pore depth here
const FLOUR = { top: 0.72, side: 0.22, bottom: 0.4, jitter: 0.35 }; // change starting flour here
const TACK_TAU_S = 11;
const HAND_RUB = 0.7;
const SHADE = { cloth: 0.12, clothR: 0.08 };
const SINK = 0.02;
const WIPE = { r: 0.06, k: -0.05, floor: 0.36 };
const FINGERS = { n: 3, gap: 0.19, r: 0.055, out: 0.32, gapIn: 0.3, k: -0.35 };
const SLAP = { fall: 0.9, stop: 0.3, maxS: 1.6 };
const INTRO_PUFF = { n: 260, speed: 1.8 };
const FOLD_PUFF = { n: 360, speed: 1.9, r: 0.4 };
const GRAB_PUFF = { n: 60, speed: 0.5, r: 0.12 };
const PEEL = { every: 0.1, n: 24, speed: 0.4, until: 0.7 };
const RELAX_TAU_S = 1.4;
const HAND = { tau: 0.05, stretch: 1.1, free: 0.7 }; // change hand lag here
const THUD = { r: 1.1, keep: 0.15 };
const FIELD = { heldS: 0.02, freeS: 0.06, follow: 0.6 };
const SLEEP_WIPE = 0.05;
const CLOTH_DELAY_S = 1.1; // change towel drop delay here

export type Phase = "fold" | "rest" | "covered";

const ray = new Vector3();
const fwd = new Vector3();
const scratch = new Vector3();

export class Dough {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(FOV_DEG, 1, 0.1, 40);
  private sim!: DoughSim;
  private surface = new Blobs();
  private material!: MeshPhysicalMaterial;
  private blob!: Mesh;
  private board!: Board;
  private puff: Puff;
  private flourRaw = new Float32Array(0);
  private skin!: Skin;
  private win = {
    uWin: { value: new Vector3() },
    uWinColor: { value: new Color(COLORS.window) },
    uKeyDir: { value: new Vector3() },
  };
  private key: DirectionalLight;
  private cloth = new Cloth();
  private prepped = false;
  private lastGrabN = 0;
  private fieldBox = new Float32Array(4);
  private bench = { value: new Vector4(BENCH.hw, BENCH.hd, BENCH.r, BENCH.drop) };
  private snap = false;
  // FLAP WATCH
  // track the folded strip until it lands, then puff
  private flap = new Int32Array(0);
  private flapN = 0;
  private slapT = -1;
  private slapY = 0;
  private slapV = 0;
  private slapAll = false;
  private aimX = 0;
  private aimY = 0;
  private aimZ = 0;
  private handX = 0;
  private handY = 0;
  private handZ = 0;
  private peelT = -1;
  private peelAcc = 0;
  private clothIn = 0;
  private disposables: { dispose(): void }[] = [];

  private raf = 0;
  private last = 0;
  private acc = 0;
  private offscreen = 0;
  private mid = new Float32Array(3);
  private visible = false;
  private sized = false;
  private ready = false;
  private dead = false;
  private shown = false;
  private intro = -1;
  private dormant = true;
  private quiet = 0;
  private reducedMotion: boolean;
  private cleanups: (() => void)[] = [];
  private rect = { left: 0, top: 0, width: 1, height: 1 };

  // GESTURE
  private pointer = -1;
  private hx = 0;
  private hy = 0;
  private hz = 0;
  private maxLift = 0;
  private maxTravel = 0;
  private tx = 0;
  private tz = 0;
  private ux = 0;
  private uz = 0;
  private reach = 0;
  private span = 1;
  private planeN = new Vector3();
  private planeD = 0;

  folds = 0;
  onState: (folds: number, phase: Phase) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.puff = new Puff(this.win.uWin);
    const r = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    r.debug.checkShaderErrors = import.meta.env.DEV;
    r.setClearColor(0x000000, 0);
    r.toneMapping = NeutralToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    this.renderer = r;

    // LIGHT
    // shadowed key from the window, cool room fill, warm bounce off the wood
    const key = new DirectionalLight(COLORS.key, 3.1);
    key.position.set(-5.2, 4.4, -2.2);
    key.castShadow = true;
    key.shadow.mapSize.set(SHADOW_PX, SHADOW_PX);
    key.shadow.radius = 7;
    key.shadow.bias = -0.00015;
    key.shadow.normalBias = 0.006;
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -SHADOW_SPAN;
    sc.right = sc.top = SHADOW_SPAN;
    sc.near = 2;
    sc.far = 16;
    this.key = key;
    this.win.uKeyDir.value.copy(key.position).normalize();
    const fill = new DirectionalLight(COLORS.fill, 0.55);
    fill.position.set(3.5, 2.5, 5);
    this.scene.add(key, fill, new HemisphereLight(COLORS.sky, COLORS.bounce, 1.25));

    // OBSERVERS
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

    this.cleanups.push(
      () => ro.disconnect(),
      () => io.disconnect(),
      () => document.removeEventListener("visibilitychange", onVisibility),
      () => canvas.removeEventListener("pointerdown", this.down),
      () => canvas.removeEventListener("pointermove", this.move),
      () => canvas.removeEventListener("pointerup", this.up),
      () => canvas.removeEventListener("pointercancel", this.up),
    );
    void this.boot();
  }

  // BOOT
  // built in steps with a yield between, so no long task blocks input
  private async boot() {
    const r = this.renderer;
    await pause();
    if (this.dead) return;
    this.board = new Board(this.win, this.surface.nx, this.surface.nz);
    this.scene.add(...this.board.meshes);
    await pause();
    if (this.dead) return;

    // DOUGH
    const shell = icosphere(SHELL_LEVEL);
    this.sim = new DoughSim(shell);
    if (this.reducedMotion) this.sim.damp = 6;
    const sn = this.sim.shellN;
    this.skin = {
      count: sn,
      rest: this.sim.spawn.slice(0, sn * 3),
      flour: new Float32Array(sn),
      strain: new Float32Array(sn).fill(1),
      tack: new Float32Array(sn),
    };
    this.flap = new Int32Array(this.sim.n);
    this.flourRaw = new Float32Array(sn);
    this.dust();
    await pause();
    if (this.dead) return;
    this.material = this.doughMaterial();
    this.blob = new Mesh(this.surface.geometry, this.material);
    this.blob.castShadow = true;
    this.blob.receiveShadow = true;
    this.blob.frustumCulled = false;
    this.scene.add(this.blob, this.cloth.mesh, this.puff.points);
    await pause();
    if (this.dead) return;
    this.surface.shape(this.sim.x, this.sim.n, this.sim.ca, this.sim.cb, this.skin);
    await pause();
    if (this.dead) return;
    this.surface.mesh(this.skin);
    this.shadeBoard();
    this.disposables.push(this.surface, this.material, this.cloth, this.board, this.puff);

    // PRECOMPILE
    // async compile per program; proxy mesh builds the shadow program now
    const proxy = new Mesh(this.surface.geometry, new MeshDepthMaterial({ side: BackSide }));
    proxy.receiveShadow = true;
    this.disposables.push(proxy.material as MeshDepthMaterial);
    const parts = [this.blob, ...this.board.meshes, this.puff.points, proxy];
    for (const o of parts) {
      await pause();
      if (this.dead) return;
      await r.compileAsync(o, this.camera, this.scene).catch(() => {});
    }
    if (this.dead) return;
    this.ready = true;
    if (!this.reducedMotion) this.intro = 0;
    this.wake();
  }

  // MATERIAL
  // standard material patched with flour, pores, strain satin and wrap light
  private doughMaterial() {
    const m = new MeshPhysicalMaterial({
      color: COLORS.dough,
      roughness: ROUGH,
      specularIntensity: 0.25,
      sheen: 1,
      sheenColor: new Color("#ffffff"),
      sheenRoughness: 0.65,
    });
    const uniforms = {
      uFlour: { value: new Color(COLORS.flour) },
      uTackColor: { value: new Color(COLORS.tack) },
      uSss: { value: new Color(SSS[0], SSS[1], SSS[2]) },
      uBump: { value: BUMP },
      uBench: this.bench,
      uSink: { value: SINK },
      ...this.win,
    };
    const pars = ShaderChunk.lights_physical_pars_fragment.replace(
      "reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );",
      DOUGH_SSS,
    );
    m.onBeforeCompile = (sh: WebGLProgramParametersWithUniforms) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", `#include <common>\n${DOUGH_VS_PARS}`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n${DOUGH_VS}`);
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", `#include <common>\n${DOUGH_FS_PARS}`)
        .replace("#include <lights_physical_pars_fragment>", pars)
        .replace("#include <color_fragment>", `#include <color_fragment>\n${DOUGH_FS_COLOR}`)
        .replace("#include <roughnessmap_fragment>", DOUGH_FS_ROUGH)
        .replace("#include <normal_fragment_maps>", DOUGH_FS_NORMAL)
        .replace(
          "#include <lights_physical_fragment>",
          `#include <lights_physical_fragment>\n${DOUGH_FS_LIGHT}`,
        )
        .replace(
          "#include <lights_fragment_end>",
          `#include <lights_fragment_end>\n${DOUGH_FS_ENV}`,
        );
    };
    m.customProgramCacheKey = () => "cv-dough";
    return m;
  }

  // SKIN
  private dust() {
    const { flour, tack, rest } = this.skin;
    const raw = this.flourRaw;
    const s = this.sim.spawn;
    const lift = SHAPE.ry + SHAPE.drop;
    for (let i = 0; i < this.sim.shellN; i++) {
      const ny = (s[i * 3 + 1] - lift) / SHAPE.ry;
      const base =
        ny > 0
          ? FLOUR.side + (FLOUR.top - FLOUR.side) * Math.sqrt(ny)
          : FLOUR.side + (FLOUR.bottom - FLOUR.side) * -ny;
      const j = Math.sin(i * 12.9898) * 43758.5453;
      raw[i] = base * (1 - FLOUR.jitter * 0.5 + FLOUR.jitter * (j - Math.floor(j)));
      flour[i] = raw[i];
    }
    rest.set(s.subarray(0, rest.length));
    tack.fill(0);
  }

  private skinStep(dt: number) {
    const { sim, skin, board, flourRaw } = this;
    const { strain, flour, tack, rest } = skin;
    sim.strain(strain);
    const k = Math.exp(-dt / TACK_TAU_S);
    for (let i = 0; i < skin.count; i++) {
      tack[i] *= k;
      const st = strain[i] > 1 ? strain[i] : 1;
      flour[i] = flourRaw[i] / (st * st);
    }
    // RELAX
    // rest positions drift to the current shape so detail re-forms instead of streaking
    if (sim.grabN === 0) {
      const x = sim.x;
      const n = skin.count;
      let cx = 0,
        cy = 0,
        cz = 0,
        rx = 0,
        ry = 0,
        rz = 0;
      for (let i = 0; i < n * 3; i += 3) {
        cx += x[i];
        cy += x[i + 1];
        cz += x[i + 2];
        rx += rest[i];
        ry += rest[i + 1];
        rz += rest[i + 2];
      }
      const ox = (rx - cx) / n,
        oy = (ry - cy) / n,
        oz = (rz - cz) / n;
      const r = 1 - Math.exp(-dt / RELAX_TAU_S);
      for (let i = 0; i < n * 3; i += 3) {
        rest[i] += (x[i] + ox - rest[i]) * r;
        rest[i + 1] += (x[i + 1] + oy - rest[i + 1]) * r;
        rest[i + 2] += (x[i + 2] + oz - rest[i + 2]) * r;
      }
    }
    if (sim.speed < SLEEP_WIPE) return;
    const x = sim.x;
    for (let i = 0; i < skin.count; i += 2)
      if (sim.stuck[i]) board.dab(x[i * 3], x[i * 3 + 2], WIPE.r, WIPE.k, WIPE.floor);
  }

  // HAND
  // strip lags the hand, more the further it is pulled
  private follow(dt: number) {
    if (this.pointer === -1) return;
    const far = Math.hypot(this.aimX - this.hx, this.aimY - this.hy, this.aimZ - this.hz);
    const k = 1 - Math.exp(-dt / (HAND.tau * (1 + Math.max(0, far - HAND.free) * HAND.stretch)));
    this.handX += (this.aimX - this.handX) * k;
    this.handY += (this.aimY - this.handY) * k;
    this.handZ += (this.aimZ - this.handZ) * k;
    this.sim.drag(this.handX, this.handY, this.handZ);
    // PEEL
    if (this.peelT < 0) return;
    this.peelT += dt;
    this.peelAcc += dt;
    if (this.peelT > PEEL.until) this.peelT = -1;
    else if (this.peelAcc > PEEL.every && this.handY > this.hy + 0.1) {
      this.peelAcc = 0;
      this.puff.burst(this.hx, 0.04, this.hz, 0.15, 0.15, PEEL.n, PEEL.speed);
    }
  }

  private handle() {
    const { sim, skin } = this;
    for (let g = 0; g < sim.grabN; g++) {
      const i = sim.grabIdx[g];
      if (i >= skin.count || sim.grabW[g] < 0.15) continue;
      skin.tack[i] = Math.max(skin.tack[i], Math.min(1, sim.grabW[g] * 1.5));
      skin.flour[i] *= 1 - (1 - HAND_RUB) * sim.grabW[g];
    }
    if (this.reach <= 0 || this.hy > 0.45) return;
    const x = sim.x;
    let rim = 0;
    for (let i = 0; i < sim.shellN; i++) {
      const o = i * 3;
      if (x[o + 1] > 0.2) continue;
      const dx = x[o] - this.mid[0],
        dz = x[o + 2] - this.mid[2];
      const side = Math.abs(dx * this.uz - dz * this.ux);
      if (side > 0.3) continue;
      const out = -(dx * this.ux + dz * this.uz);
      if (out > rim) rim = out;
    }
    const { n, gap, r, out, gapIn, k } = FINGERS;
    for (let f = 0; f < n; f++) {
      const lat = (f - (n - 1) / 2) * gap;
      const bx = this.mid[0] - this.ux * (rim + gapIn) - this.uz * lat,
        bz = this.mid[2] - this.uz * (rim + gapIn) + this.ux * lat;
      const len = out * (0.8 + 0.25 * Math.cos(f * 2.1));
      this.board.streak(bx - this.ux * len, bz - this.uz * len, bx, bz, r, k);
    }
  }

  private watch(all: boolean) {
    if (this.reducedMotion) return;
    this.slapAll = all;
    this.slapT = 0;
    this.slapY = this.slapMean();
    this.slapV = 0;
  }

  private slapMean() {
    if (this.slapAll) {
      this.sim.centroid(this.mid);
      return this.mid[1];
    }
    const x = this.sim.x;
    let y = 0;
    for (let g = 0; g < this.flapN; g++) y += x[this.flap[g] * 3 + 1];
    return this.flapN ? y / this.flapN : 0;
  }

  private slap(dt: number) {
    if (this.slapT < 0 || dt <= 0) return;
    this.slapT += dt;
    const y = this.slapMean();
    const v = (y - this.slapY) / dt;
    this.slapY = y;
    if (v < this.slapV) this.slapV = v;
    const landed = this.slapV < -SLAP.fall && v > -SLAP.stop;
    if (!landed) {
      if (this.slapT > SLAP.maxS) this.slapT = -1;
      return;
    }
    this.slapT = -1;
    const fall = Math.min(1.6, -this.slapV / 3);
    if (this.slapAll) {
      this.sim.centroid(this.mid);
      this.ring(this.mid[0], this.mid[2], fall);
      this.sim.deaden(this.mid[0], this.mid[2], 3, THUD.keep);
      return;
    }
    const x = this.sim.x;
    let cx = 0,
      cz = 0;
    for (let g = 0; g < this.flapN; g++) {
      cx += x[this.flap[g] * 3];
      cz += x[this.flap[g] * 3 + 2];
    }
    cx /= this.flapN;
    cz /= this.flapN;
    this.puff.burst(
      cx,
      y + 0.05,
      cz,
      FOLD_PUFF.r,
      FOLD_PUFF.r,
      FOLD_PUFF.n,
      FOLD_PUFF.speed * fall,
    );
    this.sim.deaden(cx, cz, THUD.r, THUD.keep);
  }

  private ring(cx: number, cz: number, k: number) {
    const rx = SHAPE.rx * 1.02,
      rz = SHAPE.rz * 1.02;
    if (!this.reducedMotion)
      this.puff.burst(cx, 0.06, cz, rx, rz, INTRO_PUFF.n, INTRO_PUFF.speed * k);
    for (let a = 0; a < 40; a++) {
      const t = (a / 40) * Math.PI * 2;
      const w = 1 + 0.08 * Math.sin(a * 2.7);
      this.board.dab(
        cx + Math.cos(t) * rx * 1.12 * w,
        cz + Math.sin(t) * rz * 1.12 * w,
        0.2,
        0.12 * k,
      );
    }
  }

  private shadeBoard() {
    const { board } = this;
    board.clearShade();
    this.surface.contact(board.fieldData, this.fieldBox);
    board.fieldBox.value.set(
      this.fieldBox[0],
      this.fieldBox[1],
      this.fieldBox[2],
      this.fieldBox[3],
    );
    board.field.needsUpdate = true;
    const c = this.cloth.points;
    for (let i = 0; i < this.cloth.count; i += 2) {
      const y = Math.max(0, c[i * 3 + 1] - benchY(c[i * 3], c[i * 3 + 2]));
      if (y > SHADE.cloth) continue;
      board.shade(c[i * 3], c[i * 3 + 2], SHADE.clothR, 0.55 * (1 - y / SHADE.cloth));
    }
    board.flushShade();
  }

  private prep() {
    if (this.prepped) return;
    this.prepped = true;
    this.cloth.prep();
    const m = this.cloth.mesh;
    if (m.visible) return;
    m.visible = true;
    this.renderer.compileAsync(m, this.camera, this.scene).catch(() => {});
    m.visible = false;
  }

  // PUBLIC
  reset() {
    if (!this.ready) return;
    this.dormant = false;
    if (this.intro >= 0) this.land();
    this.sim.reset(DROP_Y);
    this.snap = true;
    this.dust();
    this.board.redust();
    this.watch(true);
    if (this.cloth.covering) this.cloth.lift();
    this.clothIn = 0;
    this.offscreen = 0;
    this.restart();
  }

  private restart() {
    this.folds = 0;
    this.material.roughness = ROUGH;
    this.onState(0, "fold");
    this.quiet = 0;
    this.wake();
  }

  // INPUT
  private ray(cx: number, cy: number) {
    const r = this.rect;
    ray.set(((cx - r.left) / r.width) * 2 - 1, 1 - ((cy - r.top) / r.height) * 2, 0.5);
    ray.unproject(this.camera).sub(this.camera.position).normalize();
    return ray;
  }

  private down = (e: PointerEvent) => {
    if (this.pointer !== -1 || !this.ready) return;
    const d = this.ray(e.clientX, e.clientY);
    const o = this.camera.position;
    if (!this.surface.pick(o.x, o.y, o.z, d.x, d.y, d.z)) return;
    if (this.folds >= FOLDS_TO_REST) return;
    const h = this.surface.hit;
    this.hx = h[0];
    this.hy = h[1];
    this.hz = h[2];
    this.pointer = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = "grabbing";
    this.maxLift = 0;
    this.maxTravel = 0;
    this.aim();

    this.camera.getWorldDirection(fwd);
    fwd.y *= 0.35;
    fwd.normalize();
    this.planeN.copy(fwd);
    this.planeD = -(fwd.x * this.hx + fwd.y * this.hy + fwd.z * this.hz);
    this.dormant = false;
    if (this.intro >= 0) this.land();
    this.sim.grab(this.hx, this.hy, this.hz);
    this.aimX = this.handX = this.hx;
    this.aimY = this.handY = this.hy;
    this.aimZ = this.handZ = this.hz;
    this.handle();
    if (!this.reducedMotion && this.hy < 0.45) {
      this.puff.burst(
        this.hx,
        0.03,
        this.hz,
        GRAB_PUFF.r,
        GRAB_PUFF.r,
        GRAB_PUFF.n,
        GRAB_PUFF.speed,
      );
      this.peelT = 0;
      this.peelAcc = 0;
    }
    this.prep();
    this.quiet = 0;
    this.wake();
  };

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) {
      if (this.pointer === -1) this.hover(e);
      return;
    }
    const d = this.ray(e.clientX, e.clientY);
    const o = this.camera.position;
    const n = this.planeN;
    const den = n.x * d.x + n.y * d.y + n.z * d.z;
    if (Math.abs(den) < 1e-5) return;
    const t = -(n.x * o.x + n.y * o.y + n.z * o.z + this.planeD) / den;
    let tx = o.x + d.x * t;
    const ty = o.y + d.y * t;
    let tz = o.z + d.z * t;
    // FOLD ASSIST
    // inward travel grows with the highest lift so far
    const assist = Math.min(this.reach, Math.max(this.maxLift, ty - this.hy, 0) * FOLD_ASSIST);
    tx += this.ux * assist;
    tz += this.uz * assist;
    this.sim.centroid(this.mid);
    const out = Math.hypot(tx - this.mid[0], tz - this.mid[2]);
    const folding = out < this.span * THROW_SPAN;
    this.sim.grip = folding ? GRIP.fold : GRIP.throw;
    this.sim.pinned = folding;
    this.aimX = tx;
    this.aimY = ty;
    this.aimZ = tz;
    this.tx = tx;
    this.tz = tz;
    this.maxLift = Math.max(this.maxLift, ty - this.hy);
    this.maxTravel = Math.max(this.maxTravel, Math.hypot(tx - this.hx, tz - this.hz));
    this.quiet = 0;
    this.wake();
  };

  private hover(e: PointerEvent) {
    if (!this.ready) return;
    const d = this.ray(e.clientX, e.clientY);
    const o = this.camera.position;
    const over = this.surface.pick(o.x, o.y, o.z, d.x, d.y, d.z);
    this.canvas.style.cursor = over && this.folds < FOLDS_TO_REST ? "grab" : "";
  }

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    this.pointer = -1;
    this.canvas.style.cursor = "grab";
    this.lastGrabN = this.sim.grabN;
    this.flap.set(this.sim.grabIdx.subarray(0, this.lastGrabN));
    this.sim.release();
    if (
      this.maxLift > FOLD_LIFT &&
      this.maxTravel > FOLD_TRAVEL &&
      this.overDough() &&
      this.folds < FOLDS_TO_REST
    ) {
      this.folds++;
      this.material.roughness = ROUGH - (this.folds / FOLDS_TO_REST) * 0.06;
      const resting = this.folds === FOLDS_TO_REST;
      if (resting) {
        this.clothIn = CLOTH_DELAY_S;
      }
      this.onState(this.folds, resting ? "rest" : "fold");
      this.flapN = Math.min(this.lastGrabN, this.flap.length);
      this.watch(false);
    }
    this.quiet = 0;
    this.wake();
  };

  private aim() {
    this.sim.centroid(this.mid);
    const dx = this.mid[0] - this.hx;
    const dz = this.mid[2] - this.hz;
    const len = Math.hypot(dx, dz);
    if (len < 0.3) {
      this.ux = 0;
      this.uz = 0;
      this.reach = 0;
      this.span = 0.6;
      return;
    }
    this.ux = dx / len;
    this.uz = dz / len;
    this.reach = len * FOLD_OVERSHOOT;
    this.span = len;
  }

  private overDough() {
    this.sim.centroid(this.mid);
    return Math.hypot(this.tx - this.mid[0], this.tz - this.mid[2]) < FOLD_REACH;
  }

  // LOOP
  private wake() {
    if (!this.raf && this.ready && this.visible && !document.hidden)
      this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible || document.hidden) return;
    const dt = this.last ? Math.min(MAX_DT_S, Math.max(0, now - this.last) / 1000) : STEP_S;
    this.last = now;
    if (!this.sized) this.resize();

    // FIXED STEP
    this.acc = this.dormant ? 0 : this.acc + dt;
    let active = false;
    let steps = 0;
    while (!this.dormant && this.acc >= STEP_S && steps < MAX_STEPS) {
      this.follow(STEP_S);
      const moving = this.sim.step(STEP_S);
      active = this.cloth.step(STEP_S, this.surface, moving) || moving || active;
      this.skinStep(STEP_S);
      this.acc -= STEP_S;
      steps++;
    }
    if (steps) this.slap(steps * STEP_S);
    if (this.puff.step(dt)) active = true;
    if (steps === MAX_STEPS) this.acc = 0;
    if (!steps && !this.dormant) active = true;
    if (!this.dormant && this.lost(dt)) active = true;

    // TOWEL
    if (this.clothIn > 0) {
      this.clothIn -= dt;
      active = true;
      if (this.clothIn <= 0) {
        this.sim.centroid(this.mid);
        this.cloth.drop(this.mid[0], this.mid[2]);
        this.onState(this.folds, "covered");
      }
    }

    if (!this.dormant) {
      // SKIN LOW-PASS
      // time constant shrinks with speed, hides inner particle shuffle
      const tau =
        (this.pointer !== -1 ? FIELD.heldS : FIELD.freeS) / (1 + this.sim.speed * FIELD.follow);
      this.surface.blend = tau > 0 && !this.snap ? 1 - Math.exp(-dt / tau) : 1;
      this.snap = false;
      this.surface.update(this.sim.x, this.sim.n, this.sim.ca, this.sim.cb, this.skin);
      this.shadeBoard();
    }
    if (this.intro >= 0) {
      this.drop(dt);
      active = true;
    }
    this.board.flush();
    this.renderer.render(this.scene, this.camera);
    if (!this.shown) {
      this.shown = true;
      this.canvas.setAttribute("data-cv-shown", "");
    }
    const settled = this.dormant && this.intro < 0 && !this.puff.active;
    this.quiet = settled ? SETTLE_FRAMES : active ? 0 : this.quiet + 1;
    if (this.quiet < SETTLE_FRAMES) this.wake();
    else this.last = 0;
  };

  // INTRO
  // mesh-only drop and squash, sim stays dormant
  private drop(dt: number) {
    const t = (this.intro += dt);
    const { height, fallS, wobbleS, squash, decay } = INTRO;
    const b = this.blob;
    if (t >= fallS && t - dt < fallS) this.ring(0, 0, 1);
    if (t < fallS) {
      const k = t / fallS;
      const st = 0.06 * k;
      b.position.y = height * (1 - k * k);
      b.scale.set(1 - st * 0.5, 1 + st, 1 - st * 0.5);
    } else if (t < fallS + wobbleS) {
      const u = t - fallS;
      const sq = squash * Math.exp(-u * decay);
      b.position.y = 0;
      b.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
    } else this.land();
    this.board.contact.value = 1 - Math.min(1, b.position.y / 0.8);
  }

  private land() {
    this.intro = -1;
    this.blob.position.y = 0;
    this.blob.scale.set(1, 1, 1);
    this.board.contact.value = 1;
  }

  // THROWN OUT
  private lost(dt: number) {
    if (this.pointer !== -1) return false;
    const x = this.sim.x;
    let seen = 0;
    let gone = 0;
    for (let i = 0; i < this.sim.n * 3; i += 3 * LOST_STRIDE) {
      seen++;
      if (x[i + 1] > 1.5) continue;
      scratch.set(x[i], x[i + 1], x[i + 2]).project(this.camera);
      if (Math.abs(scratch.x) > EDGE_NDC || Math.abs(scratch.y) > EDGE_NDC) gone++;
    }
    const out = gone > seen * LOST_SHARE;
    this.offscreen = out ? this.offscreen + dt : 0;
    if (this.offscreen > OFFSCREEN_S) this.reset();
    return out;
  }

  // RESIZE
  private queueResize() {
    this.sized = false;
    this.quiet = 0;
    this.wake();
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.rect.left = r.left;
    this.rect.top = r.top;
    this.rect.width = r.width || 1;
    this.rect.height = r.height || 1;
    const aspect = this.rect.width / this.rect.height;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
    this.renderer.setSize(this.rect.width, this.rect.height, false);

    const halfV = (FOV_DEG * Math.PI) / 360;
    const halfH = Math.atan(Math.tan(halfV) * aspect);
    const dist = CAM_FIT / 2 / Math.tan(Math.min(halfV, halfH));
    const cam = this.camera;
    cam.aspect = aspect;
    cam.position.set(0, TARGET_Y + Math.sin(CAM_PITCH_RAD) * dist, Math.cos(CAM_PITCH_RAD) * dist);
    cam.lookAt(0, TARGET_Y, 0);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.board.fit(aspect);
    this.bench.value.set(BENCH.hw, BENCH.hd, BENCH.r, BENCH.drop);
    this.win.uWin.value
      .copy(this.key.position)
      .normalize()
      .transformDirection(cam.matrixWorldInverse);
    this.puff.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    this.sized = true;
  }

  dispose() {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
    this.renderer.dispose();
    if (!this.renderer.getContext().isContextLost()) this.renderer.forceContextLoss();
  }
}

function pause() {
  return new Promise<void>((done) => setTimeout(done, 0));
}
