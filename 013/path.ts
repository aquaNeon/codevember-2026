// CLASSICAL LABYRINTH
// seven circuits walked 3-2-1-4-7-6-5, then a spiral into the centre; garden units, one lane = 1, y up
export const R_OUT = 9;
export const R_CENTRE = 2;
export const STEP = 0.04;
export const HALF_LANE = 0.5;
const MAX_RADIUS = 20;

const BOTTOM = -Math.PI / 2;
const TAU = Math.PI * 2;
// where each group of rings stops short of the bottom seam, in radians
const LEFT_A = BOTTOM - 0.42; // rings 1-3
const LEFT_B = BOTTOM - 0.68; // rings 4-7
const RIGHT_A = BOTTOM + 0.4; // rings 1-4
const RIGHT_B = BOTTOM + 0.7; // rings 5-7
const GATE_OUT = 2.3; // how far the entrance runs out past the turn
const GOAL_TURN = 0.8; // widest radius the last lane bends at
// CENTRE SPIRAL
// the last lane winds in to the middle; one wrap per pitch, raked like the rings it replaces
export const SPIRAL_PITCH = 0.7;
const LOOP_R = 0.12; // the closed circle at the very middle; under half a lane, so the centre fills
const SPIRAL_PULL = 2; // how hard the lane is steered onto the spiral
const BEND_REACH = 0.6; // lanes either side a turn is felt from

const ring = (k: number) => R_OUT + HALF_LANE - k;

export type Path = {
  n: number;
  length: number;
  x: Float32Array;
  y: Float32Array;
  tx: Float32Array;
  ty: Float32Array;
  s: Float32Array;
  circuit: Uint8Array; // 0 gate, 1-7 rings, 8 centre
  bend: Float32Array; // curvature, spread ahead and behind so the rake slows before a turn
  soft: Float32Array; // 0 in a walled lane, 1 on the centre spiral, which has no walls
  half: Float32Array; // half the lane width
  spiral: number; // first sample of the spiral
  loop: number; // arc length where the closing circle starts; past the end the rake goes round it again
  loopLen: number;
  gate: [number, number, number, number]; // entrance segment, outside end first
};

export function build(): Path {
  const xs: number[] = [];
  const ys: number[] = [];
  const ids: number[] = [];
  const push = (x: number, y: number, id: number) => {
    xs.push(x);
    ys.push(y);
    ids.push(id);
  };

  const arc = (k: number, a0: number, a1: number) => {
    const r = ring(k);
    const n = Math.max(1, Math.ceil((Math.abs(a1 - a0) * r) / STEP));
    for (let i = 1; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      push(r * Math.cos(a), r * Math.sin(a), k);
    }
  };

  // half-turn bulging into the seam; phi 0 is the outer ring, pi the inner one
  const turn = (
    a: number,
    side: number,
    rc: number,
    rho: number,
    f0: number,
    f1: number,
    id: number,
  ) => {
    const ex = Math.cos(a);
    const ey = Math.sin(a);
    const bx = -ey * side;
    const by = ex * side;
    const n = Math.max(1, Math.ceil((Math.abs(f1 - f0) * rho) / STEP));
    for (let i = 1; i <= n; i++) {
      const f = f0 + ((f1 - f0) * i) / n;
      const c = Math.cos(f) * rho;
      const s = Math.sin(f) * rho;
      push(rc * ex + c * ex + s * bx, rc * ey + c * ey + s * by, id);
    }
  };

  const line = (x0: number, y0: number, x1: number, y1: number, id: number) => {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / STEP));
    for (let i = 1; i <= n; i++) push(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, id);
  };

  // GATE
  const ex = Math.cos(LEFT_A);
  const ey = Math.sin(LEFT_A);
  const qx = 8 * ex - ey * 1.5;
  const qy = 8 * ey + ex * 1.5;
  const gate: Path["gate"] = [qx + ex * GATE_OUT, qy + ey * GATE_OUT, qx, qy];
  push(gate[0], gate[1], 0);
  line(gate[0], gate[1], qx, qy, 0);
  turn(LEFT_A, 1, 8, 1.5, Math.PI / 2, Math.PI, 3);

  // CIRCUITS
  arc(3, LEFT_A + TAU, RIGHT_A);
  turn(RIGHT_A, -1, 7, 0.5, Math.PI, 0, 2);
  arc(2, RIGHT_A, LEFT_A + TAU);
  turn(LEFT_A, 1, 8, 0.5, Math.PI, 0, 1);
  arc(1, LEFT_A + TAU, RIGHT_A);
  turn(RIGHT_A, -1, 7, 1.5, 0, Math.PI, 4);
  arc(4, RIGHT_A, LEFT_B + TAU);
  turn(LEFT_B, 1, 4, 1.5, 0, Math.PI, 7);
  arc(7, LEFT_B + TAU, RIGHT_B);
  turn(RIGHT_B, -1, 3, 0.5, Math.PI, 0, 6);
  arc(6, RIGHT_B, LEFT_B + TAU);
  turn(LEFT_B, 1, 4, 0.5, Math.PI, 0, 5);
  arc(5, LEFT_B + TAU, RIGHT_B);

  // GOAL
  // out of the last turn, then steered onto a spiral that winds clockwise in to the middle
  turn(RIGHT_B, -1, 3, 1.5, 0, Math.PI / 2, 8);
  let x = xs[xs.length - 1];
  let y = ys[ys.length - 1];
  let hd = Math.atan2(-Math.sin(RIGHT_B), -Math.cos(RIGHT_B));
  let th = Math.atan2(y, x);
  let wound = 0;
  let spiral = -1;
  const r0 = R_CENTRE - SPIRAL_PITCH / 2;
  for (let guard = 0; guard < 20000; guard++) {
    const r = Math.hypot(x, y);
    const t = Math.atan2(y, x);
    wound += Math.abs(Math.atan2(Math.sin(t - th), Math.cos(t - th)));
    th = t;
    const want = Math.max(LOOP_R, r0 - (SPIRAL_PITCH * wound) / TAU);
    // wound in as far as the circle: stop steering, the loop closes at the radius reached
    if (want <= LOOP_R) break;
    if (spiral < 0 && r < R_CENTRE) spiral = xs.length;
    // clockwise tangent plus a pull toward the spiral's radius at this angle
    const err = SPIRAL_PULL * (want - r);
    const aim = Math.atan2(-Math.cos(t) + err * Math.sin(t), Math.sin(t) + err * Math.cos(t));
    const d = Math.atan2(Math.sin(aim - hd), Math.cos(aim - hd));
    const turnMax = STEP / Math.max(0.2, Math.min(GOAL_TURN, r * 0.9));
    hd += Math.max(-turnMax, Math.min(turnMax, d));
    x += Math.cos(hd) * STEP;
    y += Math.sin(hd) * STEP;
    push(x, y, 8);
  }

  // LOOP
  // one exact clockwise turn round the middle, so the rake can circle it as long as it likes
  const loopAt = xs.length - 1;
  const a0 = Math.atan2(y, x);
  const lr = Math.hypot(x, y);
  const ln = Math.ceil((TAU * lr) / STEP);
  for (let i = 1; i <= ln; i++) {
    const a = a0 - (TAU * i) / ln;
    push(lr * Math.cos(a), lr * Math.sin(a), 8);
  }

  const n = xs.length;
  const p: Path = {
    n,
    length: 0,
    x: Float32Array.from(xs),
    y: Float32Array.from(ys),
    tx: new Float32Array(n),
    ty: new Float32Array(n),
    s: new Float32Array(n),
    circuit: Uint8Array.from(ids),
    bend: new Float32Array(n),
    soft: new Float32Array(n),
    half: new Float32Array(n),
    spiral,
    loop: 0,
    loopLen: 0,
    gate,
  };
  for (let i = 1; i < n; i++)
    p.s[i] = p.s[i - 1] + Math.hypot(p.x[i] - p.x[i - 1], p.y[i] - p.y[i - 1]);
  p.length = p.s[n - 1];
  p.loop = p.s[loopAt];
  p.loopLen = p.length - p.loop;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const dx = p.x[b] - p.x[a];
    const dy = p.y[b] - p.y[a];
    const l = Math.hypot(dx, dy) || 1;
    p.tx[i] = dx / l;
    p.ty[i] = dy / l;
  }
  // SOFT
  // lanes narrow to the spiral's pitch and lose their walls as they enter the centre
  const s0 = p.s[Math.max(0, spiral)];
  for (let i = 0; i < n; i++) {
    const t = spiral < 0 ? 0 : Math.min(1, Math.max(0, (p.s[i] - s0 + 0.3) / 1.2));
    p.soft[i] = t * t * (3 - 2 * t);
    p.half[i] = HALF_LANE + (SPIRAL_PITCH / 2 - HALF_LANE) * p.soft[i];
  }

  // BEND
  // raw curvature, then the largest value within BEND_REACH, then a box blur of the same width
  const raw = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) {
    const cross = p.tx[i - 1] * p.ty[i + 1] - p.ty[i - 1] * p.tx[i + 1];
    raw[i] = Math.abs(cross) / Math.max(p.s[i + 1] - p.s[i - 1], 1e-6);
  }
  const w = Math.round(BEND_REACH / STEP);
  const peak = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) m = Math.max(m, raw[k]);
    peak[i] = m;
  }
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let c = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) {
      sum += peak[k];
      c++;
    }
    p.bend[i] = sum / c;
  }
  // the loop bends no harder than the spiral's end, so the rake keeps its pace round it
  for (let i = loopAt; i < n; i++) p.bend[i] = p.bend[Math.max(0, loopAt - w)];
  return p;
}

// STRIP
// three vertices per sample (left edge, centre, right edge) as x, y, s, d, pivot distance, soft; depth |d| keeps the nearest lane
export function strip(p: Path) {
  const v = new Float32Array(p.n * 18);
  for (let i = 0; i < p.n; i++) {
    const hw = p.half[i];
    const nx = -p.ty[i] * hw;
    const ny = p.tx[i] * hw;
    // signed curvature, left turns positive; gives each vertex its distance to the turn's pivot
    const a = Math.max(0, i - 1);
    const b = Math.min(p.n - 1, i + 1);
    const k = (p.tx[a] * p.ty[b] - p.ty[a] * p.tx[b]) / Math.max(p.s[b] - p.s[a], 1e-6);
    const rc = Math.abs(k) > 1 / MAX_RADIUS ? 1 / Math.abs(k) : MAX_RADIUS;
    const side = Math.sign(k);
    const o = i * 18;
    const sf = p.soft[i];
    v.set([p.x[i] + nx, p.y[i] + ny, p.s[i], 1, rc - side * hw, sf], o);
    v.set([p.x[i], p.y[i], p.s[i], 0, rc, sf], o + 6);
    v.set([p.x[i] - nx, p.y[i] - ny, p.s[i], -1, rc + side * hw, sf], o + 12);
  }
  const idx = new Uint16Array((p.n - 1) * 12);
  for (let i = 0; i < p.n - 1; i++) {
    const a = i * 3;
    const b = a + 3;
    idx.set([a, a + 1, b, a + 1, b + 1, b, a + 1, a + 2, b + 1, a + 2, b + 2, b + 1], i * 12);
  }
  return { v, idx };
}

// nearest sample to (x, y) within [i0, i1]
export function nearest(p: Path, x: number, y: number, i0 = 0, i1 = p.n - 1) {
  let best = -1;
  let bd = Infinity;
  const a = Math.max(0, i0);
  const b = Math.min(p.n - 1, i1);
  for (let i = a; i <= b; i++) {
    const dx = p.x[i] - x;
    const dy = p.y[i] - y;
    const d = dx * dx + dy * dy;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

export function dist(p: Path, i: number, x: number, y: number) {
  return Math.hypot(p.x[i] - x, p.y[i] - y);
}

// arc length past the end goes round the closing circle again
export function wrapS(p: Path, s: number) {
  return s > p.length ? p.loop + ((s - p.loop) % p.loopLen) : Math.max(s, 0);
}

// sample index at arc length s
export function at(p: Path, s: number) {
  const t = wrapS(p, s);
  let lo = 0;
  let hi = p.n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p.s[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}
