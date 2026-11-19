export const DAYS = [
  "Fold",
  "Shatter",
  "Melt",
  "Tangle",
  "Moss",
  "Orrery",
  "Hollow",
  "Tesseract",
  "Membrane",
  "Caustic",
  "Rust",
  "Feather",
  "Labyrinth",
  "Tension",
  "Mirage",
  "Spore",
  "Kelp",
  "Pendulum",
  "Erosion",
  "Cocoon",
  "Bolt",
  "Echo",
  "Magma",
  "Nest",
  "Veil",
  "Anamorph",
  "Burrow",
  "Hive",
  "Portal",
  "Dissolve",
] as const;

// filled at build time from the day folders and their thumbs, see vite.config.ts
export const READY = new Set(__CV_READY__);

export const pad = (n: number) => String(n).padStart(3, "0");

// accent per shipped day, read from the --accent its page declares; used by the index hover
export const ACCENT: Record<number, string> = __CV_ACCENT__;
