/// <reference lib="webworker" />
import type { FromWorker } from "./host";
import { Kelp } from "./kelp";

type ToWorker =
  | { t: "init"; canvas: OffscreenCanvas; reduced: boolean; forceGl: boolean; dpr: number }
  | { t: "size"; w: number; h: number; dpr: number }
  | { t: "show"; v: boolean }
  | { t: "move"; x: number; y: number; fresh: boolean }
  | { t: "leave" }
  | { t: "push"; x: number; y: number }
  | { t: "motion"; v: boolean };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (msg: FromWorker) => scope.postMessage(msg);
let k: Kelp | null = null;

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const d = e.data;
  if (d.t === "init") {
    try {
      k = new Kelp(d.canvas, { reducedMotion: d.reduced, forceGl: d.forceGl, dpr: d.dpr });
    } catch {
      send({ t: "fail" });
      return;
    }
    k.onState = (v) => send({ t: "state", v });
    k.onShown = () => send({ t: "shown" });
    d.canvas.addEventListener("webglcontextlost", (ev) => {
      ev.preventDefault();
      k?.dispose();
      k = null;
      send({ t: "fail" });
    });
    return;
  }
  if (!k) return;
  if (d.t === "size") k.size(d.w, d.h, d.dpr);
  else if (d.t === "show") k.show(d.v);
  else if (d.t === "move") k.move(d.x, d.y, d.fresh);
  else if (d.t === "leave") k.leave();
  else if (d.t === "push") k.push(d.x, d.y);
  else k.motion(d.v);
};
