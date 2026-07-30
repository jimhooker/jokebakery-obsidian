/**
 * Test stand-in for the "obsidian" module (types-only on npm, no runtime).
 *
 * parseYaml: Obsidian's is js-yaml's load (default schema); the `yaml` package
 * with the yaml-1.1 schema reproduces the quirks the tests care about (block
 * arrays, requoting, unquoted dates becoming Date objects). js-yaml itself is
 * avoided because the community-plugin review flags it as a dependency.
 *
 * The rest is the small surface the SYNC ENGINE touches - a real TFile class
 * (the engine uses `instanceof`), a Notice that records instead of rendering,
 * and normalizePath. The in-memory vault that backs them lives in
 * tests/fake-vault.ts.
 */
import { parse } from "yaml";

export function parseYaml(text: string): unknown {
  return parse(text, { schema: "yaml-1.1" });
}

/** Obsidian's own: forward slashes, no leading/trailing or doubled ones. */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

export class TAbstractFile {
  constructor(public path: string) {}
}

export class TFile extends TAbstractFile {
  get basename(): string {
    const name = this.path.split("/").pop() ?? "";
    return name.replace(/\.md$/, "");
  }
  get extension(): string {
    return this.path.split(".").pop() ?? "";
  }
}

export class TFolder extends TAbstractFile {}

/** Notices are UI; tests just want to know what the user would have been told. */
export class Notice {
  static shown: string[] = [];
  constructor(message: string) {
    Notice.shown.push(message);
  }
}

/** Declared so `private app: App` typechecks; the tests pass a FakeApp. */
export type App = unknown;

export class Modal {
  constructor(public app: unknown) {}
}

export class Plugin {
  constructor(public app: unknown) {}
}
