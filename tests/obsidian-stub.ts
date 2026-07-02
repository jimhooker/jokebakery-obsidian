/**
 * Test stand-in for the "obsidian" module (types-only on npm, no runtime).
 * Obsidian's parseYaml is js-yaml's load, so backing the stub with js-yaml
 * exercises the same normalization quirks (block arrays, requoting, unquoted
 * dates becoming Date objects) the real app produces.
 */
import { load } from "js-yaml";

export function parseYaml(text: string): unknown {
  return load(text);
}
