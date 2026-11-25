import { fit, KEEP_MAX, TALL_BELOW, textBoxes, zoomFor } from "./frame";

// PLATE
// re-render the plates whenever the look or framing changes

type Plate = { aspect: number; zoom: number; hor: number; vp: number };

const WIDE: Plate = { aspect: 1.907692, zoom: 0.28888, hor: 0.28571, vp: 0.517419 };
const TALL: Plate = { aspect: 0.644238, zoom: 0.353705, hor: 0.383986, vp: 0.5 };

export function placePlate(img: HTMLElement, avoid: Element[]) {
  const w = Math.max(1, innerWidth);
  const h = Math.max(1, innerHeight);
  const aspect = w / h;
  const zoom = zoomFor(aspect);
  const boxes = textBoxes(avoid, w, h, []);
  const framed = new Float32Array(2);
  fit(aspect, boxes, Math.min(KEEP_MAX, boxes.length / 3), framed);
  const [hor, vp] = framed;
  const plate = aspect < TALL_BELOW ? TALL : WIDE;
  const ph = (plate.zoom / zoom) * h;
  const pw = ph * plate.aspect;
  img.style.width = `${pw.toFixed(1)}px`;
  img.style.height = `${ph.toFixed(1)}px`;
  img.style.left = `${(vp * w - plate.vp * pw).toFixed(1)}px`;
  img.style.top = `${((1 - hor) * h - (1 - plate.hor) * ph).toFixed(1)}px`;
  img.setAttribute("data-cv-placed", "");
}
