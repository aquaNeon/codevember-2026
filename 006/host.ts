import { Orrery } from "./orrery";

export type In =
  | { t: "init"; canvas: HTMLCanvasElement | OffscreenCanvas; reduced: boolean; gl: boolean }
  | { t: "size"; w: number; h: number; dpr: number }
  | { t: "show"; on: boolean }
  | { t: "motion"; reduced: boolean }
  | { t: "down" | "move"; x: number; y: number; id: number; touch: boolean }
  | { t: "up"; id: number }
  | { t: "nudge"; dir: number }
  | { t: "dispose" };

export type Out =
  | { t: "state"; years: number; driver: string }
  | { t: "cursor"; cursor: string }
  | { t: "ready" }
  | { t: "fail" };

export function host(post: (m: Out) => void) {
  let o: Orrery | null = null;
  return (m: In) => {
    if (m.t === "init") {
      try {
        o = new Orrery(m.canvas, m.reduced, m.gl);
      } catch {
        post({ t: "fail" });
        return;
      }
      o.onState = (years, driver) => post({ t: "state", years, driver });
      o.onCursor = (cursor) => post({ t: "cursor", cursor });
      o.onReady = () => post({ t: "ready" });
      o.onFail = () => post({ t: "fail" });
      return;
    }
    if (!o) return;
    if (m.t === "size") o.resize(m.w, m.h, m.dpr);
    else if (m.t === "show") o.show(m.on);
    else if (m.t === "motion") o.motion(m.reduced);
    else if (m.t === "down") o.down(m.x, m.y, m.id, m.touch);
    else if (m.t === "move") o.move(m.x, m.y, m.id, m.touch);
    else if (m.t === "up") o.up(m.id);
    else if (m.t === "nudge") o.nudge(m.dir);
    else if (m.t === "dispose") {
      o.dispose();
      o = null;
    }
  };
}
