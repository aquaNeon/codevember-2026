import {
  BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  LatheGeometry,
  Mesh,
  Path,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  type Material,
} from "three";

// TRAIN
// gears mesh pinions on one countershaft; fixed tooth sum, shared centre distance
const TOTAL_TEETH = 40;
const CENTER_M = 0.55;
const MODULE_M = (2 * CENTER_M) / TOTAL_TEETH;
const SHAFT_RAD = -0.55;
const GEAR_T = 0.03;
const GEAR_Y0 = 0.63;
const GEAR_STEP = 0.072;
const DRUM_R = 0.995;
const DRUM_Y = 0.895;
const HUB_Y0 = 1.12;
const HUB_STEP = 0.07;
const LIFT = 0.48;
const PY = 1.78;
export const PLANET_Y = LIFT + PY;
export const BAND_IN = 1.0;
export const BAND_OUT = 1.36;

export type Kind =
  "drum" | "brass" | "rod" | "arm" | "gear" | "plate" | "globe" | "sun" | "ground" | "band" | "ray";

interface Spec {
  name: string;
  teeth: number;
  orbit: number;
  radius: number;
  base: number;
  moons?: number[];
  ring?: boolean;
}

export const PLANETS: Spec[] = [
  { name: "Mercury", teeth: 11, orbit: 0.5, radius: 0.04, base: 0.5 },
  { name: "Venus", teeth: 17, orbit: 0.78, radius: 0.064, base: 2.3 },
  { name: "Earth", teeth: 22, orbit: 1.08, radius: 0.07, base: -1.0, moons: [0.14] },
  { name: "Mars", teeth: 25, orbit: 1.38, radius: 0.05, base: 3.7 },
  { name: "Jupiter", teeth: 28, orbit: 1.82, radius: 0.135, base: 1.2, moons: [0.2, 0.25] },
  { name: "Saturn", teeth: 31, orbit: 2.3, radius: 0.105, base: -2.35, ring: true },
];

const EARTH = PLANETS[2];
const pinion = (s: Spec) => TOTAL_TEETH - s.teeth;
// RATIOS
// turns per turn of the earth's sleeve; countershaft runs opposite
export const RATIO = PLANETS.map((s) => pinion(s) / s.teeth / (pinion(EARTH) / EARTH.teeth));
export const SHAFT_RATIO = -EARTH.teeth / pinion(EARTH);
const MOON_RATE = [5, 3.2, 2.1];
const SPIN_RATE = 2.5;

export interface Rig {
  root: Group;
  sleeves: Group[];
  shaft: Group;
  globes: Mesh[];
  moons: Group[];
  moonRate: number[];
  moonOf: number[];
  rays: Mesh;
  geos: BufferGeometry[];
}

export function build(mat: (k: Kind) => Material): Rig {
  const geos: BufferGeometry[] = [];
  const keep = <T extends BufferGeometry>(g: T) => (geos.push(g), g);
  const root = new Group();
  const add = (parent: Group, g: BufferGeometry, k: Kind, x = 0, y = 0, z = 0) => {
    const m = new Mesh(keep(g), mat(k));
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  // STAND
  add(root, new CircleGeometry(4.6, 96).rotateX(-Math.PI / 2), "ground");
  const foot: [number, number][] = [
    [0, 0],
    [0.62, 0],
    [0.62, 0.035],
    [0.57, 0.06],
    [0.56, 0.09],
    [0.42, 0.12],
    [0.3, 0.17],
    [0.21, 0.24],
    [0.15, 0.33],
    [0.13, 0.42],
    [0.17, 0.47],
    [0.2, 0.5],
    [0.16, 0.54],
    [0.1, 0.6],
    [0.085, 0.7],
    [0.1, 0.78],
    [0.16, 0.83],
    [0.26, 0.88],
    [0.36, 0.93],
    [0.43, 0.97],
    [0.46, LIFT + 0.53],
    [0, LIFT + 0.53],
  ];
  add(root, lathe(foot, 72), "brass");
  const top = new Group();
  top.position.y = LIFT;
  root.add(top);

  // MOVEMENT
  // two plates on pillars, gear cone between; the upper plate is the degree ring
  add(top, new CylinderGeometry(1.08, 1.08, 0.045, 96), "plate", 0, 0.555);
  add(top, new TorusGeometry(1.08, 0.022, 10, 96).rotateX(Math.PI / 2), "brass", 0, 0.555);
  const drumH = DRUM_Y - 0.578;
  add(top, new CylinderGeometry(DRUM_R, DRUM_R, drumH, 96, 1, true), "drum", 0, 0.578 + drumH / 2);
  add(top, new CylinderGeometry(DRUM_R + 0.012, DRUM_R + 0.012, 0.016, 96), "brass", 0, DRUM_Y);
  add(top, new TorusGeometry(DRUM_R, 0.012, 8, 96).rotateX(Math.PI / 2), "brass", 0, 0.6);
  const pillar: [number, number][] = [
    [0, 0],
    [0.04, 0],
    [0.04, 0.03],
    [0.022, 0.05],
    [0.018, 0.2],
    [0.03, 0.22],
    [0.018, 0.24],
    [0.022, 0.4],
    [0.04, 0.42],
    [0.04, 0.45],
    [0, 0.45],
  ];
  for (const a of [1.15, 2.4, 3.9, 5.2]) {
    const p = add(top, lathe(pillar, 16), "brass");
    p.position.set(1.045 * Math.cos(SHAFT_RAD + a), 0.578, -1.045 * Math.sin(SHAFT_RAD + a));
  }
  const ring = new Shape().absarc(0, 0, BAND_OUT, 0, Math.PI * 2, false);
  ring.holes.push(new Path().absarc(0, 0, BAND_IN, 0, Math.PI * 2, true));
  add(top, extrude(ring, 0.035, 128), "band", 0, 1.028);
  add(top, new TorusGeometry(BAND_OUT, 0.02, 10, 128).rotateX(Math.PI / 2), "brass", 0, 1.045);

  // COUNTERSHAFT
  const shaft = new Group();
  shaft.position.set(CENTER_M * Math.cos(SHAFT_RAD), 0, -CENTER_M * Math.sin(SHAFT_RAD));
  top.add(shaft);
  add(shaft, new CylinderGeometry(0.016, 0.016, 0.5, 12), "rod", 0, 0.82);
  PLANETS.forEach((s, i) => {
    const n = pinion(s);
    const g = add(shaft, extrude(gear(n, 0.016), GEAR_T, 6), "gear", 0, GEAR_Y0 + i * GEAR_STEP);
    g.rotation.y = Math.PI - Math.PI / n;
  });
  shaft.rotation.y = SHAFT_RAD;

  // SLEEVES
  const sleeves: Group[] = [];
  const globes: Mesh[] = [];
  const moons: Group[] = [];
  const moonRate: number[] = [];
  const moonOf: number[] = [];
  PLANETS.forEach((s, i) => {
    const sleeve = new Group();
    sleeve.rotation.y = s.base;
    top.add(sleeve);
    sleeves.push(sleeve);
    const tubeR = 0.024 + 0.014 * i;
    const gy = GEAR_Y0 + i * GEAR_STEP;
    const hy = HUB_Y0 + HUB_STEP * (PLANETS.length - 1 - i);
    const g = add(sleeve, extrude(gear(s.teeth, tubeR), GEAR_T, 24), "gear", 0, gy);
    g.rotation.y = SHAFT_RAD - s.base;
    add(sleeve, new CylinderGeometry(tubeR, tubeR, hy - gy, 24, 1, true), "rod", 0, (gy + hy) / 2);
    add(sleeve, new CylinderGeometry(tubeR + 0.02, tubeR + 0.02, 0.04, 24), "brass", 0, hy);
    const armR = 0.012 + 0.002 * i;
    add(sleeve, rod(s.orbit - tubeR, armR), "arm", tubeR, hy);
    add(sleeve, new SphereGeometry(armR * 1.9, 12, 8), "brass", s.orbit, hy);
    const postH = PY - hy - s.radius * 0.6;
    add(sleeve, new CylinderGeometry(0.009, 0.012, postH, 10), "rod", s.orbit, hy + postH / 2);
    const globe = add(sleeve, new SphereGeometry(s.radius, 40, 28), "globe", s.orbit, PY);
    globes.push(globe);
    if (s.ring) {
      const band = new Shape().absarc(0, 0, s.radius * 2.15, 0, Math.PI * 2, false);
      band.holes.push(new Path().absarc(0, 0, s.radius * 1.42, 0, Math.PI * 2, true));
      const r = add(sleeve, extrude(band, 0.006, 64).translate(0, -0.003, 0), "band", s.orbit, PY);
      r.rotation.set(0.42, 0, 0.18);
    }
    s.moons?.forEach((orbit, k) => {
      const m = new Group();
      m.position.set(s.orbit, 0, 0);
      sleeve.add(m);
      const y = PY - s.radius - 0.05 - k * 0.03;
      add(m, new CylinderGeometry(0.018, 0.018, 0.022, 16), "brass", 0, y);
      add(m, rod(orbit, 0.006), "arm", 0, y);
      add(m, new CylinderGeometry(0.006, 0.006, PY - y, 8), "rod", orbit, (PY + y) / 2);
      add(m, new SphereGeometry(0.022 - k * 0.004, 20, 14), "globe", orbit, PY);
      moons.push(m);
      moonRate.push(MOON_RATE[moons.length - 1] ?? 2);
      moonOf.push(i);
    });
  });

  // SUN
  const col = HUB_Y0 + HUB_STEP * PLANETS.length;
  add(top, new CylinderGeometry(0.014, 0.014, PY - col, 10), "rod", 0, (PY + col) / 2);
  add(top, new SphereGeometry(0.2, 56, 40), "sun", 0, PY);
  const rays = add(top, raysGeometry(32, 0.235, 0.36, 0.3), "ray", 0, PY);

  return { root, sleeves, shaft, globes, moons, moonRate, moonOf, rays, geos };
}

// POSE
// whole machine from theta: turns of the earth's sleeve, radians
export function pose(rig: Rig, theta: number) {
  for (let i = 0; i < rig.sleeves.length; i++) {
    const g = theta * RATIO[i];
    rig.sleeves[i].rotation.y = PLANETS[i].base + g;
    rig.globes[i].rotation.y = g * SPIN_RATE;
  }
  for (let k = 0; k < rig.moons.length; k++) {
    rig.moons[k].rotation.y = theta * RATIO[rig.moonOf[k]] * rig.moonRate[k];
  }
  rig.shaft.rotation.y = SHAFT_RAD + theta * SHAFT_RATIO;
}

// GEOMETRY
function lathe(pts: [number, number][], segments: number) {
  return new LatheGeometry(
    pts.map(([r, y]) => new Vector2(r, y)),
    segments,
  );
}

function extrude(shape: Shape, depth: number, curveSegments: number) {
  return new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments }).rotateX(
    -Math.PI / 2,
  );
}

function rod(length: number, radius: number) {
  return new CylinderGeometry(radius, radius, length, 10)
    .rotateZ(Math.PI / 2)
    .translate(length / 2, 0, 0);
}

// GEAR
// trapezoid teeth centred on 2πj/n, crossed spokes once there is room
function gear(teeth: number, bore: number) {
  const r = (MODULE_M * teeth) / 2;
  const tip = r + MODULE_M;
  const root = r - 1.25 * MODULE_M;
  const step = (Math.PI * 2) / teeth;
  const s = new Shape();
  const at = (rr: number, a: number, first = false) =>
    first
      ? s.moveTo(rr * Math.cos(a), rr * Math.sin(a))
      : s.lineTo(rr * Math.cos(a), rr * Math.sin(a));
  for (let j = 0; j < teeth; j++) {
    const c = j * step;
    at(root, c - step * 0.32, j === 0);
    at(tip, c - step * 0.15);
    at(tip, c + step * 0.15);
    at(root, c + step * 0.32);
    at(root, c + step * 0.5);
  }
  s.closePath();
  s.holes.push(new Path().absarc(0, 0, bore, 0, Math.PI * 2, true));
  const rin = bore + 0.04;
  const rout = root - 0.035;
  if (rout - rin > 0.05) {
    const n = r > 0.3 ? 6 : 4;
    const span = (Math.PI * 2) / n;
    const half = 0.024;
    for (let k = 0; k < n; k++) {
      const c = k * span + span / 2;
      const p = new Path();
      p.moveTo(rout * Math.cos(c + half / rout), rout * Math.sin(c + half / rout));
      p.absarc(0, 0, rout, c + half / rout, c + span - half / rout, false);
      p.lineTo(rin * Math.cos(c + span - half / rin), rin * Math.sin(c + span - half / rin));
      p.absarc(0, 0, rin, c + span - half / rin, c + half / rin, true);
      p.closePath();
      s.holes.push(p);
    }
  }
  return s;
}

// RAYS
// flat flames, billboarded each frame
function raysGeometry(n: number, r0: number, long: number, short: number) {
  const pos: number[] = [];
  const half = Math.PI / n / 1.6;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const r1 = k % 2 ? short : long;
    pos.push(
      r0 * Math.cos(a - half),
      r0 * Math.sin(a - half),
      0,
      r1 * Math.cos(a),
      r1 * Math.sin(a),
      0,
      r0 * Math.cos(a + half),
      r0 * Math.sin(a + half),
      0,
    );
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute(
    "normal",
    new Float32BufferAttribute(
      new Array(pos.length).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)),
      3,
    ),
  );
  return g;
}
