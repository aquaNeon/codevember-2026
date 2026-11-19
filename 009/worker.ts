/// <reference lib="webworker" />
import { Membrane } from "./membrane";
import type { FromWorker, ToWorker } from "./host";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (msg: FromWorker) => scope.postMessage(msg);
let m: Membrane | null = null;

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const d = e.data;
  if (d.t === "init") {
    try {
      m = new Membrane(d.canvas, { look: d.look, reducedMotion: d.reduced, forceGl: d.forceGl });
    } catch {
      send({ t: "fail" });
      return;
    }
    m.onPoke = (n) => send({ t: "poke", n });
    m.onCursor = (c) => send({ t: "cursor", c });
    m.onShown = () => send({ t: "shown" });
    d.canvas.addEventListener("webglcontextlost", (ev) => {
      ev.preventDefault();
      m?.dispose();
      m = null;
      send({ t: "fail" });
    });
    return;
  }
  if (!m) return;
  (m[d.m] as (...a: (number | boolean)[]) => void).apply(m, d.a);
};
