/// <reference lib="webworker" />
import { Magma } from "./magma";
import type { FromWorker, ToWorker } from "./host";

// WORKER
// the whole magma lives here, so waking a cold gpu never blocks the page

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (msg: FromWorker) => scope.postMessage(msg);
let magma: Magma | null = null;

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const d = e.data;
  if (d.t === "init") {
    try {
      magma = new Magma(d.canvas, d.opts);
    } catch {
      send({ t: "fail" });
      return;
    }
    magma.onHud = (h) => send({ t: "hud", h });
    magma.onShown = () => send({ t: "shown" });
    d.canvas.addEventListener("webglcontextlost", (ev) => {
      ev.preventDefault();
      magma?.dispose();
      magma = null;
      send({ t: "fail" });
    });
    return;
  }
  if (!magma) return;
  (magma[d.t] as (...a: unknown[]) => unknown).apply(magma, d.a);
};
