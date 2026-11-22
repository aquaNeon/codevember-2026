/// <reference lib="webworker" />
import { Cave } from "./cave";
import type { FromWorker, ToWorker } from "./host";

// WORKER
// the whole cave lives here, so waking a cold gpu never blocks the page

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (msg: FromWorker) => scope.postMessage(msg);
let cave: Cave | null = null;

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const d = e.data;
  if (d.t === "init") {
    try {
      cave = new Cave(d.canvas, d.opts);
    } catch {
      send({ t: "fail" });
      return;
    }
    cave.onHud = (h) => send({ t: "hud", h });
    cave.onShown = () => send({ t: "shown" });
    d.canvas.addEventListener("webglcontextlost", (ev) => {
      ev.preventDefault();
      cave?.dispose();
      cave = null;
      send({ t: "fail" });
    });
    return;
  }
  if (!cave) return;
  (cave[d.t] as (...a: unknown[]) => unknown).apply(cave, d.a);
};
