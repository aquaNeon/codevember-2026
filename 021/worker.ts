/// <reference lib="webworker" />
import { Garden } from "./garden";
import type { FromWorker, ToWorker } from "./host";

// WORKER
// the whole garden lives here, so waking a cold gpu never blocks the page

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (msg: FromWorker) => scope.postMessage(msg);
let garden: Garden | null = null;

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const d = e.data;
  if (d.t === "init") {
    try {
      garden = new Garden(d.canvas, d.opts);
    } catch {
      send({ t: "fail" });
      return;
    }
    garden.onHud = (h) => send({ t: "hud", h });
    garden.onShown = () => send({ t: "shown" });
    d.canvas.addEventListener("webglcontextlost", (ev) => {
      ev.preventDefault();
      garden?.dispose();
      garden = null;
      send({ t: "fail" });
    });
    return;
  }
  if (!garden) return;
  (garden[d.t] as (...a: unknown[]) => unknown).apply(garden, d.a);
};
