import { SCENE } from "./scene";

// FRAMING
// where the camera puts the horizon and the vanishing point. the dark tarmac runs between the
// title and the numbers instead of under them

// telegraph line, metres right of the centre line on a 16:10 screen
export const POLE_X_M = 13.6;
// the eye sits a little right of the centre line, in our lane, looking straight down the road
export const EYE_X_M = 0.6;
export const KEEP_MAX = 8;
const ROAD_EDGE_M = SCENE.ROAD_HALF + 0.05; // half width of the dark road the text keeps clear of
const TEXT_GAP = 0.012; // clearance either side, share of the width
const HOR_MIN = 0.18;
const HOR_MAX = 0.42;
const VP_MIN = 0.47;
const VP_MAX = 0.53;

// SKY
// where the sun stands and how high the clouds ride, in sky units, fixed per kind of screen
// as the reference framings the still plates were rendered for, so the live sky and its plate
// always agree. the tall ones are phones and portrait tablets
export const TALL_BELOW = 0.8;
const SKY_WIDE = { top: 0.404765, sunX: 0.12784, sunY: 0.242859 };
const SKY_TALL = { top: 0.731584, sunX: 0.0870746, sunY: 0.43895 };
export function skyFor(aspect: number) {
  return aspect < TALL_BELOW ? SKY_TALL : SKY_WIDE;
}

// the long lens; narrow screens see a wider field so the road still fits
export function zoomFor(aspect: number) {
  return SCENE.LENS * Math.max(1, Math.pow(1.25 / aspect, 0.8));
}

// the road's edges at height y run along vp - kl (hor - y) and vp + kr (hor - y), so each box
// bounds vp, tighter as the horizon rises. the view looks straight down the road, so vp stays
// near the middle: take the highest horizon that clears the text with vp in VP_MIN..VP_MAX.
// keep holds side (0 left, 1 right), inner edge x and bottom y per box, in shares, y up.
// writes horizon and vanishing point into out
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

// the text in the bottom corners of a w by h view, as fit() takes it
export function textBoxes(els: Element[], w: number, h: number, out: number[]) {
  out.length = 0;
  const range = document.createRange();
  for (const el of els) {
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    // where it rests, not where an entrance animation has it now
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
