import type { Cocoon } from "./cocoon";
import type { ToWorker } from "./stage";

// one message from the page onto the scene, wherever the scene runs
export function apply(c: Cocoon, m: ToWorker) {
  if (m.t === "size") c.size(m.w, m.h, m.dpr);
  else if (m.t === "show") c.show(m.v);
  else if (m.t === "motion") c.motion(m.v);
  else if (m.t === "down") c.down(m.x, m.y);
  else if (m.t === "move") c.move(m.x, m.y);
  else if (m.t === "up") c.up();
  else if (m.t === "leave") c.leave();
  else if (m.t === "angle") c.angle(m.v);
  else if (m.t === "dispose") c.dispose();
}
