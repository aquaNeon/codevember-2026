// CRYSTAL
// quartz point; a half-step-turned ring splits the tip into slim facets

const SIDES = 6;
const R_M = 0.145; // change crystal size here
export const MAX_RIM = 8;
const EPS = 1e-6;

// PROFILE
// height, radius, turn per ring, top to tip, in belt radii
const PROFILE = [
  [0, 0.56, 0],
  [-0.2, 1, 0],
  [-0.55, 1, 0],
  [-1.7, 0.6, 0.5],
  [-3.6, 0, 0],
] as const;

export interface Crystal {
  faces: number;
  tris: number;
  pos: Float32Array;
  normal: Float32Array;
  edge: Float32Array;
  planes: Float32Array;
  centroid: Float32Array;
  corners: Float32Array;
  rimCount: Uint8Array;
  aperture: Float32Array;
  height: number;
  radius: number;
}

export function crystal(): Crystal {
  const ring: number[][][] = PROFILE.map(([y, r, turn]) => {
    const n = r === 0 ? 1 : SIDES;
    const pts: number[][] = [];
    for (let k = 0; k < n; k++) {
      const a = ((k + turn) / SIDES) * Math.PI * 2;
      pts.push([Math.cos(a) * r * R_M, y * R_M, Math.sin(a) * r * R_M]);
    }
    return pts;
  });

  const pts = ring.flat();
  // NEIGHBOURS
  // faces only join one ring (the table), or close angles at most two rings apart
  const where = ring.flatMap((r, i) =>
    r.map((_, k) => [i, r.length === 1 ? -1 : k + PROFILE[i][2]]),
  );
  const near = (a: number, b: number) => {
    const [ra, ka] = where[a];
    const [rb, kb] = where[b];
    if (ra === rb) return true;
    if (Math.abs(ra - rb) > 2) return false;
    if (ka < 0 || kb < 0) return true;
    const d = Math.abs(ka - kb) % SIDES;
    return Math.min(d, SIDES - d) <= 1;
  };
  const hull = faces(pts, near);
  const height = -PROFILE[PROFILE.length - 1][0] * R_M;

  const f = hull.length;
  let tris = 0;
  for (const h of hull) tris += h.ring.length;
  const pos = new Float32Array(tris * 9);
  const normal = new Float32Array(tris * 9);
  const edge = new Float32Array(tris * 3);
  const planes = new Float32Array(f * 4);
  const centroid = new Float32Array(f * 3);
  const rims: number[][] = [];
  const aperture = new Float32Array(f);

  // FANS
  // each face fans around its centre, so only the rim gets an edge line
  let v = 0;
  hull.forEach((h, i) => {
    const [nx, ny, nz, d] = h.plane;
    const c = h.centre;
    const n = h.ring.length;
    let area = 0;
    for (let k = 0; k < n; k++) {
      const a = pts[h.ring[k]];
      const b = pts[h.ring[(k + 1) % n]];
      for (const [p, e] of [
        [c, 1],
        [a, 0],
        [b, 0],
      ] as const) {
        pos.set(p, v * 3);
        normal.set(h.plane.slice(0, 3), v * 3);
        edge[v] = e;
        v++;
      }
      area += tri(c, a, b);
    }
    planes.set([nx, ny, nz, d], i * 4);
    centroid.set(c, i * 3);
    rims.push(h.ring.flatMap((k) => pts[k]));
    aperture[i] = Math.sqrt(area / Math.PI) * 0.8;
  });

  const corners = new Float32Array(f * MAX_RIM * 3);
  const rimCount = new Uint8Array(f);
  rims.forEach((r, i) => {
    rimCount[i] = r.length / 3;
    corners.set(r, i * MAX_RIM * 3);
  });

  return {
    faces: f,
    tris,
    pos,
    normal,
    edge,
    planes,
    centroid,
    corners,
    rimCount,
    aperture,
    height,
    radius: R_M,
  };
}

// HULL
// brute force: planes through three points with all points on one side; coplanar merge
interface Face {
  plane: number[];
  centre: number[];
  ring: number[];
}

function faces(pts: number[][], near: (a: number, b: number) => boolean): Face[] {
  const out: Face[] = [];
  const seen = new Set<string>();
  const n = pts.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (!near(i, j)) continue;
      for (let k = j + 1; k < n; k++) {
        if (!near(i, k) || !near(j, k)) continue;
        const [a, b, c] = [pts[i], pts[j], pts[k]];
        let nr = cross(sub(b, a), sub(c, a));
        const len = Math.hypot(nr[0], nr[1], nr[2]);
        if (len < EPS) continue;
        nr = nr.map((x) => x / len);
        let d = dot(nr, a);
        let pos = 0;
        let neg = 0;
        for (const p of pts) {
          const e = dot(nr, p) - d;
          if (e > EPS) pos++;
          else if (e < -EPS) neg++;
        }
        if (pos && neg) continue;
        if (pos) {
          nr = nr.map((x) => -x);
          d = -d;
        }
        const key = [...nr, d].map((x) => x.toFixed(4)).join();
        if (seen.has(key)) continue;
        seen.add(key);
        const on: number[] = [];
        pts.forEach((p, m) => Math.abs(dot(nr, p) - d) <= EPS && on.push(m));
        const centre = [0, 1, 2].map((q) => on.reduce((s, m) => s + pts[m][q], 0) / on.length);
        const u = sub(pts[on[0]], centre);
        const w = cross(nr, u);
        on.sort((p, q) => angle(sub(pts[p], centre), u, w) - angle(sub(pts[q], centre), u, w));
        out.push({ plane: [...nr, d], centre, ring: on });
      }
    }
  return out;
}

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const angle = (p: number[], u: number[], w: number[]) => Math.atan2(dot(p, w), dot(p, u));
const tri = (a: number[], b: number[], c: number[]) => {
  const x = cross(sub(b, a), sub(c, a));
  return Math.hypot(x[0], x[1], x[2]) / 2;
};
