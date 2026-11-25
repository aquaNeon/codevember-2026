/// <reference lib="webworker" />
import type { FromWorker, ToWorker } from "./host";
import { Mirage } from "./mirage";

// WORKER

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (msg: FromWorker) => scope.postMessage(msg);
let m: Mirage | null = null;
let dead = false;

let shownD = -1;
let shownA = -1;
const state = (travelled: number, ahead: number) => {
  const d = Math.round(travelled);
  const a = Math.round(ahead);
  if (d === shownD && a === shownA) return;
  shownD = d;
  shownA = a;
  send({ t: "state", d, a });
};

function start(d: Extract<ToWorker, { t: "init" }>) {
  try {
    m = new Mirage(d.canvas, { reducedMotion: d.reduced, forceGl: d.forceGl });
  } catch {
    dead = true;
    queue.length = 0;
    send({ t: "fail" });
    return;
  }
  m.onState = state;
  m.onReady = () => send({ t: "ready" });
  d.canvas.addEventListener("webglcontextlost", (ev) => {
    ev.preventDefault();
    m?.dispose();
    m = null;
    dead = true;
    send({ t: "fail" });
  });
  for (const msg of queue) handle(msg);
  queue.length = 0;
}

const queue: ToWorker[] = [];

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const d = e.data;
  if (d.t === "init") start(d);
  else if (!m) {
    if (!dead) queue.push(d);
  } else handle(d);
};

function handle(d: ToWorker) {
  if (!m) return;
  if (d.t === "size") m.size(d.w, d.h, d.dpr);
  else if (d.t === "avoid") m.avoid(d.b);
  else if (d.t === "show") m.show(d.v);
  else if (d.t === "motion") m.motion(d.v);
  else if (d.t === "point") m.point(d.x);
  else if (d.t === "down") m.down(d.y);
  else if (d.t === "drag") m.drag(d.y);
  else if (d.t === "up") m.up();
  else if (d.t === "leave") m.leave();
  else if (d.t === "wheel") m.wheel(d.px);
  else if (d.t === "keys") m.keys(d.dir);
}
