/// <reference lib="webworker" />
import type { FromWorker, ToWorker } from "./host";
import { Lichen } from "./lichen";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (msg: FromWorker) => scope.postMessage(msg);
let scene: Lichen | null = null;

let shownN = -1;
let shownGrowing = false;

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const d = e.data;
  if (d.t === "init") {
    try {
      scene = new Lichen(d.canvas, d.opts);
    } catch {
      send({ t: "fail" });
      return;
    }
    scene.onState = (n, growing) => {
      if (n === shownN && growing === shownGrowing) return;
      shownN = n;
      shownGrowing = growing;
      send({ t: "state", n, growing });
    };
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
