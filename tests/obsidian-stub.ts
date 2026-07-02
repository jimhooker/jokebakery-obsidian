/**
 * Test stand-in for the "obsidian" module (types-only on npm, no runtime).
 * Obsidian's parseYaml is js-yaml's load (default schema); the `yaml` package
 * with the yaml-1.1 schema reproduces the quirks the tests care about (block
 * arrays, requoting, unquoted dates becoming Date objects). js-yaml itself is
 * avoided because the community-plugin review flags it as a dependency.
 */
import { parse } from "yaml";

export function parseYaml(text: string): unknown {
  return parse(text, { schema: "yaml-1.1" });
}
