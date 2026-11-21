/// <reference lib="webworker" />
import { Haze } from "./haze";
import type { FromWorker, ToWorker } from "./host";

// WORKER
// the haze lives here, so waking a cold gpu never blocks the page

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (msg: FromWorker) => scope.postMessage(msg);
let haze: Haze | null = null;

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const d = e.data;
  if (d.t === "init") {
    try {
      haze = new Haze(d.canvas, d.opts);
    } catch {
      send({ t: "fail" });
      return;
    }
    haze.onHud = (h) => send({ t: "hud", h });
    haze.onShown = () => send({ t: "shown" });
    d.canvas.addEventListener("webglcontextlost", (ev) => {
      ev.preventDefault();
      haze?.dispose();
      haze = null;
      send({ t: "fail" });
    });
    return;
  }
  if (!haze) return;
  (haze[d.t] as (...a: unknown[]) => unknown).apply(haze, d.a);
};
