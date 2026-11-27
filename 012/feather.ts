import {
  CanvasTexture,
  DoubleSide,
  Euler,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
} from "three";
import { blurPlume, TEX_H, TEX_W, type Look } from "./plume";

// FEATHER
// scripted flutter, not simulated: one pendulum phase drives glide, tilt and bank

const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const FOV_DEG = 26;
const CAM_Z = 10;
const LENGTH = 1;
const VIEW_FIT = 2.7;
const FALL = 0.2; // change for a slower descent
const SWING = 0.55;
const SWING_HZ = 0.16;
const LIFT = 0.07;
const TILT = 0.42;
const BANK = 0.75;
const TUMBLE_S = 1.9;
const TUMBLE_EVERY_S = [11, 19];
const GUST_GAIN = 0.55;
const GUST_R = 0.9;
const GUST_TAU_S = 1.3;
const MAX_WIND = 2.2;
const DRAFT = 0.6;
const PAPER_Z = -0.55;
const SHADOW = 0.2;

const VS = `
uniform mat4  uModel;
uniform float uTime;
uniform float uFlutter;
uniform float uCurl;
uniform float uShadow;
uniform vec3  uLight;
varying vec2  vUv;
varying vec3  vPos;
void main() {
  vUv = uv;
  vec3 p = position;
  float v = uv.y;
  float side = (uv.x - 0.5) * 2.0;
  // BEND
  p.z += uCurl * (v * v - 0.3);
  p.z += 0.035 * side * side;
  p.z += uFlutter * 0.03 * side * side * sin(uTime * 9.0 + v * 11.0 + side * 2.0);
  p.z += uFlutter * 0.02 * v * v * sin(uTime * 5.3 + v * 4.0);
  vec4 w = uModel * vec4(p, 1.0);
  if (uShadow > 0.5) {
    w.xyz -= uLight * ((w.z - ${PAPER_Z.toFixed(2)}) / uLight.z);
  }
  vPos = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FS = `
uniform sampler2D uMap;
uniform sampler2D uSoft;
uniform float uShadow;
uniform vec3  uLight;
uniform vec3  uBase;
uniform vec3  uBar;
uniform vec3  uDown;
uniform vec3  uShaft;
uniform float uBars;
varying vec2  vUv;
varying vec3  vPos;

// COLOUR
// the texture only says what is barb, down or shaft; the barring is laid on here
vec3 paint(vec3 m) {
  float v = vUv.y;
  float rx = 0.5 + 0.025 * sin(3.14159 * v);
  float s = clamp(abs(vUv.x - rx) / 0.4, 0.0, 1.0);
  float vm = v - 0.04 * s;
  float band = uBars > 0.0 ? smoothstep(0.35, 0.75, 0.5 + 0.5 * sin(vm * uBars * 6.28318)) : 0.0;
  float down = m.g;
  float ink = min(1.0, (band * 0.9 + smoothstep(0.75, 1.0, s) * 0.15) * (1.0 - down)
    + smoothstep(0.82, 0.98, vm) * 0.4);
  vec3 firm = mix(uBase, uBar, ink);
  vec3 fluff = mix(uDown, uBase, s * 0.3);
  vec3 c = mix(firm, fluff, smoothstep(0.0, 0.6, down));
  return mix(c, uShaft, m.b) * m.r * 2.0;
}

void main() {
  if (uShadow > 0.5) {
    float a = texture2D(uSoft, vUv).a * ${SHADOW.toFixed(2)};
    gl_FragColor = vec4(vec3(0.17, 0.12, 0.08) * a, a);
    return;
  }
  vec4 tex = texture2D(uMap, vUv);
  if (tex.a < 0.004) discard;
  vec3 albedo = paint(tex.rgb / tex.a);
  // SHADING
  // flat normal from screen derivatives, flipped to the eye; back light = transmission
  vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
  if (n.z < 0.0) n = -n;
  float ndl = dot(n, uLight);
  float diff = max(ndl, 0.0);
  float through = max(-ndl, 0.0);
  vec3 col = albedo * (0.62 + 0.5 * diff);
  col += albedo * vec3(1.0, 0.86, 0.66) * through * (1.1 - tex.a * 0.5);
  vec3 h = normalize(uLight + vec3(0.0, 0.0, 1.0));
  float sat = pow(max(dot(n, h), 0.0), 30.0);
  col += sat * 0.12;
  float a = tex.a * 0.96;
  gl_FragColor = vec4(min(col, vec3(1.0)) * a, a);
}`;

const euler = new Euler(0, 0, 0, "ZXY");
const quat = new Quaternion();
const pos = new Vector3();
const SIZE = new Vector3(1, 1, 1);

export class Feather {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(FOV_DEG, 1, 0.1, 40);
  private geo: PlaneGeometry;
  private mat: ShaderMaterial;
  private shadowMat: ShaderMaterial;
  private map: CanvasTexture;
  private soft: CanvasTexture;
  private model = new Matrix4();

  private raf = 0;
  private last = 0;
  private visible = false;
  private sized = false;
  private ready = false;
  private reducedMotion: boolean;
  private cleanups: (() => void)[] = [];
  private rect = { left: 0, top: 0, width: 1, height: 1 };
  private viewW = 1;
  private viewH = 1;
  private scale = 1;
  private swing = SWING;

  // FLIGHT
  private time = 0;
  private phase = 0;
  private y = 0.6;
  private cx = 0;
  private windX = 0;
  private windY = 0;
  private spin = 0;
  private spinV = 0;
  private stir = 0;
  private tumble = 1;
  private nextTumble = 9;
  private fallen = 0;

  // CURSOR
  private px = 0;
  private py = 0;
  private pt = 0;
  private hasPointer = false;

  onState: (fallen: number, wind: number) => void = () => {};

  constructor(
    private canvas: HTMLCanvasElement,
    plume: HTMLCanvasElement,
    look: Look,
  ) {
    const params = new URLSearchParams(location.search);
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion = mq.matches;
    const onMotion = () => {
      this.reducedMotion = mq.matches;
      this.wake();
    };
    mq.addEventListener("change", onMotion);

    const r = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
    });
    if (!params.has("gl") && software(r.getContext())) {
      mq.removeEventListener("change", onMotion);
      r.dispose();
      r.forceContextLoss();
      throw new Error("software gl");
    }
    r.debug.checkShaderErrors = import.meta.env.DEV;
    r.setClearColor(0x000000, 0);
    this.renderer = r;

    this.map = texture(plume, r.capabilities.getMaxAnisotropy());
    this.soft = texture(blurPlume(plume), 1);
    this.geo = new PlaneGeometry((LENGTH * TEX_W) / TEX_H, LENGTH, 12, 48);

    const light = new Vector3(-0.35, 0.55, 0.75).normalize();
    const uniforms = (shadow: number) => ({
      uModel: { value: this.model },
      uTime: { value: 0 },
      uFlutter: { value: 0.3 },
      uCurl: { value: 0.12 },
      uShadow: { value: shadow },
      uLight: { value: light },
      uMap: { value: this.map },
      uSoft: { value: this.soft },
      uBase: { value: rgb(look.base) },
      uBar: { value: rgb(look.bar) },
      uDown: { value: rgb(look.down) },
      uShaft: { value: rgb(look.shaft) },
      uBars: { value: look.bars },
    });
    const base = {
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: false,
      side: DoubleSide,
    };
    this.shadowMat = new ShaderMaterial({ ...base, uniforms: uniforms(1) });
    this.mat = new ShaderMaterial({ ...base, uniforms: uniforms(0) });
    // SHARED UNIFORMS
    this.shadowMat.uniforms.uTime = this.mat.uniforms.uTime;
    this.shadowMat.uniforms.uFlutter = this.mat.uniforms.uFlutter;
    this.shadowMat.uniforms.uCurl = this.mat.uniforms.uCurl;
    for (const [m, order] of [
      [this.shadowMat, 0],
      [this.mat, 1],
    ] as const) {
      const mesh = new Mesh(this.geo, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = order;
      this.scene.add(mesh);
    }
    this.camera.position.set(0, 0, CAM_Z);

    // OBSERVERS
    const ro = new ResizeObserver(() => {
      this.sized = false;
      this.wake();
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      this.wake();
    });
    io.observe(canvas);
    const onVisibility = () => {
      this.last = 0;
      this.hasPointer = false;
      this.wake();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const opts = { passive: true };
    addEventListener("pointermove", this.move, opts);
    addEventListener("pointerdown", this.move, opts);
    this.cleanups.push(
      () => mq.removeEventListener("change", onMotion),
      () => ro.disconnect(),
      () => io.disconnect(),
      () => document.removeEventListener("visibilitychange", onVisibility),
      () => removeEventListener("pointermove", this.move),
      () => removeEventListener("pointerdown", this.move),
    );
  }

  async start() {
    await this.renderer.compileAsync(this.scene, this.camera);
    this.ready = true;
    this.wake();
  }

  // INPUT
  // cursor speed near the feather becomes wind
  private move = (e: PointerEvent) => {
    const r = this.rect;
    const x = ((e.clientX - r.left) / r.width - 0.5) * this.viewW;
    const y = (0.5 - (e.clientY - r.top) / r.height) * this.viewH;
    const t = e.timeStamp / 1000;
    if (this.hasPointer && e.type === "pointermove") {
      const dt = Math.max(1 / 240, Math.min(0.1, t - this.pt));
      this.blow(x, y, (x - this.px) / dt, (y - this.py) / dt, dt);
    }
    this.px = x;
    this.py = y;
    this.pt = t;
    this.hasPointer = true;
  };

  private blow(x: number, y: number, vx: number, vy: number, dt: number) {
    if (this.reducedMotion) return;
    const fx = this.cx + this.swing * Math.sin(this.phase);
    const dx = fx - x;
    const dy = this.y - y;
    const reach = GUST_R * this.scale;
    const fall = Math.exp(-(dx * dx + dy * dy) / (reach * reach));
    if (fall < 0.01) return;
    const k = GUST_GAIN * fall * Math.min(1, dt * 12);
    this.windX += vx * k * 0.25;
    this.windY += vy * k * 0.25;
    const m = Math.hypot(this.windX, this.windY);
    if (m > MAX_WIND) {
      this.windX *= MAX_WIND / m;
      this.windY *= MAX_WIND / m;
    }
    this.spinV += (dx * vy - dy * vx) * k * 0.25;
    this.stir = Math.min(1, this.stir + Math.hypot(vx, vy) * k * 0.08);
    if (this.stir > 0.85 && this.tumble >= 1 && Math.hypot(vx, vy) * fall > 6) this.tumble = 0;
    this.wake();
  }

  // LOOP
  private wake() {
    if (!this.raf && this.ready && this.visible && !document.hidden)
      this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible || document.hidden) return;
    const dt = this.last ? Math.min(MAX_DT_S, (now - this.last) / 1000) : 0;
    this.last = now;
    if (!this.sized) this.resize();
    if (!this.reducedMotion) this.step(dt);
    this.pose();
    this.renderer.render(this.scene, this.camera);
    if (!this.reducedMotion) this.wake();
  };

  private step(dt: number) {
    const s = this.scale;
    this.time += dt;
    const rate = Math.PI * 2 * SWING_HZ * (1 + 0.5 * this.stir);
    this.phase += rate * dt;
    this.stir *= Math.exp(-dt / 2.5);

    // WIND
    const decay = Math.exp(-dt / GUST_TAU_S);
    this.windX *= decay;
    this.windY *= decay;
    this.cx += this.windX * dt;
    const edge = this.viewW * 0.5 - this.swing - 0.25 * s;
    const over = Math.abs(this.cx) - Math.max(0, edge * 0.6);
    if (over > 0) this.cx -= Math.sign(this.cx) * over * DRAFT * dt;
    const c = Math.cos(this.phase);
    const sink = FALL * s * (0.55 + 0.75 * c * c);
    this.y += (this.windY - sink) * dt;
    this.fallen += sink * dt;

    this.spinV += -this.spin * 2.2 * dt;
    this.spinV *= Math.exp(-dt / 0.9);
    this.spin += this.spinV * dt;

    // TUMBLE
    if (this.tumble < 1) this.tumble = Math.min(1, this.tumble + dt / TUMBLE_S);
    else if (this.time > this.nextTumble && Math.abs(Math.sin(this.phase)) > 0.95) {
      this.tumble = 0;
      const [a, b] = TUMBLE_EVERY_S;
      this.nextTumble = this.time + a + Math.random() * (b - a);
    }

    // WRAP
    // re-enter from the top near the middle
    const margin = 0.42 * s;
    if (this.y < -this.viewH / 2 - margin) {
      this.y = this.viewH / 2 + margin;
      this.cx = (Math.random() - 0.5) * this.viewW * 0.3;
      this.windY = 0;
    } else if (this.y > this.viewH / 2 + margin * 1.5) this.windY = Math.min(this.windY, -0.3);
    this.onState(this.fallen, Math.hypot(this.windX, this.windY));
  }

  // POSE
  private pose() {
    const s = this.scale;
    const sn = Math.sin(this.phase);
    const cs = Math.cos(this.phase);
    const x = this.cx + this.swing * sn;
    const y = this.y + LIFT * s * -Math.cos(2 * this.phase);
    const tt = this.tumble;
    const roll = tt < 1 ? Math.PI * 2 * tt * tt * (3 - 2 * tt) : 0;
    euler.set(
      0.25 * cs + 0.1 * Math.sin(this.time * 0.7),
      BANK * (0.4 + 0.6 * this.stir) * cs + roll + 0.1,
      -Math.PI / 2 + 0.22 + TILT * sn + this.spin,
    );
    quat.setFromEuler(euler);
    pos.set(x, y, 0);
    SIZE.set(s, s, s);
    this.model.compose(pos, quat, SIZE);
    const u = this.mat.uniforms;
    u.uTime.value = this.time;
    u.uFlutter.value = 0.35 + 1.4 * this.stir + 0.3 * Math.abs(cs);
    u.uCurl.value = 0.1 + 0.05 * cs * cs;
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
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewH = 2 * CAM_Z * Math.tan((FOV_DEG * Math.PI) / 360);
    this.viewW = this.viewH * aspect;
    // FIT
    // scale to the shorter side; narrow screens get a shorter glide
    this.scale = Math.min(this.viewH / VIEW_FIT, this.viewW / 2);
    this.swing = Math.min(SWING * this.scale, this.viewW * 0.16);
    this.sized = true;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
    this.geo.dispose();
    this.mat.dispose();
    this.shadowMat.dispose();
    this.map.dispose();
    this.soft.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

function rgb([r, g, b]: number[]) {
  return new Vector3(r / 255, g / 255, b / 255);
}

function texture(c: HTMLCanvasElement, aniso: number) {
  const t = new CanvasTexture(c);
  t.premultiplyAlpha = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.anisotropy = aniso;
  return t;
}

function software(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}
