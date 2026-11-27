import { apply } from "./apply";
import { Pendulum } from "./pendulum";
import type { FromWorker, ToWorker } from "./stage";

// WORKER
// waking a cold gpu here never blocks the page

let p: Pendulum | null = null;
const send = (m: FromWorker) => postMessage(m);

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.t === "init") {
    try {
      p = new Pendulum(m.canvas, m.reduced);
    } catch {
      send({ t: "lost" });
      return;
    }
    p.onShown = () => send({ t: "shown" });
    p.onLost = () => send({ t: "lost" });
    return;
  }
  if (!p) return;
  apply(p, m);
  if (m.t === "dispose") {
    p = null;
    close();
  }
};
