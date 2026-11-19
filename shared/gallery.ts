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
  const img = peek?.querySelector("img");
  if (peek && img && matchMedia("(hover: hover) and (pointer: fine)").matches) {
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
    // PRELOAD
    // every thumb is fetched and decoded once the page is idle, so hovering never waits
    const ready = new Set<string>();
    const urls = Array.from(
      list.querySelectorAll<HTMLAnchorElement>("a.row"),
      (a) => a.dataset.cvThumb ?? "",
    );
    const preload = () => {
      for (const url of urls) {
        if (!url) continue;
        const pre = new Image();
        pre.decoding = "async";
        pre.src = url;
        pre
          .decode()
          .then(() => ready.add(url))
          .catch(() => {});
      }
    };
    if ("requestIdleCallback" in window) requestIdleCallback(preload, { timeout: IDLE_MS });
    else setTimeout(preload, IDLE_MS);

    // the image shown is always the hovered row's; one still loading waits blank, then fades in,
    // and a late arrival never replaces a newer hover
    let want = "";
    const show = () => {
      if (img.getAttribute("src") !== want) img.src = want;
      img.removeAttribute("data-cv-wait");
    };
    img.addEventListener("load", () => {
      if (img.getAttribute("src") === want) img.removeAttribute("data-cv-wait");
    });

    list.addEventListener(
      "pointerover",
      (e) => {
        const row = (e.target as Element).closest<HTMLAnchorElement>("a.row");
        const url = row?.dataset.cvThumb;
        if (!url) return;
        if (url !== want) {
          want = url;
          if (ready.has(url)) show();
          else {
            img.setAttribute("data-cv-wait", "");
            img.src = url;
          }
        }
        const r = peek.getBoundingClientRect();
        w = r.width || w;
        h = r.height || h;
        peek.setAttribute("data-cv-on", "");
      },
      { passive: true },
    );
    list.addEventListener(
      "pointerout",
      (e) => {
        const to = (e.relatedTarget as Element | null)?.closest("a.row");
        if (!to) peek.removeAttribute("data-cv-on");
      },
      { passive: true },
    );
  }
}
