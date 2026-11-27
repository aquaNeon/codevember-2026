import "../shared/style.css";
import { mountNav } from "../shared/nav";
import type { In, Out } from "./host";

const DAY = 6;
const MAX_DPR = 2;

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const year = root.querySelector<HTMLElement>("[data-cv-year]");
  const driver = root.querySelector<HTMLElement>("[data-cv-driver]");
  const params = new URLSearchParams(location.search);
  const cleanups: (() => void)[] = [];
  const still = () => {
    root.setAttribute("data-cv-still", "");
    root.removeAttribute("data-cv-live");
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
  };

  if (!canvas || params.has("still")) still();
  else void mount(canvas).catch(still);

  // MOUNT
  // three in a worker on an offscreen canvas when possible, else the same host here
  async function mount(canvas: HTMLCanvasElement) {
    const receive = (m: Out) => {
      if (m.t === "state") {
        if (year) year.textContent = m.years.toFixed(2);
        if (driver) driver.textContent = m.driver;
      } else if (m.t === "cursor") canvas.style.cursor = m.cursor;
      else if (m.t === "ready") root?.setAttribute("data-cv-live", "");
      else if (m.t === "fail") still();
    };

    let send: (m: In, transfer?: Transferable[]) => void;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const init = { reduced: mq.matches, gl: params.has("gl") };
    if ("transferControlToOffscreen" in canvas && !params.has("main")) {
      const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<Out>) => receive(e.data);
      worker.onerror = () => still();
      send = (m, transfer) => worker.postMessage(m, transfer ?? []);
      const off = canvas.transferControlToOffscreen();
      send({ t: "init", canvas: off, ...init }, [off]);
      cleanups.push(() => {
        worker.postMessage({ t: "dispose" });
        worker.terminate();
      });
    } else {
      const { host } = await import("./host");
      const handle = host(receive);
      send = (m) => handle(m);
      send({ t: "init", canvas, ...init });
      cleanups.push(() => handle({ t: "dispose" }));
    }

    // OBSERVERS
    let rect = canvas.getBoundingClientRect();
    let onScreen = false;
    const show = () => send({ t: "show", on: onScreen && !document.hidden });
    const ro = new ResizeObserver(() => {
      rect = canvas.getBoundingClientRect();
      send({
        t: "size",
        w: rect.width,
        h: rect.height,
        dpr: Math.min(devicePixelRatio || 1, MAX_DPR),
      });
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      show();
    });
    io.observe(canvas);
    const onMotion = () => send({ t: "motion", reduced: mq.matches });
    mq.addEventListener("change", onMotion);
    document.addEventListener("visibilitychange", show);

    // INPUT
    const fwd = (t: "down" | "move") => (e: PointerEvent) =>
      send({
        t,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        id: e.pointerId,
        touch: e.pointerType !== "mouse",
      });
    const down = fwd("down");
    const press = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      down(e);
    };
    const move = fwd("move");
    const up = (e: PointerEvent) => send({ t: "up", id: e.pointerId });
    const key = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      send({ t: "nudge", dir: e.key === "ArrowRight" ? 1 : -1 });
    };
    const opts = { passive: true };
    canvas.addEventListener("pointerdown", press, opts);
    canvas.addEventListener("pointermove", move, opts);
    canvas.addEventListener("pointerup", up, opts);
    canvas.addEventListener("pointercancel", up, opts);
    canvas.addEventListener("keydown", key);

    cleanups.push(
      () => ro.disconnect(),
      () => io.disconnect(),
      () => mq.removeEventListener("change", onMotion),
      () => document.removeEventListener("visibilitychange", show),
      () => canvas.removeEventListener("pointerdown", press),
      () => canvas.removeEventListener("pointermove", move),
      () => canvas.removeEventListener("pointerup", up),
      () => canvas.removeEventListener("pointercancel", up),
      () => canvas.removeEventListener("keydown", key),
    );
  }
}
