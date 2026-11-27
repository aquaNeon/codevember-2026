import type { Pendulum } from "./pendulum";
import type { ToWorker } from "./stage";

export function apply(p: Pendulum, m: ToWorker) {
  if (m.t === "size") p.size(m.w, m.h, m.dpr);
  else if (m.t === "show") p.show(m.v);
  else if (m.t === "motion") p.motion(m.v);
  else if (m.t === "down") p.down(m.x, m.y, m.ms);
  else if (m.t === "move") p.move(m.x, m.y, m.ms);
  else if (m.t === "up") p.up(m.x, m.tap, m.ms);
  else if (m.t === "key") p.key(m.k);
  else if (m.t === "spin") p.spin();
  else if (m.t === "dispose") p.dispose();
}
