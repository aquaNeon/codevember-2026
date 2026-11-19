/// <reference lib="webworker" />
import { Spore } from "./spore";
import type { FromWorker, ToWorker } from "./host";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (msg: FromWorker) => scope.postMessage(msg);
let s: Spore | null = null;

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const d = e.data;
  if (d.t === "init") {
    try {
      s = new Spore(d.canvas, { look: d.look, reducedMotion: d.reduced, forceGl: d.forceGl });
    } catch {
      send({ t: "fail" });
      return;
    }
    s.onPuff = (n) => send({ t: "puff", n });
    s.onLabels = (xy) => send({ t: "labels", xy });
    s.onCursor = (c) => send({ t: "cursor", c });
    s.onShown = () => send({ t: "shown" });
    d.canvas.addEventListener("webglcontextlost", (ev) => {
      ev.preventDefault();
      s?.dispose();
      s = null;
      send({ t: "fail" });
    });
    return;
  }
  if (!s) return;
  (s[d.m] as (...a: (number | boolean)[]) => void).apply(s, d.a);
};
