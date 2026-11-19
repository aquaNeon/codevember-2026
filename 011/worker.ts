/// <reference lib="webworker" />
import type { FromWorker, ToWorker } from "./host";
import { Specimen } from "./specimen";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (msg: FromWorker) => scope.postMessage(msg);
let scene: Specimen | null = null;

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const d = e.data;
  if (d.t === "init") {
    try {
      scene = new Specimen(d.canvas, d.opts);
    } catch {
      send({ t: "fail" });
      return;
    }
    scene.onAge = (age, playing) => send({ t: "age", age, playing });
    scene.onShown = () => send({ t: "shown" });
    d.canvas.addEventListener("webglcontextlost", (ev) => {
      ev.preventDefault();
      scene?.dispose();
      scene = null;
      send({ t: "fail" });
    });
    return;
  }
  if (!scene) return;
  (scene[d.t] as (...a: unknown[]) => unknown).apply(scene, d.a);
};
