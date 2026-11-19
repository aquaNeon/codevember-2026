import { at, build, dist, nearest, strip, wrapS, R_OUT, STEP, type Path } from "./path";
import { AUX_FS, FULL_VS, HEIGHT_FS, MAP_FS, MAP_VS, SHADE_FS, STONES } from "./shaders";

const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const FRESH_N = 4096; // freshness samples along the path
const HOLD_S = 5; // grooves stay crisp this long
const SETTLE_S = 9; // then soften back over this long
const FOLLOW_TAU_S = 0.07;
const MAX_UPS = 14; // fastest the rake runs along a straight, lanes per second
const BEND_SLOW = 1.0; // how much a turn slows it; the tightest run at about a third
const LOOK_UNITS = 0.4; // heading looks this far ahead and behind, so turns are swept
const TURN_HZ = 1.1; // critically damped heading
const CENTRE_S = 2.6; // the moment at the centre before the way out opens
const REST_S = 0.6; // where the rake rests by the gate
const ARRIVE_UNITS = 0.3; // this close to the end of the path counts as at the middle
const GLIDE_S = 0.5;
const LIFT_UNITS = 0.45; // how high the rake floats while it moves to a new spot
const GRAB_UNITS = 1.1; // press this close to the rake to pick it up where it lies
const REACH_UNITS = 1.3; // presses farther than this from any lane are ignored
const WINDOW_UNITS = 2.4; // how far along the path one move may travel
const WALK_UPS = 5; // lanes per second when it walks itself
const KEY_UNITS = 0.6;
const METRES_PER_UNIT = 0.6;
const SUN_AZ_RAD = 2.3; // from the upper left
const SUN_EL_RAD = 0.34;
const AO_UNITS = 0.35;

export type Phase = "rest" | "raking" | "walking" | "centre" | "back";

type Stone = [fx: number, fy: number, r: number, stretch: number, angle: number, height: number];
// viewport fractions from the top left, radius in lanes
const STONES_WIDE: Stone[] = [
  [0.15, 0.3, 1.7, 1.25, 0.4, 0.62],
  [0.235, 0.19, 0.8, 1.1, -0.6, 0.7],
  [0.93, 0.46, 0.9, 1.3, 1.2, 0.6],
  [0.9, 0.68, 0.45, 1.0, 0.0, 0.7],
];
const GATE: Stone[] = [
  [0.1, 0.95, 0.32, 1.15, 0.5, 0.8],
  [0.25, -0.92, 0.26, 1.1, -0.4, 0.8],
];
const STONES_TALL: Stone[] = [
  [0.2, 0.89, 1.5, 1.25, 0.3, 0.62],
  [0.43, 0.95, 0.65, 1.1, -0.5, 0.7],
  [0.86, 0.25, 0.8, 1.3, 1.0, 0.6],
  [0.07, 0.33, 0.45, 1.0, 0.0, 0.7],
];

export class Garden {
  private gl: WebGL2RenderingContext;
  private path: Path;
  private mapProg: WebGLProgram;
  private heightProg: WebGLProgram;
  private auxProg: WebGLProgram;
  private shadeProg: WebGLProgram;
  private um: Record<string, WebGLUniformLocation | null>;
  private vao: WebGLVertexArrayObject;
  private empty: WebGLVertexArrayObject;
  private buffers: WebGLBuffer[] = [];
  private indexCount: number;
  private fresh: WebGLTexture;
  private mapTex: WebGLTexture | null = null;
  private heightTex: WebGLTexture | null = null;
  private auxTex: WebGLTexture | null = null;
  private auxFbo: WebGLFramebuffer;
  private half: [number, number] = [1, 1];
  private uh: Record<string, WebGLUniformLocation | null>;
  private ua: Record<string, WebGLUniformLocation | null>;
  private us: Record<string, WebGLUniformLocation | null>;
  private depth: WebGLRenderbuffer | null = null;
  private mapFbo: WebGLFramebuffer;
  private heightFbo: WebGLFramebuffer;

  private ages = new Float32Array(FRESH_N).fill(1e3);
  private amp = new Uint8Array(FRESH_N);
  private stoneData = new Float32Array(STONES * 4);
  private shapeData = new Float32Array(STONES * 4);

  private raf = 0;
  private last = 0;
  private visible = false;
  private sized = true;
  private dirty = true;
  private shown = false;
  private reducedMotion: boolean;

  // LAYOUT
  private dpr = 1;
  private cssW = 1;
  private cssH = 1;
  private cx = 0; // labyrinth centre, css px from the top left
  private cy = 0;
  private unit = 1; // css px per lane

  // RAKE
  private head = 0.6;
  private target = 0.6;
  private angle = 0;
  private lift = 0;
  private gliding = false;
  private glideT = 0;
  private glideFrom = [0, 0, 0];
  private glideTo = 0;
  private rx = 0;
  private ry = 0;
  private dragging = false;
  private pointer = -1;
  private cursor = "";
  private px = 0;
  private py = 0;
  private walking = 0; // direction while walking itself
  private spin = 0; // heading velocity
  private outward = false;
  private back = false; // came out again
  private pause = 0; // seconds left of the moment at the centre
  private resume = false; // walk out once the moment ends
  private scratch = new Float32Array(4);
  private speed = 0;
  private raked = 0;
  private reported = -1;

  onState: (circuit: number, raked: number, phase: Phase, out: boolean) => void = () => {};
  onCursor: (cursor: string) => void = () => {};
  onShown: () => void = () => {};

  // no dom in here, so the whole scene can live in a worker
  constructor(
    private canvas: HTMLCanvasElement | OffscreenCanvas,
    opts: { reducedMotion: boolean; forceGl: boolean },
  ) {
    this.reducedMotion = opts.reducedMotion;
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("webgl2 unavailable");
    // SOFTWARE GL
    // cpu renderers get the still before any shader compiles; ?gl forces the live path
    if (!opts.forceGl && software(gl)) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      throw new Error("software gl");
    }
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("no float targets");
    this.gl = gl;

    this.path = build();
    this.head = this.target = REST_S;
    this.angle = this.heading(this.head);
    this.place();

    // PROGRAMS
    this.mapProg = program(gl, MAP_VS, MAP_FS);
    this.heightProg = program(gl, FULL_VS, HEIGHT_FS);
    this.auxProg = program(gl, FULL_VS, AUX_FS);
    this.shadeProg = program(gl, FULL_VS, SHADE_FS);
    const field = [
      "uMap",
      "uFresh",
      "uCentre",
      "uUnit",
      "uMapScale",
      "uLen",
      "uGate",
      "uStone",
      "uShape",
      "uRake",
      "uLift",
      "uSpiral",
    ] as const;
    this.um = uniforms(gl, this.mapProg, ["uRes", "uCentre", "uUnit", "uLen"]);
    this.uh = uniforms(gl, this.heightProg, field);
    this.ua = uniforms(gl, this.auxProg, field);
    this.us = uniforms(gl, this.shadeProg, [
      "uHeight",
      "uAux",
      "uRes",
      "uUnit",
      "uAoLod",
      "uSun",
      "uCentre",
      "uRake",
      "uLift",
    ]);

    // GEOMETRY
    const { v, idx } = strip(this.path);
    this.indexCount = idx.length;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 16);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.buffers.push(vb, ib);
    gl.bindVertexArray(null);
    this.empty = gl.createVertexArray();

    // FRESHNESS
    this.fresh = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fresh);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, FRESH_N, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FRESH_N, 1, gl.RED, gl.UNSIGNED_BYTE, this.amp);

    this.mapFbo = gl.createFramebuffer();
    this.heightFbo = gl.createFramebuffer();
    this.auxFbo = gl.createFramebuffer();
  }

  // PUBLIC
  // walks in, pauses at the centre, walks back out; pressed again it stops
  walk() {
    if (this.walking || this.resume) {
      this.walking = 0;
      this.resume = false;
    } else if (this.pause > 0) {
      this.resume = true;
    } else {
      this.walking = this.outward ? -1 : 1;
      this.target = this.head;
      this.gliding = false;
      this.lift = 0;
    }
    this.report();
    this.wake();
  }

  motion(reduced: boolean) {
    this.reducedMotion = reduced;
  }

  // css size of the canvas and the pixel ratio to draw at
  size(w: number, h: number, dpr: number) {
    this.cssW = Math.max(1, w);
    this.cssH = Math.max(1, h);
    this.dpr = Math.min(dpr || 1, MAX_DPR);
    this.sized = false;
    this.wake();
  }

  // on screen and the tab in front
  show(visible: boolean) {
    this.visible = visible;
    this.last = 0;
    this.wake();
  }

  // INPUT
  // pointer positions are css px from the canvas top left
  private toGarden(x: number, y: number) {
    this.px = (x - this.cx) / this.unit;
    this.py = -(y - this.cy) / this.unit;
  }

  down(x: number, y: number, id: number) {
    if (this.pointer !== -1) return;
    this.toGarden(x, y);
    const p = this.path;
    if (Math.hypot(this.rx - this.px, this.ry - this.py) < GRAB_UNITS) {
      this.walking = 0;
      this.grab(id);
      this.target = this.head;
      return;
    }
    const i = nearest(p, this.px, this.py);
    if (dist(p, i, this.px, this.py) > REACH_UNITS) return;
    this.walking = 0;
    this.grab(id);
    // GLIDE
    // the rake lifts off and floats to where you pressed
    this.gliding = !this.reducedMotion;
    this.glideT = 0;
    this.glideFrom[0] = this.rx;
    this.glideFrom[1] = this.ry;
    this.glideFrom[2] = this.angle;
    this.glideTo = p.s[i];
    if (!this.gliding) this.head = this.target = p.s[i];
    this.wake();
  }

  private grab(id: number) {
    this.pointer = id;
    this.dragging = true;
    this.point("grabbing");
    this.report();
  }

  private point(cursor: string) {
    if (cursor === this.cursor) return;
    this.cursor = cursor;
    this.onCursor(cursor);
  }

  move(x: number, y: number, id: number, mouse: boolean) {
    if (id !== this.pointer) {
      if (mouse && this.pointer === -1) this.hover(x, y);
      return;
    }
    this.toGarden(x, y);
    if (this.gliding || this.pause > 0) return;
    this.follow();
  }

  // the rake slides along the lane toward the pointer, never across a wall; on the closing
  // circle it can keep going round, and pulling back leads it out along the spiral
  private follow() {
    const p = this.path;
    this.fold();
    const c = at(p, this.target);
    const w = Math.ceil(WINDOW_UNITS / STEP);
    let i = nearest(p, this.px, this.py, c - w, c + w);
    // across the circle's seam the window runs out; look at the whole circle too
    if (this.target >= p.loop - WINDOW_UNITS) {
      const j = nearest(p, this.px, this.py, at(p, p.loop), p.n - 1);
      if (dist(p, j, this.px, this.py) < dist(p, i, this.px, this.py) - 1e-4) i = j;
    }
    let to = p.s[i];
    // on the circle, take the copy of that spot nearest the rake, so it goes round, not back
    if (to >= p.loop && this.target >= p.loop - WINDOW_UNITS) {
      const k = Math.round((this.target - to) / p.loopLen);
      to += Math.max(0, k) * p.loopLen;
      if (to - this.target > p.loopLen / 2) to -= p.loopLen;
      if (to < p.loop - 1e-6 && p.s[i] >= p.loop) to += p.loopLen;
    }
    this.target = to;
    this.wake();
  }

  // laps already gone round are dropped from both ends together, so the numbers stay small
  private fold() {
    const p = this.path;
    const lap = p.loopLen;
    while (this.head >= p.loop + lap && this.target >= p.loop + lap) {
      this.head -= lap;
      this.target -= lap;
    }
  }

  private hover(x: number, y: number) {
    this.toGarden(x, y);
    const near =
      Math.hypot(this.rx - this.px, this.ry - this.py) < GRAB_UNITS ||
      dist(this.path, nearest(this.path, this.px, this.py), this.px, this.py) < REACH_UNITS;
    this.point(near ? "grab" : "");
  }

  up(id: number) {
    if (id !== this.pointer) return;
    this.pointer = -1;
    this.dragging = false;
    this.point("grab");
    this.report();
    this.wake();
  }

  // arrow keys step the rake along the path
  key(name: string) {
    const d = KEYS[name];
    if (!d || this.pause > 0) return;
    this.walking = 0;
    this.gliding = false;
    this.lift = 0;
    const p = this.path;
    this.target = Math.max(this.target + d, 0);
    if (this.target > p.length && this.head < p.loop) this.target = p.length;
    this.keyed = 0.4;
    this.wake();
  }

  private keyed = 0; // seconds the keyboard keeps carving after a press

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
    const busy = this.step(dt);
    if (this.dirty) this.draw();
    if (busy) this.wake();
    else this.last = 0;
  };

  // advances the rake and the settling grooves; true while anything still moves
  private step(dt: number) {
    const p = this.path;
    let busy = false;
    const prev = this.head;

    if (this.gliding) {
      this.glideT = Math.min(1, this.glideT + dt / GLIDE_S);
      const e = ease(this.glideT);
      const i = at(p, this.glideTo);
      const to = this.heading(this.glideTo) + (this.outward ? Math.PI : 0);
      this.rx = this.glideFrom[0] + (p.x[i] - this.glideFrom[0]) * e;
      this.ry = this.glideFrom[1] + (p.y[i] - this.glideFrom[1]) * e;
      this.angle = this.glideFrom[2] + wrap(to - this.glideFrom[2]) * e;
      this.lift = Math.sin(Math.PI * this.glideT) * LIFT_UNITS;
      this.dirty = true;
      if (this.glideT >= 1) {
        this.gliding = false;
        this.lift = 0;
        this.head = this.target = this.glideTo;
        if (this.dragging) this.follow();
      }
      return true;
    }

    // WALK
    if (this.walking) {
      const end = this.walking > 0 ? p.loop : REST_S;
      const left = Math.abs(end - this.target);
      const bend = p.bend[at(p, this.target)];
      const want = (WALK_UPS * Math.min(1, left / 1.5 + 0.04)) / (1 + BEND_SLOW * 0.6 * bend);
      this.speed += (want - this.speed) * (1 - Math.exp(-dt / 0.35));
      this.target += this.walking * Math.min(left, this.speed * dt);
      if (left < 1e-3 && Math.abs(this.head - end) < 0.01) {
        this.walking = 0;
        this.speed = 0;
        this.report();
      }
      busy = true;
    }

    // FOLLOW
    // eased toward the target, held back through tight bends
    const cap = (MAX_UPS / (1 + BEND_SLOW * p.bend[at(p, this.head)])) * dt;
    const k = 1 - Math.exp(-dt / FOLLOW_TAU_S);
    this.head += Math.max(-cap, Math.min(cap, (this.target - this.head) * k));
    if (Math.abs(this.target - this.head) < 1e-4) this.head = this.target;
    if (this.head !== prev || this.head !== this.target) busy = true;

    // CENTRE
    // a pause at the very middle while the rake turns round; then the way out
    if (
      this.walking > 0 &&
      !this.outward &&
      this.head >= p.loop - ARRIVE_UNITS &&
      this.pause <= 0
    ) {
      this.pause = this.reducedMotion ? 0.01 : CENTRE_S;
      this.target = p.loop;
      this.outward = true;
      this.resume = this.walking > 0;
      this.walking = 0;
      this.speed = 0;
      this.report();
    }
    if (this.pause > 0) {
      this.pause -= dt;
      this.target = p.loop;
      const t = 1 - Math.max(0, this.pause) / CENTRE_S;
      this.lift = Math.sin(Math.PI * Math.min(1, t * 1.6)) * 0.12;
      busy = true;
      if (this.pause <= 0) {
        this.pause = 0;
        this.lift = 0;
        if (this.resume) this.walking = -1;
        this.resume = false;
        if (this.dragging) this.follow();
        this.report();
      }
    }
    // back at the gate the walk is complete
    if (this.outward && this.head <= REST_S + 0.1 && !this.walking) {
      this.outward = false;
      this.back = true;
      this.report();
    }
    if (this.back && this.head > 2) this.back = false;

    // HEADING
    // looks ahead and behind along the path, then a critically damped spring turns the rake
    const want = this.heading(this.head) + (this.outward ? Math.PI : 0);
    const err = wrap(want - this.angle);
    const w = TURN_HZ * Math.PI * 2;
    this.spin += (w * w * err - 2 * w * this.spin) * dt;
    this.angle = wrap(this.angle + this.spin * dt);
    if (Math.abs(err) > 1e-3 || Math.abs(this.spin) > 1e-3) busy = true;
    if (busy) {
      this.place();
      this.dirty = true;
    }

    // CARVE
    if (this.keyed > 0) this.keyed -= dt;
    const carving = this.dragging || this.walking !== 0 || this.keyed > 0;
    if (carving && this.head !== prev) {
      this.raked += Math.abs(this.head - prev) * METRES_PER_UNIT;
      const lo = Math.min(prev, this.head);
      const hi = Math.max(prev, this.head);
      if (hi - lo >= p.loopLen) this.freshen(p.loop, p.length);
      else {
        const wa = wrapS(p, lo);
        const wb = wrapS(p, hi);
        if (wb >= wa) this.freshen(wa, wb);
        else {
          this.freshen(wa, p.length);
          this.freshen(p.loop, wb);
        }
      }
      this.report();
    }

    // SETTLE
    let changed = false;
    const done = HOLD_S + SETTLE_S;
    for (let i = 0; i < FRESH_N; i++) {
      const age = this.ages[i];
      if (age >= done) {
        if (this.amp[i] !== 0) {
          this.amp[i] = 0;
          changed = true;
        }
        continue;
      }
      this.ages[i] = age + dt;
      busy = true;
      const t = Math.max(0, (age - HOLD_S) / SETTLE_S);
      const a = Math.round((1 - t * t * (3 - 2 * t)) * 255);
      if (a !== this.amp[i]) {
        this.amp[i] = a;
        changed = true;
      }
    }
    if (changed) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.fresh);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FRESH_N, 1, gl.RED, gl.UNSIGNED_BYTE, this.amp);
      this.dirty = true;
    }
    return busy;
  }

  // direction of the path around s, from a point behind to a point ahead
  private freshen(s0: number, s1: number) {
    const L = this.path.length;
    const a = Math.round((s0 / L) * (FRESH_N - 1));
    const b = Math.round((s1 / L) * (FRESH_N - 1));
    for (let i = a; i <= b; i++) this.ages[i] = 0;
  }

  private heading(s: number) {
    const o = this.scratch;
    this.pointAt(s - LOOK_UNITS, o, 0);
    this.pointAt(s + LOOK_UNITS, o, 2);
    return Math.atan2(o[3] - o[1], o[2] - o[0]);
  }

  private pointAt(s: number, out: Float32Array, k: number) {
    const p = this.path;
    s = wrapS(p, s);
    const i = at(p, s);
    const j = Math.min(p.n - 1, i + 1);
    const span = p.s[j] - p.s[i] || 1;
    const t = Math.min(1, Math.max(0, (s - p.s[i]) / span));
    out[k] = p.x[i] + (p.x[j] - p.x[i]) * t;
    out[k + 1] = p.y[i] + (p.y[j] - p.y[i]) * t;
  }

  // rake position from its arc length, between samples
  private place() {
    this.pointAt(this.head, this.scratch, 0);
    this.rx = this.scratch[0];
    this.ry = this.scratch[1];
  }

  private report() {
    const p = this.path;
    const c = p.circuit[at(p, this.head)];
    const phase: Phase =
      this.pause > 0 || (this.outward && c === 8 && this.head > p.length - 0.5 && !this.walking)
        ? "centre"
        : this.walking
          ? "walking"
          : this.dragging
            ? "raking"
            : this.back
              ? "back"
              : "rest";
    const raked = Math.round(this.raked * 10);
    const key = c * 1e7 + raked * 100 + PHASE_ID[phase] * 2 + (this.outward ? 1 : 0);
    if (key === this.reported) return;
    this.reported = key;
    this.onState(c, raked / 10, phase, this.outward);
  }

  // RESIZE
  private resize() {
    const w = Math.round(this.cssW * this.dpr);
    const h = Math.round(this.cssH * this.dpr);
    this.sized = true;
    if (w === this.canvas.width && h === this.canvas.height && this.mapTex) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.layout();
    this.targets(w, h);
    this.drawMap(h);
    this.dirty = true;
  }

  // LAYOUT
  // the labyrinth sits right of the title on wide screens, under it on tall ones
  private layout() {
    const w = this.cssW;
    const h = this.cssH;
    const wide = w > h * 1.05;
    const r = wide ? Math.min(h * 0.36, w * 0.28) : Math.min(w * 0.45, h * 0.3);
    this.unit = r / (R_OUT + 0.4);
    this.cx = wide ? w * 0.58 : w * 0.5;
    this.cy = wide ? h * 0.46 : h * 0.54;
    const set = wide ? STONES_WIDE : STONES_TALL;
    // GATE STONES
    // a pair either side of the entrance, set in lanes from its outer end
    const [gx, gy, ix, iy] = this.path.gate;
    const el = Math.hypot(gx - ix, gy - iy);
    const ex = (gx - ix) / el;
    const ey = (gy - iy) / el;
    for (let i = 0; i < STONES; i++) {
      const gate = i >= set.length;
      const [fx, fy, sr, stretch, angle, height] = gate ? GATE[i - set.length] : set[i];
      // gate stones: fx along the entrance, fy across it
      this.stoneData[i * 4] = gate ? gx + ex * fx - ey * fy : (fx * w - this.cx) / this.unit;
      this.stoneData[i * 4 + 1] = gate ? gy + ey * fx + ex * fy : -(fy * h - this.cy) / this.unit;
      this.stoneData[i * 4 + 2] = sr;
      this.stoneData[i * 4 + 3] = i * 1.7 + 0.3;
      this.shapeData[i * 4] = stretch;
      this.shapeData[i * 4 + 1] = Math.cos(angle);
      this.shapeData[i * 4 + 2] = Math.sin(angle);
      this.shapeData[i * 4 + 3] = height;
    }
  }

  // TARGETS
  // relief at full resolution; lane map and materials at half, about 28 MB at 2880x1800
  private targets(w: number, h: number) {
    const gl = this.gl;
    this.release();
    const hw = Math.ceil(w / 2);
    const hh = Math.ceil(h / 2);
    this.half = [hw, hh];

    this.mapTex = texture(gl, gl.RGBA16UI, hw, hh, 1, gl.NEAREST);
    this.depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, hw, hh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mapFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.mapTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);

    this.heightTex = texture(gl, gl.R16F, w, h, 1, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.heightFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.heightTex, 0);

    const levels = Math.min(6, Math.floor(Math.log2(Math.max(hw, hh))) + 1);
    this.auxTex = texture(gl, gl.RGBA8, hw, hh, levels, gl.LINEAR_MIPMAP_LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.auxFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.auxTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private release() {
    const gl = this.gl;
    gl.deleteTexture(this.mapTex);
    gl.deleteTexture(this.heightTex);
    gl.deleteTexture(this.auxTex);
    gl.deleteRenderbuffer(this.depth);
    this.mapTex = this.heightTex = this.auxTex = null;
    this.depth = null;
  }

  private drawMap(h: number) {
    const gl = this.gl;
    const d = this.dpr * 0.5;
    const [hw, hh] = this.half;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mapFbo);
    gl.viewport(0, 0, hw, hh);
    gl.clearBufferuiv(gl.COLOR, 0, ZERO_U4);
    gl.clearBufferfv(gl.DEPTH, 0, ONE_F1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.useProgram(this.mapProg);
    gl.uniform2f(this.um.uRes, hw, hh);
    gl.uniform2f(this.um.uCentre, this.cx * d, h * 0.5 - this.cy * d);
    gl.uniform1f(this.um.uUnit, this.unit * d);
    gl.uniform1f(this.um.uLen, this.path.length);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    // depth only sorts the lanes once; free it until the next resize
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null);
    gl.deleteRenderbuffer(this.depth);
    this.depth = null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // DRAW
  private draw() {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const d = this.dpr;
    const unit = this.unit * d;
    const ca = Math.cos(this.angle);
    const sa = Math.sin(this.angle);
    this.dirty = false;

    gl.bindVertexArray(this.empty);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.mapTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fresh);

    // HEIGHT
    // the same field twice: full resolution relief, then half resolution materials
    for (let pass = 0; pass < 2; pass++) {
      const aux = pass === 1;
      const k = aux ? 0.5 : 1;
      const u = aux ? this.ua : this.uh;
      gl.bindFramebuffer(gl.FRAMEBUFFER, aux ? this.auxFbo : this.heightFbo);
      gl.viewport(0, 0, aux ? this.half[0] : w, aux ? this.half[1] : h);
      gl.useProgram(aux ? this.auxProg : this.heightProg);
      gl.uniform1i(u.uMap, 0);
      gl.uniform1i(u.uFresh, 1);
      gl.uniform2f(u.uCentre, this.cx * d * k, (h - this.cy * d) * k);
      gl.uniform1f(u.uUnit, unit * k);
      gl.uniform1f(u.uMapScale, aux ? 1 : 0.5);
      gl.uniform1f(u.uLen, this.path.length);
      gl.uniform1f(u.uSpiral, this.path.s[this.path.spiral]);
      const g = this.path.gate;
      gl.uniform4f(u.uGate, g[0], g[1], g[2], g[3]);
      gl.uniform4fv(u.uStone, this.stoneData);
      gl.uniform4fv(u.uShape, this.shapeData);
      gl.uniform4f(u.uRake, this.rx, this.ry, ca, sa);
      gl.uniform1f(u.uLift, this.lift);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.auxTex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // SHADE
    const us = this.us;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.shadeProg);
    gl.uniform1i(us.uHeight, 2);
    gl.uniform1i(us.uAux, 3);
    gl.uniform2f(us.uRes, w, h);
    gl.uniform1f(us.uUnit, unit);
    gl.uniform1f(us.uAoLod, Math.max(0, Math.log2(AO_UNITS * unit) - 1));
    gl.uniform2f(us.uCentre, this.cx * d, h - this.cy * d);
    gl.uniform4f(us.uRake, this.rx, this.ry, ca, sa);
    gl.uniform1f(us.uLift, this.lift);
    const ce = Math.cos(SUN_EL_RAD);
    gl.uniform3f(
      us.uSun,
      Math.cos(SUN_AZ_RAD) * ce,
      Math.sin(SUN_AZ_RAD) * ce,
      Math.sin(SUN_EL_RAD),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    if (!this.shown) {
      this.shown = true;
      this.onShown();
      this.report();
    }
  }

  dispose() {
    unraf(this.raf);
    this.raf = 0;
    const gl = this.gl;
    gl.deleteProgram(this.mapProg);
    gl.deleteProgram(this.heightProg);
    gl.deleteProgram(this.auxProg);
    gl.deleteProgram(this.shadeProg);
    this.buffers.forEach((b) => gl.deleteBuffer(b));
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.empty);
    gl.deleteTexture(this.fresh);
    this.release();
    gl.deleteFramebuffer(this.mapFbo);
    gl.deleteFramebuffer(this.heightFbo);
    gl.deleteFramebuffer(this.auxFbo);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

const ZERO_U4 = new Uint32Array(4);
const ONE_F1 = new Float32Array([1]);

const KEYS: Record<string, number> = {
  ArrowRight: KEY_UNITS,
  ArrowUp: KEY_UNITS,
  ArrowLeft: -KEY_UNITS,
  ArrowDown: -KEY_UNITS,
};
// workers without rAF fall back to a timer
const raf = (fn: (now: number) => void) =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(fn)
    : (setTimeout(() => fn(performance.now()), 16) as unknown as number);
const unraf = (id: number) =>
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id);

const PHASE_ID: Record<Phase, number> = { rest: 0, raking: 1, walking: 2, centre: 3, back: 4 };

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function texture(
  gl: WebGL2RenderingContext,
  format: number,
  w: number,
  h: number,
  levels: number,
  min: number,
) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, levels, format, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MAG_FILTER,
    min === gl.NEAREST ? gl.NEAREST : gl.LINEAR,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

// uniform locations by name, looked up once at link time
function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram, names: readonly string[]) {
  const out: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) out[n] = gl.getUniformLocation(p, n);
  return out;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const p = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const s = gl.createShader(type);
    if (!s) throw new Error("shader");
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (import.meta.env.DEV && !gl.getShaderParameter(s, gl.COMPILE_STATUS))
      console.error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
    gl.deleteShader(s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

function software(gl: WebGL2RenderingContext) {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}
