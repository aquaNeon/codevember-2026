/// <reference lib="webworker" />
import type { FromWorker, ToWorker } from "./host";
import { Veil } from "./veil";

// WORKER
// cloth and gpu live here so neither blocks the page

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (msg: FromWorker) => scope.postMessage(msg);
let veil: Veil | null = null;

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const d = e.data;
  if (d.t === "init") {
    try {
      veil = new Veil(d.canvas, d.opts);
    } catch {
      send({ t: "fail" });
      return;
    }
    veil.onHud = (h) => send({ t: "hud", h });
    veil.onShown = () => send({ t: "shown" });
    d.canvas.addEventListener("webglcontextlost", (ev) => {
      ev.preventDefault();
      veil?.dispose();
      veil = null;
      send({ t: "fail" });
    });
    return;
  }
  if (!veil) return;
  (veil[d.t] as (...a: unknown[]) => unknown).apply(veil, d.a);
};
