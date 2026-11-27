import { apply } from "./apply";
import { Cocoon } from "./cocoon";
import type { FromWorker, ToWorker } from "./stage";

// WORKER
// scene runs here so gpu warm-up never blocks the main thread

let c: Cocoon | null = null;
const send = (m: FromWorker) => postMessage(m);

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.t === "init") {
    try {
      c = new Cocoon(m.canvas, m.reduced, m.at, m.bg);
    } catch {
      send({ t: "lost" });
      return;
    }
    c.onShown = () => send({ t: "shown" });
    c.onLost = () => send({ t: "lost" });
    c.onLight = (l) => send({ t: "light", l });
    return;
  }
  if (!c) return;
  apply(c, m);
  if (m.t === "dispose") {
    c = null;
    close();
  }
};
