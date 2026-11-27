import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Points,
  ShaderMaterial,
  type Vector3,
} from "three";
import { benchY } from "./bench";
import { PUFF_FS, PUFF_VS } from "./shaders";

// FLOUR IN THE AIR
// fixed particle pool, point sizes in pixels so dust stays fine at any distance

const COUNT = 1400;
const CLUMP_SHARE = 0.04;
const SIZE_PX = { dust: [0.8, 1.8], clump: [2.2, 3.0] };
const LIFE_S = { dust: [0.8, 1.5], clump: [0.6, 1.0] };
const DRAG_PER_S = 4.5;
const GRAVITY = { dust: 1.6, clump: 7 };
const SWIRL = 0.5;
const FADE_S = 0.3; // change settled dust fade here
const ALPHA = { dust: 0.95, clump: 0.85 };
const COLOR = "#fff6e8";
const BRIGHT = 2.2; // change dust brightness, above 1 to survive tone mapping

export class Puff {
  readonly points: Points;
  private geo = new BufferGeometry();
  private mat: ShaderMaterial;
  private x = new Float32Array(COUNT * 3);
  private v = new Float32Array(COUNT * 3);
  private age = new Float32Array(COUNT);
  private span = new Float32Array(COUNT);
  private fall = new Float32Array(COUNT);
  private life = new Float32Array(COUNT).fill(-1);
  private size = new Float32Array(COUNT);
  private alpha = new Float32Array(COUNT);
  private phase = new Float32Array(COUNT);
  private next = 0;
  private alive = 0;
  private time = 0;
  private seed = 1;

  constructor(win: { value: Vector3 }) {
    this.geo.setAttribute("position", new BufferAttribute(this.x, 3));
    this.geo.setAttribute("aLife", new BufferAttribute(this.life, 1));
    this.geo.setAttribute("aSize", new BufferAttribute(this.size, 1));
    this.geo.setAttribute("aAlpha", new BufferAttribute(this.alpha, 1));
    this.mat = new ShaderMaterial({
      vertexShader: PUFF_VS,
      fragmentShader: PUFF_FS,
      uniforms: {
        uDpr: { value: 1 },
        uColor: { value: new Color(COLOR).multiplyScalar(BRIGHT) },
        uWin: win,
      },
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
    });
    this.points = new Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.visible = false;
  }

  set dpr(v: number) {
    this.mat.uniforms.uDpr.value = v;
  }

  get active() {
    return this.alive > 0;
  }

  private rand() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  burst(x: number, y: number, z: number, rx: number, rz: number, n: number, speed: number) {
    for (let k = 0; k < n; k++) {
      const p = this.next;
      this.next = (this.next + 1) % COUNT;
      const clump = this.rand() < CLUMP_SHARE;
      const a = (k / n) * Math.PI * 2 + this.rand() * 0.6;
      const cs = Math.cos(a),
        sn = Math.sin(a);
      const o = p * 3;
      const j = 0.75 + this.rand() * 0.4;
      this.x[o] = x + cs * rx * j;
      this.x[o + 1] = y + this.rand() * 0.05;
      this.x[o + 2] = z + sn * rz * j;
      const s = speed * (0.3 + this.rand() * 1.0);
      this.v[o] = cs * s;
      this.v[o + 1] = speed * (0.6 + this.rand() * 1.1);
      this.v[o + 2] = sn * s;
      const life = clump ? LIFE_S.clump : LIFE_S.dust;
      this.span[p] = life[0] + this.rand() * (life[1] - life[0]);
      const sz = clump ? SIZE_PX.clump : SIZE_PX.dust;
      this.size[p] = sz[0] + this.rand() * (sz[1] - sz[0]);
      this.alpha[p] = (clump ? ALPHA.clump : ALPHA.dust) * (0.4 + 0.6 * this.rand());
      this.fall[p] = clump ? GRAVITY.clump : GRAVITY.dust;
      this.phase[p] = this.rand() * 6.283;
      this.age[p] = 0;
      this.life[p] = 0;
    }
    this.alive = COUNT;
    this.points.visible = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }

  step(dt: number) {
    if (!this.alive) return false;
    const { x, v, age, span, life, phase, fall } = this;
    this.time += dt;
    const t0 = this.time;
    const damp = Math.exp(-DRAG_PER_S * dt);
    let alive = 0;
    for (let p = 0; p < COUNT; p++) {
      if (life[p] < 0) continue;
      age[p] += dt;
      const o = p * 3;
      const floor = benchY(x[o], x[o + 2]) + 0.006;
      const landed = x[o + 1] <= floor;
      const t = landed ? Math.max(age[p] / span[p], 1 - FADE_S / span[p]) : age[p] / span[p];
      if (t >= 1) {
        life[p] = -1;
        continue;
      }
      alive++;
      life[p] = t;
      if (landed) {
        age[p] += dt * 0.5;
        continue;
      }
      const ph = phase[p];
      const sx = Math.sin(x[o + 1] * 3.1 + t0 * 1.2 + ph) * SWIRL;
      const sz = Math.cos(x[o] * 2.7 + t0 * 1.0 + ph) * SWIRL;
      v[o] = v[o] * damp + sx * dt;
      v[o + 1] = v[o + 1] * damp - fall[p] * dt;
      v[o + 2] = v[o + 2] * damp + sz * dt;
      x[o] += v[o] * dt;
      x[o + 1] += v[o + 1] * dt;
      x[o + 2] += v[o + 2] * dt;
      if (x[o + 1] < floor) {
        x[o + 1] = floor;
        v[o] = v[o + 1] = v[o + 2] = 0;
      }
    }
    this.alive = alive;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aLife.needsUpdate = true;
    this.points.visible = alive > 0;
    return true;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
