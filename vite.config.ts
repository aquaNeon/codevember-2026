import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const ROOT = import.meta.dirname;
const DAY_RE = /^\d{3}$/;
const FONT_WAIT_MS = 800; // keep under the 1s css fallback delay in shared/style.css

// one entry per day folder that has an index.html
const days = readdirSync(ROOT).filter(
  (d) => DAY_RE.test(d) && existsSync(resolve(ROOT, d, "index.html")),
);

// SHIPPED DAYS
// a day is ready once its folder and thumb exist; its accent is the --accent its page declares,
// so each day ships in its own PR without touching shared files
const ACCENT_RE = /--accent:\s*(#[0-9a-fA-F]{3,8})/;
const ready = days.filter((d) => existsSync(resolve(ROOT, "public/thumbs", `${d}.jpg`)));
const accents = Object.fromEntries(
  ready.flatMap((d) => {
    const hit = ACCENT_RE.exec(readFileSync(resolve(ROOT, d, "index.html"), "utf8"));
    return hit ? [[Number(d), hit[1]]] : [];
  }),
);

// REVEAL
// every page flags <html> once the serif is in, so the fade starts on real glyphs;
// a fresh load or reload also flags data-cv-enter, so the top bar only animates then
const reveal: Plugin = {
  name: "cv-reveal",
  transformIndexHtml: () => [
    {
      tag: "script",
      injectTo: "head",
      children: `(()=>{const r=document.documentElement,f=document.fonts,n=performance.getEntriesByType("navigation")[0],x=document.referrer;let s=!1;try{s=new URL(x).origin===location.origin}catch{}if(!n||n.type==="reload"||(n.type==="navigate"&&!s))r.setAttribute("data-cv-enter","");t=setTimeout(o,${FONT_WAIT_MS});function o(){clearTimeout(t);r.setAttribute("data-cv-fonts","")}Promise.all([f.load('1em "Instrument Serif"'),f.load('italic 1em "Instrument Serif"')]).then(o,o)})()`,
    },
  ],
};

export default defineConfig({
  base: "./",
  plugins: [reveal],
  define: {
    __CV_READY__: JSON.stringify(ready.map(Number)),
    __CV_ACCENT__: JSON.stringify(accents),
  },
  build: {
    rollupOptions: {
      input: {
        index: resolve(ROOT, "index.html"),
        ...Object.fromEntries(days.map((d) => [d, resolve(ROOT, d, "index.html")])),
      },
    },
  },
});
