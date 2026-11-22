import { fit, KEEP_MAX, TALL_BELOW, textBoxes, zoomFor } from "./frame";

// PLATE
// the first paint is a frame of the scene itself, rendered from the shader at its first moment
// (traffic not yet in) over a margin wider and taller than the view. it is laid under the
// canvas through the live camera: scaled so a metre is as big, and slid so its horizon and
// vanishing point sit where the live ones will, so the scene fades in over its own picture

type Plate = { aspect: number; zoom: number; hor: number; vp: number };

// how each plate was rendered: its aspect, zoom, and where its horizon and vanishing point
// fall. re-render the plates whenever the scene's look or framing changes
const WIDE: Plate = { aspect: 1.907692, zoom: 0.491111, hor: 0.28571, vp: 0.517419 };
const TALL: Plate = { aspect: 0.64433, zoom: 1.039536, hor: 0.383986, vp: 0.5 };

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
  // a metre on the plate as big as a metre in the live view
  const ph = (plate.zoom / zoom) * h;
  const pw = ph * plate.aspect;
  img.style.width = `${pw.toFixed(1)}px`;
  img.style.height = `${ph.toFixed(1)}px`;
  img.style.left = `${(vp * w - plate.vp * pw).toFixed(1)}px`;
  img.style.top = `${((1 - hor) * h - (1 - plate.hor) * ph).toFixed(1)}px`;
  img.setAttribute("data-cv-placed", "");
}
