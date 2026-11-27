/// <reference lib="webworker" />
import type { FromWorker, ToWorker } from "./host";
import { Sky } from "./sky";

// WORKER

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (msg: FromWorker) => scope.postMessage(msg);
let sky: Sky | null = null;

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const d = e.data;
  if (d.t === "init") {
    try {
      sky = new Sky(d.canvas, d.opts);
    } catch {
      send({ t: "fail" });
      return;
    }
    sky.onHud = (h) => send({ t: "hud", h });
    sky.onShown = () => send({ t: "shown" });
    d.canvas.addEventListener("webglcontextlost", (ev) => {
      ev.preventDefault();
      sky?.dispose();
      sky = null;
      send({ t: "fail" });
    });
    return;
  }
  if (!sky) return;
  (sky[d.t] as (...a: unknown[]) => unknown).apply(sky, d.a);
};
