/// <reference lib="webworker" />
import type { FromWorker, ToWorker } from "./host";
import { Nest } from "./nest";

// WORKER
// the whole scene lives here, so waking a cold gpu never blocks the page

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (msg: FromWorker) => scope.postMessage(msg);
let nest: Nest | null = null;

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const d = e.data;
  if (d.t === "init") {
    try {
      nest = new Nest(d.canvas, d.opts);
    } catch {
      send({ t: "fail" });
      return;
    }
    nest.onHud = (h) => send({ t: "hud", h });
    nest.onShown = () => send({ t: "shown" });
    d.canvas.addEventListener("webglcontextlost", (ev) => {
      ev.preventDefault();
      nest?.dispose();
      nest = null;
      send({ t: "fail" });
    });
    return;
  }
  if (!nest) return;
  (nest[d.t] as (...a: unknown[]) => unknown).apply(nest, d.a);
};
