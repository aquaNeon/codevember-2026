import { Shatter } from "./shatter";
import { apply, type FromScene, type ToScene } from "./stage";

// WORKER
// the whole scene lives here, so waking a cold gpu never blocks the page

let c: Shatter | null = null;
const send = (m: FromScene) => postMessage(m);

self.onmessage = (e: MessageEvent<ToScene>) => {
  const m = e.data;
  if (m.t === "init") {
    try {
      c = new Shatter(m.canvas, m.reduced, m.at);
    } catch {
      send({ t: "lost" });
      return;
    }
    c.onShown = () => send({ t: "shown" });
    c.onLost = () => send({ t: "lost" });
    c.onState = (time, real, pieces, phase, over, dur) =>
      send({ t: "state", time, real, pieces, phase, over, dur });
    return;
  }
  if (!c) return;
  apply(c, m);
  if (m.t === "dispose") {
    c = null;
    close();
  }
};
