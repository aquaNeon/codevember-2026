import "./style.css";
import { ACCENT, DAYS, READY, pad } from "./days";

const PEEK_GAP_PX = 28; // distance between cursor and preview
const IDLE_MS = 1500; // longest wait before the thumbs start preloading anyway

const list = document.querySelector<HTMLOListElement>("[data-cv-days]");
const peek = document.querySelector<HTMLElement>("[data-cv-peek]");

if (list && !list.hasAttribute("data-cv-mounted")) {
  list.setAttribute("data-cv-mounted", "");

  // ROWS
  DAYS.forEach((name, i) => {
    const n = i + 1;
    const ready = READY.has(n);
    const li = document.createElement("li");
    const row = document.createElement(ready ? "a" : "span");
    row.className = ready ? "row" : "row soon";
    if (row instanceof HTMLAnchorElement) {
      row.href = `./${pad(n)}/`;
      row.dataset.cvThumb = `./thumbs/${pad(n)}.jpg`;
      if (ACCENT[n]) row.style.setProperty("--accent", ACCENT[n]);
    }
    const num = document.createElement("small");
    num.className = "mono num";
    num.textContent = pad(n);
    const title = document.createElement("strong");
    const rule = document.createElement("i");
    rule.className = "rule";
    rule.setAttribute("aria-hidden", "true");
    title.append(rule, name);
    const tag = document.createElement("small");
    tag.className = "mono tag";
    tag.textContent = ready ? "View →" : "Soon";
    row.append(num, title, tag);
    li.append(row);
    list.append(li);
  });

  // PEEK
  // follows the mouse over shipped rows; one rAF per batch of moves, nothing runs when idle
  const reel = peek?.querySelector<HTMLElement>("[data-cv-reel]");
  if (peek && reel && matchMedia("(hover: hover) and (pointer: fine)").matches) {
    let raf = 0;
    let px = 0;
    let py = 0;
    let w = 280;
    let h = 187;

    const place = () => {
      raf = 0;
      // flip to the left of the cursor near the right edge
      const x = px + PEEK_GAP_PX + w > innerWidth ? px - PEEK_GAP_PX - w : px + PEEK_GAP_PX;
      const y = Math.min(Math.max(8, py - h / 2), innerHeight - h - 8);
      peek.style.setProperty("--x", `${x}px`);
      peek.style.setProperty("--y", `${y}px`);
    };
    const queue = () => {
      if (!raf) raf = requestAnimationFrame(place);
    };

    list.addEventListener(
      "pointermove",
      (e) => {
        px = e.clientX;
        py = e.clientY;
        queue();
      },
      { passive: true },
    );

    // REEL
    // every thumb sits in one column that slides to the hovered row, so a fast sweep
    // rolls through them and turns mid-way instead of cutting
    const rows = Array.from(list.querySelectorAll<HTMLAnchorElement>("a.row"));
    const imgs = rows.map(() => {
      const img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      img.width = 280;
      img.height = 187;
      reel.append(img);
      return img;
    });
    reel.style.setProperty("--n", String(rows.length));
    let loaded = false;
    const load = () => {
      if (loaded) return;
      loaded = true;
      rows.forEach((a, i) => {
        imgs[i].src = a.dataset.cvThumb ?? "";
      });
    };
    if ("requestIdleCallback" in window) requestIdleCallback(load, { timeout: IDLE_MS });
    else setTimeout(load, IDLE_MS);

    let at = -1;
    let on = false;
    list.addEventListener(
      "pointerover",
      (e) => {
        const row = (e.target as Element).closest<HTMLAnchorElement>("a.row");
        if (!row) return;
        load();
        const i = rows.indexOf(row);
        if (i !== at) {
          // arriving from outside the list jumps straight to the row, only moves between rows roll
          if (!on) reel.setAttribute("data-cv-snap", "");
          reel.style.setProperty("--i", String(i));
          at = i;
          if (!on) requestAnimationFrame(() => reel.removeAttribute("data-cv-snap"));
        }
        if (!on) {
          const r = peek.getBoundingClientRect();
          w = r.width || w;
          h = r.height || h;
          on = true;
          peek.setAttribute("data-cv-on", "");
        }
      },
      { passive: true },
    );
    list.addEventListener(
      "pointerout",
      (e) => {
        const to = (e.relatedTarget as Element | null)?.closest("a.row");
        if (to) return;
        on = false;
        peek.removeAttribute("data-cv-on");
      },
      { passive: true },
    );
  }
}
