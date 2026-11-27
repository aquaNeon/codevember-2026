import { SCENE } from "./scene";

// FRAMING

export const POLE_X_M = 13.6;
export const EYE_X_M = 0.6;
export const KEEP_MAX = 8;
const ROAD_EDGE_M = SCENE.ROAD_HALF + 0.05;
const TEXT_GAP = 0.012; // change for more room beside the text
const HOR_MIN = 0.18;
const HOR_MAX = 0.42;
const VP_MIN = 0.47;
const VP_MAX = 0.53;

// SKY
// fixed per kind of screen so the live sky and the still plates agree
export const TALL_BELOW = 0.8;
const SKY_WIDE = { top: 0.404765, sunX: 0.12784, sunY: 0.2 };
const SKY_TALL = { top: 0.42, sunX: 0.05, sunY: 0.15 };
export function skyFor(aspect: number) {
  return aspect < TALL_BELOW ? SKY_TALL : SKY_WIDE;
}

export function zoomFor(aspect: number) {
  return SCENE.LENS * Math.max(1, Math.pow(1.25 / aspect, 0.25));
}

export function fit(aspect: number, keep: ArrayLike<number>, n: number, out: Float32Array) {
  const kl = (ROAD_EDGE_M + EYE_X_M) / (SCENE.CAM_H * aspect);
  const kr = (ROAD_EDGE_M - EYE_X_M) / (SCENE.CAM_H * aspect);
  let lo = -Infinity;
  let hi = Infinity;
  for (let i = 0; i < n; i++) {
    const x = keep[i * 3 + 1];
    const y = keep[i * 3 + 2];
    if (keep[i * 3] === 0) lo = Math.max(lo, x + TEXT_GAP - kl * y);
    else hi = Math.min(hi, x - TEXT_GAP + kr * y);
  }
  let hor = aspect < 0.8 ? 0.34 : HOR_MAX;
  if (isFinite(lo)) hor = Math.min(hor, (VP_MAX - lo) / kl);
  if (isFinite(hi)) hor = Math.min(hor, (hi - VP_MIN) / kr);
  if (isFinite(lo) && isFinite(hi)) hor = Math.min(hor, (hi - lo) / (kl + kr));
  if (n) hor = Math.max(HOR_MIN, hor);
  const l = lo + kl * hor;
  const h = hi - kr * hor;
  out[0] = hor;
  out[1] = Math.max(VP_MIN, Math.min(VP_MAX, Math.max(l, Math.min(h, 0.5))));
}

export function textBoxes(els: Element[], w: number, h: number, out: number[]) {
  out.length = 0;
  const range = document.createRange();
  for (const el of els) {
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    let lift = 0;
    for (let a: Element | null = el; a; a = a.parentElement) {
      const t = getComputedStyle(a).transform;
      if (t && t !== "none") lift += new DOMMatrixReadOnly(t).m42;
    }
    const bottom = r.bottom - lift;
    if (!r.width || bottom < h * 0.5) continue;
    const left = r.left + r.right < w;
    out.push(left ? 0 : 1, (left ? r.right : r.left) / w, 1 - bottom / h);
  }
  return out;
}
