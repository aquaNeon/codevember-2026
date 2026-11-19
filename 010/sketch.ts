import { aim, camera, project } from "./camera";
import { SCENE } from "./shaders";

const NS = "http://www.w3.org/2000/svg";
const NEAR_M = 0.1;
const FLOOR_FAR_M = 8; // how far the floor seams run toward the viewer

type P3 = readonly [number, number, number];

// FIRST PAINT
// the room drawn as lines through the renderer's own camera: the seams of the corner,
// the plinth's visible edges, the sphere. each stroke draws itself in; the live picture
// fades in over it once its first frame is ready
export function sketch(host: HTMLElement) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "sketch");
  svg.setAttribute("aria-hidden", "true");
  host.append(svg);
  const cam = camera();

  const draw = () => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    aim(cam, w / h);
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const lines: P3[][] = [];
    const X = SCENE.WALL_X_M;
    // the corner: floor meets back wall, the two walls meet, floor meets the window wall
    lines.push([
      [X, 0, 0],
      [8, 0, 0],
    ]);
    lines.push([
      [X, 0, 0],
      [X, SCENE.CEIL_M, 0],
    ]);
    lines.push([
      [X, 0, 0],
      [X, 0, FLOOR_FAR_M],
    ]);
    // the plinth: edges of the faces that look toward the eye
    const cx = SCENE.PLINTH_X_M;
    const cz = SCENE.PLINTH_Z_M;
    const s = SCENE.PLINTH_HALF_M;
    const t = SCENE.PLINTH_H_M;
    const faces: [P3, P3[]][] = [
      [
        [0, 1, 0],
        [
          [cx - s, t, cz - s],
          [cx + s, t, cz - s],
          [cx + s, t, cz + s],
          [cx - s, t, cz + s],
        ],
      ],
      [
        [0, 0, 1],
        [
          [cx - s, 0, cz + s],
          [cx + s, 0, cz + s],
          [cx + s, t, cz + s],
          [cx - s, t, cz + s],
        ],
      ],
      [
        [1, 0, 0],
        [
          [cx + s, 0, cz - s],
          [cx + s, 0, cz + s],
          [cx + s, t, cz + s],
          [cx + s, t, cz - s],
        ],
      ],
      [
        [-1, 0, 0],
        [
          [cx - s, 0, cz - s],
          [cx - s, 0, cz + s],
          [cx - s, t, cz + s],
          [cx - s, t, cz - s],
        ],
      ],
    ];
    for (const [n, q] of faces) {
      const c = q[0];
      const toEye =
        (cam.eye[0] - c[0]) * n[0] + (cam.eye[1] - c[1]) * n[1] + (cam.eye[2] - c[2]) * n[2];
      if (toEye > 0) lines.push([...q, q[0]]);
    }

    const ROOM = 3; // the first lines are the room, hidden behind the plinth and sphere
    let i = 0;
    const paths: Element[] = [];
    const room = document.createElementNS(NS, "g");
    room.setAttribute("mask", "url(#cv-hide)");
    for (const l of lines) {
      let d = "";
      for (const p of l) {
        const [x, y, z] = project(cam, p[0], p[1], p[2], w, h);
        if (z < NEAR_M) continue;
        d += `${d ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      if (!d) continue;
      const el = path(d, i++);
      if (i <= ROOM) room.append(el);
      else paths.push(el);
    }
    // the sphere: its outline, then a meridian and the equator, foreshortened
    const [sx, sy, sd] = project(cam, cx, t + SCENE.R_M, cz, w, h);
    const r = (SCENE.R_M / sd) * cam.focal * (h / 2);
    paths.push(ellipse(sx, sy, r, r, i++));
    paths.push(ellipse(sx, sy, r, r * 0.28, i++, "faint"));
    paths.push(ellipse(sx, sy, r * 0.42, r, i, "faint"));
    // MASK
    // the plinth's outline (hull of its corners) and the sphere's disc cut the room lines
    const pts: [number, number][] = [];
    for (const x of [cx - s, cx + s])
      for (const y of [0, t])
        for (const z of [cz - s, cz + s]) {
          const [px, py] = project(cam, x, y, z, w, h);
          pts.push([px, py]);
        }
    const mask = document.createElementNS(NS, "mask");
    mask.setAttribute("id", "cv-hide");
    mask.setAttribute("maskUnits", "userSpaceOnUse");
    mask.innerHTML =
      `<rect x="-10" y="-10" width="${w + 20}" height="${h + 20}" fill="#fff"/>` +
      `<polygon points="${hull(pts)
        .map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`)
        .join(" ")}" fill="#000"/>` +
      `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${r.toFixed(1)}" fill="#000"/>`;
    const defs = document.createElementNS(NS, "defs");
    defs.append(mask);
    svg.replaceChildren(defs, room, ...paths);
  };

  draw();
  const ro = new ResizeObserver(draw);
  ro.observe(host);
  return () => {
    ro.disconnect();
    svg.remove();
  };
}

function path(d: string, i: number) {
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d);
  p.setAttribute("pathLength", "1");
  p.setAttribute("style", `--i: ${i}`);
  return p;
}

function ellipse(x: number, y: number, rx: number, ry: number, i: number, cls = "") {
  const e = document.createElementNS(NS, "ellipse");
  e.setAttribute("cx", x.toFixed(1));
  e.setAttribute("cy", y.toFixed(1));
  e.setAttribute("rx", rx.toFixed(1));
  e.setAttribute("ry", ry.toFixed(1));
  e.setAttribute("pathLength", "1");
  e.setAttribute("style", `--i: ${i}`);
  if (cls) e.setAttribute("class", cls);
  return e;
}

// monotone chain
function hull(p: [number, number][]) {
  const q = [...p].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  for (const v of q) {
    while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], v) <= 0) lo.pop();
    lo.push(v);
  }
  const hi: [number, number][] = [];
  for (const v of q.reverse()) {
    while (hi.length > 1 && cross(hi[hi.length - 2], hi[hi.length - 1], v) <= 0) hi.pop();
    hi.push(v);
  }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}
