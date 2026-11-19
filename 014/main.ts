import "../shared/style.css";
import { mountNav } from "../shared/nav";
import { Voice } from "./audio";
import { mount } from "./host";
import {
  COUNT,
  KNOB_DY_U,
  KNOB_R_U,
  STRINGS,
  T_RANGE,
  hz,
  place,
  shoulder,
  turn,
  type Place,
} from "./layout";

const DAY = 14;
const IDLE_MS = 1200; // longest wait before the drawing starts anyway
const GRAB_U = 14; // how close a press must land to catch a string
const KNOB_HIT_PX = 22; // touch reach around a knob, at least
const SLIP_U = 30; // a held string slips off the finger past this pull
const TAP_U = 13; // a tap without a pull plucks this far
const STRUM_U_PER_SPEED = 7; // pull per unit/ms of swipe
const STRUM_RANGE_U = [7, 26] as const;
const TUNE_N_PER_PX = 0.16; // drag a knob up to tighten
const WHEEL_N_PER_PX = 0.02;
const KEY_N = 1;
const KEY_FINE_N = 0.2;
const STRUM_GAP_MS = 42;
const START = 3;
const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const q = <T extends Element>(s: string) => root.querySelector<T>(s);
  const hud = {
    note: q<HTMLElement>("[data-cv-note]"),
    tension: q<HTMLElement>("[data-cv-tension]"),
    freq: q<HTMLElement>("[data-cv-freq]"),
  };
  const strumBtn = q<HTMLButtonElement>("[data-cv-strum]");
  const muteBtn = q<HTMLButtonElement>("[data-cv-mute]");
  const params = new URLSearchParams(location.search);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const still = () => {
    root.removeAttribute("data-cv-live");
    root.setAttribute("data-cv-still", "");
  };

  const tension = STRINGS.map((s) => s.t0);
  let cur = START;

  const readout = (i: number) => {
    const f = hz(STRINGS[i], tension[i]);
    const midi = 69 + 12 * Math.log2(f / 440);
    const r = Math.round(midi);
    const c = Math.round((midi - r) * 100);
    const name = `${NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
    if (hud.note) hud.note.textContent = c ? `${name} ${c > 0 ? "+" : "−"}${Math.abs(c)}¢` : name;
    if (hud.tension) hud.tension.textContent = `${tension[i].toFixed(1)} N`;
    if (hud.freq) hud.freq.textContent = `${f.toFixed(1)} Hz`;
  };
  readout(cur);

  if (!canvas || params.has("still")) still();
  else
    afterLoad().then(() => {
      const harp = mount(
        canvas,
        {
          shown: () => {
            canvas.setAttribute("data-cv-shown", "");
            root.setAttribute("data-cv-live", "");
          },
          fail: still,
        },
        { reducedMotion: reduced },
      );
      const stop = play(canvas, harp);
      if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { harp, stop });
    });

  // PLAY
  // input, sound and readouts live here; the drawing only hears plucks and tunings
  function play(cv: HTMLCanvasElement, harp: ReturnType<typeof mount>) {
    const voice = new Voice();
    const cleanups: (() => void)[] = [() => voice.dispose()];
    const at: Place = { s: 1, ox: 0, oy: 0 };
    let rect = cv.getBoundingClientRect();
    const ro = new ResizeObserver(() => {
      rect = cv.getBoundingClientRect();
      place(cv.clientWidth, cv.clientHeight, at);
    });
    ro.observe(cv);
    cleanups.push(() => ro.disconnect());

    const give = (i: number) => Math.sqrt(STRINGS[i].t0 / tension[i]);
    const t60 = (i: number) => STRINGS[i].t60 * Math.pow(tension[i] / STRINGS[i].t0, 0.25);

    const pluck = (i: number, p: number, d: number) => {
      harp.pluck(i, p, d);
      voice.pluck(i, hz(STRINGS[i], tension[i]), p, Math.min(1, Math.abs(d) / SLIP_U), t60(i));
      cur = i;
      readout(i);
    };
    const setT = (i: number, t: number) => {
      const s = STRINGS[i];
      tension[i] = Math.min(s.t0 * T_RANGE[1], Math.max(s.t0 * T_RANGE[0], t));
      const f = hz(s, tension[i]);
      harp.tune(i, f, turn(s, tension[i]), t60(i));
      voice.bend(i, f);
      cur = i;
      readout(i);
    };

    // HIT TESTS
    // in design units
    const u = (x: number) => (x - rect.left - at.ox) / at.s;
    const v = (y: number) => (y - rect.top - at.oy) / at.s;
    const knobAt = (x: number, y: number) => {
      const reach = Math.max(KNOB_R_U + 6, KNOB_HIT_PX / at.s);
      for (let i = 0; i < COUNT; i++) {
        const s = STRINGS[i];
        if (Math.hypot(u(x) - s.x, v(y) - (shoulder(s.x) + KNOB_DY_U)) < reach) return i;
      }
      return -1;
    };
    const stringAt = (x: number, y: number) => {
      const uu = u(x);
      const vv = v(y);
      for (let i = 0; i < COUNT; i++) {
        const s = STRINGS[i];
        if (Math.abs(uu - s.x) < GRAB_U && vv > s.nut + 4 && vv < s.bridge - 4) return i;
      }
      return -1;
    };
    const along = (i: number, vv: number) => {
      const s = STRINGS[i];
      return Math.min(0.94, Math.max(0.06, (vv - s.nut) / (s.bridge - s.nut)));
    };

    // POINTER
    // press a knob and drag to tune; press a string and pull to pluck; swipe to strum
    let pid = -1;
    let mode: "none" | "tune" | "hold" | "strum" = "none";
    let idx = -1;
    let lastY = 0;
    let pu = 0;
    let pv = 0;
    let pt = 0;
    let holdP = 0.5;
    let holdD = 0;
    let hover = "";

    const down = (e: PointerEvent) => {
      voice.wake();
      if (pid !== -1) return;
      pid = e.pointerId;
      cv.setPointerCapture(e.pointerId);
      pu = u(e.clientX);
      pv = v(e.clientY);
      pt = e.timeStamp;
      const k = knobAt(e.clientX, e.clientY);
      if (k !== -1) {
        mode = "tune";
        idx = k;
        lastY = e.clientY;
        harp.select(k);
        cur = k;
        readout(k);
        return;
      }
      const s = stringAt(e.clientX, e.clientY);
      if (s !== -1) {
        mode = "hold";
        idx = s;
        holdP = along(s, pv);
        holdD = pu - STRINGS[s].x;
        harp.hold(s, holdP, holdD);
        cur = s;
        readout(s);
        return;
      }
      mode = "strum";
    };

    const strum = (u1: number, v1: number, ms: number) => {
      const du = u1 - pu;
      if (du === 0) return;
      const speed = Math.abs(du) / Math.max(4, ms);
      for (let i = 0; i < COUNT; i++) {
        const s = STRINGS[i];
        if (pu < s.x === u1 < s.x) continue;
        const vv = pv + ((s.x - pu) / du) * (v1 - pv);
        if (vv < s.nut + 4 || vv > s.bridge - 4) continue;
        const amp = Math.min(
          STRUM_RANGE_U[1],
          Math.max(STRUM_RANGE_U[0], speed * STRUM_U_PER_SPEED),
        );
        pluck(i, along(i, vv), Math.sign(du) * amp * give(i));
      }
    };

    const move = (e: PointerEvent) => {
      if (e.pointerId !== pid) {
        if (pid === -1 && e.pointerType === "mouse") {
          const c =
            knobAt(e.clientX, e.clientY) !== -1
              ? "ns-resize"
              : stringAt(e.clientX, e.clientY) !== -1
                ? "grab"
                : "default";
          if (c !== hover) cv.style.cursor = hover = c;
        }
        return;
      }
      const u1 = u(e.clientX);
      const v1 = v(e.clientY);
      if (mode === "tune") {
        setT(idx, tension[idx] + (lastY - e.clientY) * TUNE_N_PER_PX);
        lastY = e.clientY;
      } else if (mode === "hold") {
        holdP = along(idx, v1);
        holdD = u1 - STRINGS[idx].x;
        const slip = SLIP_U * give(idx);
        if (Math.abs(holdD) > slip) {
          pluck(idx, holdP, Math.sign(holdD) * slip);
          mode = "strum";
        } else harp.hold(idx, holdP, holdD);
      } else if (mode === "strum") strum(u1, v1, e.timeStamp - pt);
      pu = u1;
      pv = v1;
      pt = e.timeStamp;
    };

    const up = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      voice.wake();
      pid = -1;
      if (mode === "hold") {
        if (e.type === "pointercancel") harp.release(idx);
        else {
          const d = Math.abs(holdD) < 2 ? TAP_U * give(idx) * (holdD < 0 ? -1 : 1) : holdD;
          pluck(idx, holdP, d);
        }
      } else if (mode === "tune") harp.select(-1);
      mode = "none";
    };

    const wheel = (e: WheelEvent) => {
      const k = knobAt(e.clientX, e.clientY);
      if (k !== -1) setT(k, tension[k] - e.deltaY * WHEEL_N_PER_PX);
    };

    // KEYS
    // 1 to 7 pluck, arrows pick and tune, enter plucks the picked string
    const key = (e: KeyboardEvent) => {
      const n = Number(e.key);
      let hit = true;
      if (n >= 1 && n <= COUNT) {
        voice.wake();
        pluck(n - 1, 0.3, TAP_U * 1.3 * give(n - 1));
        harp.select(n - 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        cur = Math.min(COUNT - 1, Math.max(0, cur + (e.key === "ArrowLeft" ? -1 : 1)));
        harp.select(cur);
        readout(cur);
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const step = e.shiftKey ? KEY_FINE_N : KEY_N;
        setT(cur, tension[cur] + (e.key === "ArrowUp" ? step : -step));
        harp.select(cur);
      } else if (e.key === "Enter" || e.key === " ") {
        voice.wake();
        pluck(cur, 0.3, TAP_U * 1.3 * give(cur));
        harp.select(cur);
      } else hit = false;
      if (hit) e.preventDefault();
    };
    const blur = () => harp.select(-1);

    // BUTTONS
    const timers: number[] = [];
    const strumAll = () => {
      voice.wake();
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
      for (let i = 0; i < COUNT; i++)
        timers.push(window.setTimeout(() => pluck(i, 0.32, 15 * give(i)), i * STRUM_GAP_MS));
    };
    let muted = false;
    const toggleMute = () => {
      muted = !muted;
      voice.wake();
      voice.mute(muted);
      if (muteBtn) {
        muteBtn.setAttribute("aria-pressed", String(muted));
        muteBtn.textContent = muted ? "Unmute" : "Mute";
      }
    };

    const opts = { passive: true };
    cv.addEventListener("pointerdown", down, opts);
    cv.addEventListener("pointermove", move, opts);
    cv.addEventListener("pointerup", up, opts);
    cv.addEventListener("pointercancel", up, opts);
    cv.addEventListener("wheel", wheel, opts);
    cv.addEventListener("keydown", key);
    cv.addEventListener("blur", blur);
    strumBtn?.addEventListener("click", strumAll);
    muteBtn?.addEventListener("click", toggleMute);
    cleanups.push(
      () => cv.removeEventListener("pointerdown", down),
      () => cv.removeEventListener("pointermove", move),
      () => cv.removeEventListener("pointerup", up),
      () => cv.removeEventListener("pointercancel", up),
      () => cv.removeEventListener("wheel", wheel),
      () => cv.removeEventListener("keydown", key),
      () => cv.removeEventListener("blur", blur),
      () => strumBtn?.removeEventListener("click", strumAll),
      () => muteBtn?.removeEventListener("click", toggleMute),
      () => timers.forEach((t) => clearTimeout(t)),
      () => harp.dispose(),
    );

    return () => {
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
    };
  }
}

function afterLoad() {
  return new Promise<void>((done) => {
    const idle = () =>
      "requestIdleCallback" in window
        ? requestIdleCallback(() => done(), { timeout: IDLE_MS })
        : setTimeout(done, 200);
    if (document.readyState === "complete") idle();
    else addEventListener("load", idle, { once: true });
  });
}
