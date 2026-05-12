import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type PromptName = "researcher";

const KNOWN_PROMPTS: readonly PromptName[] = ["researcher"] as const;

const cache = new Map<PromptName, string>();

const here = dirname(fileURLToPath(import.meta.url));

export function loadPrompt(name: PromptName): string {
  if (!KNOWN_PROMPTS.includes(name)) {
    throw new Error(`loadPrompt: unknown prompt "${name}"`);
  }
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const body = readFileSync(join(here, `${name}.md`), "utf8");
  cache.set(name, body);
  return body;
}
