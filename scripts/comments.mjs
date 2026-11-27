import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.argv[2] ?? ".";
const MAX_WHY_CHARS = 90; // change why-line cap here
const EXT = /\.(ts|mjs|js|html|css)$/;
const SKIP = new Set(["node_modules", "dist", ".git", ".claude", "public", "audit"]);

const HEADING = /^[A-Z0-9][A-Z0-9 ,&/'+-]*$/;
const DIRECTIVE = /^(\/ <reference|eslint-|@ts-|prettier-)/;
const TWEAK = /^change\b|^[A-Z][A-Z0-9_]+$/;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

function parse(line) {
  const t = line.trim();
  if (/\/\*\s*glsl\s*\*\//.test(line)) return null;
  let m = t.match(/^\/\/(.*)$/) ?? t.match(/^\/\*(.*?)\*\/$/) ?? t.match(/^<!--(.*?)-->$/);
  if (m) return { kind: "own", text: m[1].trim() };
  if (line.includes("://")) return null;
  m = line.match(/\S.*?\s(\/\/|\/\*)\s?(.*?)(\*\/)?\s*$/);
  if (m) return { kind: "eol", text: m[2].trim() };
  if (/^\/\*|^\*(?![\s,{])|^\*$/.test(t) || (t.endsWith("*/") && !t.includes("/*")))
    return { kind: "block", text: t };
  return null;
}

let fails = 0;
const FILES = statSync(ROOT).isDirectory() ? walk(ROOT, []) : [ROOT];
for (const file of FILES) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  let prev = "code";
  lines.forEach((line, i) => {
    const c = parse(line);
    const at = `${relative(ROOT, file)}:${i + 1}`;
    const bad = (why) => {
      fails++;
      console.log(`${at}  ${why}  ${line.trim()}`);
    };
    if (!c) {
      prev = "code";
      return;
    }
    if (DIRECTIVE.test(c.text)) return;
    if (c.kind === "block") bad("multi-line block comment");
    else if (c.kind === "eol") {
      if (!TWEAK.test(c.text)) bad("eol comment not a tweak pointer");
    } else if (HEADING.test(c.text)) prev = "heading";
    else if (prev === "heading") {
      if (c.text.length > MAX_WHY_CHARS) bad("why-line too long");
      prev = "why";
    } else bad(prev === "why" ? "second why-line" : "comment without heading");
    if (c.kind !== "own") prev = "code";
  });
}

if (fails) {
  console.log(`\n${fails} comment(s) break the rule`);
  process.exit(1);
}
