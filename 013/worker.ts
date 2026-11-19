/// <reference lib="webworker" />
import { Garden, type Phase } from "./garden";
import type { FromWorker } from "./host";

type ToWorker =
  | { t: "init"; canvas: OffscreenCanvas; reduced: boolean; forceGl: boolean }
  | { t: "size"; w: number; h: number; dpr: number }
  | { t: "show"; v: boolean }
  | { t: "down"; x: number; y: number; id: number }
  | { t: "move"; x: number; y: number; id: number; mouse: boolean }
  | { t: "up"; id: number }
  | { t: "key"; k: string }
  | { t: "walk" }
  | { t: "motion"; v: boolean };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (msg: FromWorker) => scope.postMessage(msg);
let g: Garden | null = null;

// STATE
// phase changes go out at once, the running numbers at most every STATE_MS
const STATE_MS = 125;
let circuit = 0;
let raked = 0;
let phase = "";
let out = false;
let sent = "";
let timer = 0;
const flush = () => {
  timer = 0;
  sent = phase + out;
  send({ t: "state", c: circuit, m: raked, phase: phase as Phase, out });
};
const state = (c: number, m: number, p: Phase, o: boolean) => {
  circuit = c;
  raked = m;
  phase = p;
  out = o;
  if (p + o !== sent) {
    clearTimeout(timer);
    flush();
  } else if (!timer) timer = setTimeout(flush, STATE_MS) as unknown as number;
};

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const d = e.data;
  if (d.t === "init") {
    try {
      g = new Garden(d.canvas, { reducedMotion: d.reduced, forceGl: d.forceGl });
    } catch {
      send({ t: "fail" });
      return;
    }
    g.onState = state;
    g.onCursor = (c) => send({ t: "cursor", c });
    g.onShown = () => send({ t: "shown" });
    d.canvas.addEventListener("webglcontextlost", (ev) => {
      ev.preventDefault();
      g?.dispose();
      g = null;
      send({ t: "fail" });
    });
    return;
  }
  if (!g) return;
  if (d.t === "size") g.size(d.w, d.h, d.dpr);
  else if (d.t === "show") g.show(d.v);
  else if (d.t === "down") g.down(d.x, d.y, d.id);
  else if (d.t === "move") g.move(d.x, d.y, d.id, d.mouse);
  else if (d.t === "up") g.up(d.id);
  else if (d.t === "key") g.key(d.k);
  else if (d.t === "walk") g.walk();
  else g.motion(d.v);
};
