import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  Object3D,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector3,
  Vector4,
  WebGLRenderer,
  type IUniform,
} from "three";
import { FLOCK, Flock, sheet } from "./bats";
import { raf, unraf, type Opts } from "./gl";
import { BAT_FS, BAT_VS, CAVE_FS, CAVE_VS, SONAR, WATER_FS, WATER_VS } from "./shaders";
import { CAVE, SAFE, build, frame, sample, type Tunnel } from "./tunnel";

const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const FOV_DEG = 66;
const MAX_FOV_DEG = 88;
const NEAR_M = 0.04;
const FAR_M = 95;
const AHEAD_M = 86;
const BEHIND_M = 6;
const WATER_NEAR_M = 70;
const WATER_REACH_M = 34;
const FLY_M_S = 3.1;
const FLY_CHAMBER_M_S = 2.2;
const LOOK_M = 6;
const STEER_TAU_S = 0.75;
const ROLL_TAU_S = 0.5;
const SPEED_TAU_S = 1.2;
const BANK = 0.22; // change bank strength here
const START_FRAC = 0.02;
const OPENING_S = [1.1, 1.27];
const IDLE_S = 6; // change hint delay here
const MIN_GAP_S = 0.15;
const PUSH_M_S_PER_PX = 0.022; // change wheel gain here
const MAX_PUSH_M_S = 8.5;
const PUSH_TAU_S = 1.1; // change coast time here
const RUSH_FOV = 0.08;
const PING_AHEAD_M = 0.25;
const HUD_S = 0.2;
const FREEZE_M = 4.5;
const FREEZE_AGES_S = [1.5, 0.75, 0.2];
const FREEZE_T_S = 30;
const BONE = 0x04070a;

export type Hud = { pings: number; echo: number; delay: number; speed: number; idle: boolean };

const _v = new Vector3();
const _w = new Vector3();

export class Cave {
  onShown: () => void = () => {};
  onHud: (h: Hud) => void = () => {};

  private renderer: WebGLRenderer;
  private scene = new Scene();
  private mirror = new Scene();
  private camera = new PerspectiveCamera(FOV_DEG, 1, NEAR_M, FAR_M);
  private tunnel: Tunnel;
  private flock: Flock;
  private uniforms: Record<string, IUniform>;
  private pings: Vector4[] = [];
  private newest = 0;
  private meshes: Mesh[] = [];
  private mirrors: Mesh[] = [];
  private bats: InstancedMesh;
  private batsMirror: InstancedMesh;
  private flap: InstancedBufferAttribute;
  private water: Mesh;
  private disposables: { dispose: () => void }[] = [];
  private dummy = new Object3D();
  private f = frame();
  private g = frame();
  private raf = 0;
  private last = 0;
  private time = 0;
  private visible = false;
  private sized = false;
  private shown = false;
  private reduced: boolean;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private s = 0;
  private speed = FLY_M_S;
  private tx = 0;
  private ty = 0;
  private ex = 0;
  private ey = 0;
  private roll = 0;
  private lastOx = 0;
  private opening = 0;
  private lastPing = 0;
  private push = 0;
  private lens = 0;
  private fov = FOV_DEG;
  private hudT = 0;
  private hud: Hud = { pings: 0, echo: 0, delay: 0, speed: 0, idle: false };

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, opts: Opts) {
    this.reduced = opts.reducedMotion;
    const r = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      powerPreference: "high-performance",
    });
    r.debug.checkShaderErrors = import.meta.env.DEV;
    r.autoClear = false;
    r.setClearColor(new Color(BONE), 1);
    this.renderer = r;

    for (let i = 0; i < SONAR.MAX_PINGS; i++) this.pings.push(new Vector4(0, 0, 0, -1e3));
    this.uniforms = {
      uPings: { value: this.pings },
      uTime: { value: 0 },
      uPx: { value: 0.001 },
      uDpr: { value: 1 },
      uWater: { value: new Vector4(0, -1e4, 0, 0) },
    };

    // ROCK
    this.tunnel = build();
    this.s = (Number.isFinite(opts.at) ? (opts.at as number) : START_FRAC) * this.tunnel.L;
    const mat = (vs: string, fs: string, mirror: boolean) => {
      const m = new ShaderMaterial({
        vertexShader: vs,
        fragmentShader: fs,
        uniforms: this.uniforms,
        side: DoubleSide,
        defines: mirror ? { MIRROR: "" } : {},
      });
      this.disposables.push(m);
      return m;
    };
    const rock = mat(CAVE_VS, CAVE_FS, false);
    const rockMirror = mat(CAVE_VS, CAVE_FS, true);
    for (const c of this.tunnel.chunks) {
      const geo = new BufferGeometry();
      geo.setAttribute("position", new BufferAttribute(c.position, 3));
      geo.setAttribute("normal", new BufferAttribute(c.normal, 3));
      geo.setIndex(new BufferAttribute(c.index, 1));
      geo.computeBoundingSphere();
      this.disposables.push(geo);
      const m = new Mesh(geo, rock);
      m.matrixAutoUpdate = false;
      m.userData.ring = c.ring;
      this.scene.add(m);
      this.meshes.push(m);
      const mm = new Mesh(geo, rockMirror);
      mm.matrixAutoUpdate = false;
      mm.frustumCulled = false;
      this.mirror.add(mm);
      this.mirrors.push(mm);
    }

    // BATS
    this.flock = new Flock(this.tunnel);
    const sh = sheet();
    const batGeo = new BufferGeometry();
    batGeo.setAttribute("position", new BufferAttribute(sh.position, 3));
    batGeo.setIndex(new BufferAttribute(sh.index, 1));
    this.flap = new InstancedBufferAttribute(new Float32Array(FLOCK.COUNT * 3), 3);
    batGeo.setAttribute("aFlap", this.flap);
    this.disposables.push(batGeo);
    this.bats = new InstancedMesh(batGeo, mat(BAT_VS, BAT_FS, false), FLOCK.COUNT);
    this.batsMirror = new InstancedMesh(batGeo, mat(BAT_VS, BAT_FS, true), FLOCK.COUNT);
    this.batsMirror.instanceMatrix = this.bats.instanceMatrix;
    for (const b of [this.bats, this.batsMirror]) {
      b.frustumCulled = false;
      b.matrixAutoUpdate = false;
    }
    this.scene.add(this.bats);
    this.mirror.add(this.batsMirror);

    // WATER
    const disc = new PlaneGeometry(WATER_REACH_M * 2, WATER_REACH_M * 2, 1, 1);
    disc.rotateX(-Math.PI / 2);
    this.disposables.push(disc);
    const wm = new ShaderMaterial({
      vertexShader: WATER_VS,
      fragmentShader: WATER_FS,
      uniforms: this.uniforms,
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
    });
    this.disposables.push(wm);
    this.water = new Mesh(disc, wm);
    this.water.frustumCulled = false;
    this.water.renderOrder = 2;
    this.scene.add(this.water);

    if (this.reduced) this.freeze();
  }

  // HOST
  size(w: number, h: number, dpr: number, _top: number) {
    this.cssW = Math.max(1, w);
    this.cssH = Math.max(1, h);
    this.dpr = Math.min(dpr || 1, MAX_DPR);
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
    if (reduced) this.freeze();
    this.wake();
  }

  // INPUT
  // steer in -1..1 from canvas centre
  steer(x: number, y: number) {
    this.tx = Math.max(-1, Math.min(1, x));
    this.ty = Math.max(-1, Math.min(1, y));
    this.wake();
  }

  wheel(px: number) {
    if (this.reduced || !this.shown) return;
    this.push = Math.max(-this.speed, Math.min(MAX_PUSH_M_S, this.push + px * PUSH_M_S_PER_PX));
    this.wake();
  }

  press(_x: number, _y: number) {
    this.call();
  }

  key(_k: string) {
    this.call();
  }

  private call() {
    if (this.reduced || !this.shown || this.time - this.lastPing < MIN_GAP_S) return;
    this.ping();
    this.report();
    this.wake();
  }

  // PING
  // first expired slot, else the oldest
  private ping() {
    let slot = -1;
    let oldest = 0;
    for (let i = 0; i < SONAR.MAX_PINGS; i++) {
      if (this.time - this.pings[i].w > SONAR.LIFE_S) {
        slot = i;
        break;
      }
      if (this.pings[i].w < this.pings[oldest].w) oldest = i;
    }
    if (slot < 0) slot = oldest;
    this.newest = slot;
    const c = this.camera;
    c.getWorldDirection(_v);
    const p = this.pings[slot];
    p.set(
      c.position.x + _v.x * PING_AHEAD_M,
      c.position.y + _v.y * PING_AHEAD_M,
      c.position.z + _v.z * PING_AHEAD_M,
      this.time,
    );
    this.hud.pings++;
    this.lastPing = this.time;
  }

  // REDUCED MOTION
  // one held frame over the first pool, three pings out
  private freeze() {
    const ch = this.tunnel.chambers[0];
    this.s = ch.s + FREEZE_M;
    this.ex = this.ey = this.tx = this.ty = 0;
    this.pose(0);
    for (const p of this.pings) p.w = -1e3;
    for (const age of FREEZE_AGES_S) {
      this.time = FREEZE_T_S - age;
      this.ping();
    }
    this.time = FREEZE_T_S;
    this.flock.step(0, this.s);
    for (let k = 0; k < 40; k++) this.flock.step(0.1, this.s);
    this.place();
  }

  // LOOP
  private wake() {
    if (!this.raf && this.visible) this.raf = raf(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible) return;
    const dt = this.last ? Math.min(MAX_DT_S, (now - this.last) / 1000) : 0;
    this.last = now;
    if (!this.sized) this.resize();
    if (!this.reduced) this.step(dt);
    this.draw();
    if (!this.shown) {
      this.shown = true;
      this.onShown();
      if (this.reduced) this.report();
    }
    if (!this.reduced) this.wake();
  };

  private resize() {
    const r = this.renderer;
    r.setPixelRatio(this.dpr);
    r.setSize(this.cssW, this.cssH, false);
    const aspect = this.cssW / this.cssH;
    const cam = this.camera;
    cam.aspect = aspect;
    const minH = 2 * Math.atan(Math.tan((58 * Math.PI) / 360) / aspect);
    this.fov = Math.min(MAX_FOV_DEG, Math.max(FOV_DEG, (minH * 180) / Math.PI));
    cam.fov = this.fov;
    this.lens = 1;
    cam.updateProjectionMatrix();
    this.uniforms.uPx.value = (2 * Math.tan((cam.fov * Math.PI) / 360)) / this.cssH;
    this.uniforms.uDpr.value = this.dpr;
    this.sized = true;
  }

  private step(dt: number) {
    this.time += dt;
    const f = this.f;
    sample(this.tunnel, this.s, f);
    const target = FLY_M_S + (FLY_CHAMBER_M_S - FLY_M_S) * f.ch;
    this.speed += (target - this.speed) * (1 - Math.exp(-dt / SPEED_TAU_S));
    this.push *= Math.exp(-dt / PUSH_TAU_S);
    if (this.push < -this.speed) this.push = -this.speed;
    this.s = (this.s + (this.speed + this.push) * dt) % this.tunnel.L;
    const k = 1 - Math.exp(-dt / STEER_TAU_S);
    this.ex += (this.tx - this.ex) * k;
    this.ey += (this.ty - this.ey) * k;
    this.pose(dt);

    // OPENING
    if (this.opening < OPENING_S.length && this.time >= OPENING_S[this.opening]) {
      this.opening++;
      this.ping();
    }

    // LENS
    const rush = Math.max(0, this.push) / MAX_PUSH_M_S;
    const lens = 1 + RUSH_FOV * rush * rush;
    if (Math.abs(lens - this.lens) > 1e-4) {
      this.lens = lens;
      this.camera.fov = this.fov * lens;
      this.camera.updateProjectionMatrix();
    }

    this.flock.step(dt, this.s);
    this.place();

    this.hudT -= dt;
    if (this.hudT <= 0) {
      this.hudT = HUD_S;
      this.report();
    }
  }

  // HUD
  // echo delay at the real speed of sound, 343 m/s
  private report() {
    const last = this.pings[this.newest];
    const age = this.time - last.w;
    const front = age * SONAR.SPEED_M_S < SONAR.RANGE_M ? age * SONAR.SPEED_M_S : 0;
    if (front > 0) {
      this.hud.echo = front;
      this.hud.delay = ((2 * front) / 343) * 1000;
    }
    this.hud.speed = this.reduced ? 0 : this.speed + this.push;
    this.hud.idle =
      !this.reduced &&
      this.hud.pings > 0 &&
      this.time - this.lastPing > SONAR.RANGE_M / SONAR.SPEED_M_S + SONAR.HOLD_S + IDLE_S;
    this.onHud(this.hud);
  }

  // CAMERA
  // centre line plus steer, inside the SAFE box
  private pose(dt: number) {
    const f = this.f;
    const g = this.g;
    const t = this.tunnel;
    sample(t, this.s, f);
    sample(t, this.s + LOOK_M, g);
    const ox = this.ex * SAFE.X * f.rw;
    const oy = this.ey * SAFE.Y * f.rh - SAFE.DIP_M * 0.85 * f.ch;
    const cam = this.camera;
    cam.position.set(
      f.c[0] + f.s[0] * ox + f.u[0] * oy,
      f.c[1] + f.s[1] * ox + f.u[1] * oy,
      f.c[2] + f.s[2] * ox + f.u[2] * oy,
    );
    const lx = ox * 0.6 + this.ex * 0.9;
    const ly = oy * 0.6 + this.ey * 0.5;
    _w.set(
      g.c[0] + g.s[0] * lx + g.u[0] * ly,
      g.c[1] + g.s[1] * lx + g.u[1] * ly,
      g.c[2] + g.s[2] * lx + g.u[2] * ly,
    );
    const drift = dt > 0 ? (ox - this.lastOx) / dt : 0;
    this.lastOx = ox;
    const bend = g.t[0] * f.s[0] + g.t[1] * f.s[1] + g.t[2] * f.s[2];
    const want = -drift * BANK - bend * 0.9;
    this.roll += (want - this.roll) * (dt > 0 ? 1 - Math.exp(-dt / ROLL_TAU_S) : 1);
    cam.up.set(f.u[0], f.u[1], f.u[2]);
    cam.lookAt(_w);
    cam.rotateZ(this.roll);
    cam.updateMatrixWorld();
  }

  // SCENE
  // cull chunks by ring distance; mirror pass only near a pool
  private place() {
    const t = this.tunnel;
    const ring = this.s / t.ds;
    const K = CAVE.CHUNK_RINGS;
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      let rel = (m.userData.ring as number) - ring;
      rel = ((rel % t.N) + t.N) % t.N;
      if (rel > t.N / 2) rel -= t.N;
      const on = rel * t.ds < AHEAD_M && (rel + K) * t.ds > -BEHIND_M;
      m.visible = on;
      this.mirrors[i].visible = on;
    }

    let best = Infinity;
    let pool = -1;
    for (let i = 0; i < t.chambers.length; i++) {
      let d = Math.abs(t.chambers[i].s - this.s);
      d = Math.min(d, t.L - d);
      if (d < best) {
        best = d;
        pool = i;
      }
    }
    const w = this.uniforms.uWater.value as Vector4;
    const wet = best < WATER_NEAR_M && pool >= 0;
    if (wet) {
      const c = t.chambers[pool];
      w.set(c.x, c.water, c.z, WATER_REACH_M);
      this.water.position.set(c.x, c.water, c.z);
      this.water.updateMatrixWorld();
    } else w.set(0, -1e4, 0, 0);
    this.water.visible = wet;
    this.mirror.visible = wet;

    const o = this.flock.out;
    const d = this.dummy;
    for (let i = 0; i < FLOCK.COUNT; i++) {
      const b = i * 9;
      const size = o[b + 6];
      d.position.set(o[b], o[b + 1], o[b + 2]);
      _v.set(o[b] + o[b + 3], o[b + 1] + o[b + 4], o[b + 2] + o[b + 5]);
      d.up.set(0, 1, 0);
      d.lookAt(_v);
      d.scale.setScalar(size > 0 ? size : 1e-5);
      d.updateMatrix();
      this.bats.setMatrixAt(i, d.matrix);
      this.flap.setXYZ(i, size, o[b + 7], o[b + 8]);
    }
    this.bats.instanceMatrix.needsUpdate = true;
    this.flap.needsUpdate = true;
  }

  private draw() {
    this.uniforms.uTime.value = this.time;
    const r = this.renderer;
    r.clear();
    if (this.mirror.visible) {
      r.render(this.mirror, this.camera);
      r.clearDepth();
    }
    r.render(this.scene, this.camera);
  }

  dispose() {
    unraf(this.raf);
    this.raf = 0;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.bats.dispose();
    this.batsMirror.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
