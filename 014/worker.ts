/// <reference lib="webworker" />
import { Harp } from "./harp";
import type { FromWorker, ToWorker } from "./host";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (msg: FromWorker) => scope.postMessage(msg);
let harp: Harp | null = null;

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const d = e.data;
  if (d.t === "init") {
    try {
      harp = new Harp(d.canvas, d.opts);
    } catch {
      send({ t: "fail" });
      return;
    }
    harp.onShown = () => send({ t: "shown" });
    return;
  }
  if (!harp) return;
  try {
    (harp[d.t] as (...a: unknown[]) => unknown).apply(harp, d.a);
  } catch {
    harp.dispose();
    harp = null;
    send({ t: "fail" });
  }
};
