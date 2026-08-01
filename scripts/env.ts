import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Minimal .dev.vars loader for the node-side scripts. */
export function loadDevVars(file = ".dev.vars"): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(resolve(process.cwd(), file), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export function requireVar(name: string, vars: Record<string, string>): string {
  const value = process.env[name] ?? vars[name];
  if (!value) throw new Error(`Missing ${name}. Run 'npm run dev-vars' or export it.`);
  return value;
}
