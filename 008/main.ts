import "../shared/style.css";
import { mountNav } from "../shared/nav";
import { Net } from "./net";
import { Tesseract } from "./tesseract";

const DAY = 8;
const VIEW_KEY = "cv:008-view";

type View = "plate" | "unfold";

// what each view calls its two readouts, its hint and its caption
const TEXT: Record<View, [string, string, string, string]> = {
  plate: ["XW", "YW", "Drag to rotate", "Octachoron, in projection"],
  unfold: ["Fold", "Turn", "Drag sideways to unfold", "Octachoron, unfolded"],
};

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const xw = root.querySelector<HTMLElement>("[data-cv-xw]");
  const yw = root.querySelector<HTMLElement>("[data-cv-yw]");
  const buttons = root.querySelectorAll<HTMLButtonElement>("[data-cv-view]");
  const params = new URLSearchParams(location.search);
  const still = () => root.setAttribute("data-cv-still", "");

  if (!canvas || params.has("still")) still();
  else {
    // the corner letters are set in the serif, wait for it so they never swap mid-spin
    document.fonts
      .load('italic 15px "Instrument Serif"')
      .catch(() => {})
      .then(() => {
        let current: Net | Tesseract | null = null;

        // VIEWS
        // both draw on the same 2d canvas; switching tears one down and starts the other
        const show = (view: View) => {
          current?.dispose();
          const [k1, k2, hint, caption] = TEXT[view];
          label("[data-cv-k1]", k1);
          label("[data-cv-k2]", k2);
          label("[data-cv-hint]", hint);
          label("[data-cv-caption]", caption);
          buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.cvView === view)));
          if (view === "unfold") {
            const net = new Net(canvas);
            net.onState = (a, b) => {
              if (xw) xw.textContent = `${a}%`;
              if (yw) yw.textContent = `${b.toFixed(0)}°`;
            };
            current = net;
          } else {
            const plate = new Tesseract(canvas);
            plate.onState = (a, b) => {
              if (xw) xw.textContent = `${a.toFixed(0)}°`;
              if (yw) yw.textContent = `${b.toFixed(0)}°`;
            };
            current = plate;
          }
          if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { current });
        };

        buttons.forEach((b) =>
          b.addEventListener("click", () => {
            const view: View = b.dataset.cvView === "plate" ? "plate" : "unfold";
            if (b.getAttribute("aria-pressed") === "true") return;
            remember(view);
            show(view);
          }),
        );

        show(initial(params));
        root.setAttribute("data-cv-live", "");
      })
      .catch(still);
  }
}

// ?v=b or ?v=a wins, then the last choice, then the unfolding view
function initial(params: URLSearchParams): View {
  const v = params.get("v");
  if (v === "b") return "unfold";
  if (v === "a") return "plate";
  try {
    if (localStorage.getItem(VIEW_KEY) === "plate") return "plate";
  } catch {
    // storage blocked: fall through to the default
  }
  return "unfold";
}

function remember(view: View) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // storage blocked: the choice lasts for this visit only
  }
}

function label(sel: string, text: string) {
  const el = document.querySelector(sel);
  if (el) el.textContent = text;
}
