/// <reference lib="webworker" />
import { Gallery } from "./gallery";
import type { FromWorker, ToWorker } from "./host";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (msg: FromWorker) => scope.postMessage(msg);
let g: Gallery | null = null;

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const d = e.data;
  if (d.t === "init") {
    try {
      g = new Gallery(d.canvas, d.opts);
    } catch {
      send({ t: "fail" });
      return;
    }
    g.onCursor = (c) => send({ t: "cursor", c });
    g.onPerf = (ms) => send({ t: "perf", ms });
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
  else if (d.t === "motion") g.motion(d.v);
  else if (d.t === "down") g.down(d.x, d.y, d.id);
  else if (d.t === "move") g.move(d.x, d.y, d.id);
  else if (d.t === "up") g.up(d.id);
  else if (d.t === "set") g.set(d.m.shape, d.m.ior, d.m.tint, d.m.wave, d.m.flow, d.m.sun);
  else g.key();
};
