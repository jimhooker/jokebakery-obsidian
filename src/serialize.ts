/**
 * Markdown <-> DTO serialization.
 *
 * The vault file is the human surface; the server only ever sees JSON. So this
 * module is the whole translation layer, and it has to round-trip without loss.
 *
 * Layout of a file:
 *   - YAML frontmatter holds machine fields. Simple, user-editable ones
 *     (title, stage, families, topic-tags, theme, angle) are real YAML so
 *     Obsidian's property UI shows them. The fiddly word-index arrays (rhythm,
 *     IEN, components, checklist, alternative punchlines) ride in a single
 *     opaque `bw-meta` JSON blob - bulletproof to parse, not meant for hand
 *     editing.
 *   - The body holds editable prose under `## Setup` / `## Development` /
 *     `## Punchline`, brainstorm `## Lists`, and `## Notes` / `## Scratchpad`.
 *   - `## Alternative punchlines` and `## Setup versions` are rendered read-only
 *     and ignored on parse (managed in JokeBakery).
 *
 * Identity lives in frontmatter `bw-id`, never the filename - so renaming a
 * file in Obsidian doesn't break the link.
 *
 * Frontmatter is PARSED with Obsidian's own YAML parser: when a user edits any
 * property in Obsidian's Properties UI, Obsidian rewrites the whole block in
 * normalized YAML (block-style arrays, requoted scalars) that a line-based
 * parser can't read - and misreading it as empty would erase those fields on
 * the next push. Emitting stays hand-rolled (a stable, minimal subset) so
 * unchanged items always serialize byte-identically.
 */
import { parseYaml } from "obsidian";
import type {
  AdditionalPunchlineDTO,
  CrashDTO,
  IdeasDocDTO,
  IENValue,
  JokeDTO,
  JokePush,
  ListDTO,
  ListItemDTO,
  Rhythm,
  SprintDTO,
  SprintPush,
} from "./types";

/** Item ids are assigned client-side for bullets a human typed straight into
 *  Obsidian (no `^id` yet). Mirrors src/lib/id.ts in the app. */
function newItemId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 14);
}

export const SPRINTS_SUBDIR = "Sprints";
export const JOKES_SUBDIR = "Jokes";
export const LISTS_SUBDIR = "Lists";
export const CONFLICTS_SUBDIR = "Conflicts";
export const CRASHES_SUBDIR = "Crashes";
export const IDEAS_FILENAME = "Ideas.md";

const EMPTY_RHYTHM: Rhythm = { keys: [], colours: [] };

/** The IEN voice names, shouted. Mirrors IEN_LABELS in src/lib/ien-meta.ts. */
const IEN_VOICE: Record<"I" | "E" | "N" | "A", string> = {
  I: "INTERIOR",
  E: "EXTERIOR",
  N: "NARRATOR",
  A: "ACT OUT",
};

// ---------------------------------------------------------------------------
// Tiny YAML emit/parse (only the subset we produce)

function emitScalar(s: string): string {
  if (s === "") return "''";
  // Newlines/tabs can't survive a single-quoted single-line scalar; a JSON
  // string is also a valid YAML double-quoted scalar and escapes them.
  if (/[\n\r\t]/.test(s)) return JSON.stringify(s);
  const safe =
    /^[A-Za-z0-9 _./@-]+$/.test(s) &&
    !/^\s|\s$/.test(s) &&
    !/^-/.test(s) &&
    !/^(true|false|null|yes|no|on|off|~)$/i.test(s) &&
    !/^-?\d+(\.\d+)?$/.test(s);
  return safe ? s : "'" + s.replace(/'/g, "''") + "'";
}

function emitArray(items: string[]): string {
  return "[" + items.map(emitScalar).join(", ") + "]";
}

function emitJson(value: unknown): string {
  return "'" + JSON.stringify(value).replace(/'/g, "''") + "'";
}

function parseScalar(v: string): string | number | boolean {
  if (v.startsWith("'")) {
    const inner = v.slice(1, v.endsWith("'") ? -1 : undefined);
    return inner.replace(/''/g, "'");
  }
  if (v.startsWith('"')) {
    const inner = v.slice(1, v.endsWith('"') ? -1 : undefined);
    return inner.replace(/\\"/g, '"');
  }
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

function parseFlowArray(v: string): string[] {
  const inner = v.replace(/^\[/, "").replace(/\]$/, "");
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "'") {
      if (inQuote && inner[i + 1] === "'") {
        cur += "''";
        i++;
        continue;
      }
      inQuote = !inQuote;
      cur += c;
      continue;
    }
    if (c === "," && !inQuote) {
      if (cur.trim()) out.push(String(parseScalar(cur.trim())));
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(String(parseScalar(cur.trim())));
  return out;
}

function parseYamlValue(raw: string): unknown {
  const v = raw.trim();
  if (v === "") return "";
  if (v.startsWith("[")) return parseFlowArray(v);
  return parseScalar(v);
}

/** Lenient line-based fallback for frontmatter Obsidian's parser rejects -
 *  better to salvage the flat `key: value` pairs (above all `bw-id`) than to
 *  treat the file as brand new and duplicate it on push. */
function parseFrontmatterLines(lines: string[]): Record<string, unknown> {
  const fm: Record<string, unknown> = {};
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fm[line.slice(0, idx).trim()] = parseYamlValue(line.slice(idx + 1));
  }
  return fm;
}

function splitContent(content: string): { fm: Record<string, unknown>; body: string } {
  if (!content.startsWith("---")) return { fm: {}, body: content };
  const lines = content.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { fm: {}, body: content };

  const yamlLines = lines.slice(1, end);
  let fm: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(yamlLines.join("\n")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
    }
  } catch {
    fm = parseFrontmatterLines(yamlLines);
  }
  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "");
  return { fm, body };
}

function frontmatter(pairs: Array<[string, string]>): string {
  return "---\n" + pairs.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n---\n\n";
}

// ---------------------------------------------------------------------------
// Coercion helpers

function asStr(v: unknown, def = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // YAML parsers turn an unquoted `2026-06-06` into a Date; ours are always
  // date-only (bw-date), so the ISO date part is the original string.
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return def;
}
function asNum(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}
function asRhythm(v: unknown): Rhythm {
  if (v && typeof v === "object") {
    const r = v as Partial<Rhythm>;
    return {
      keys: Array.isArray(r.keys) ? r.keys.map(Number) : [],
      colours: Array.isArray(r.colours) ? r.colours.map(Number) : [],
    };
  }
  return { ...EMPTY_RHYTHM };
}
function asIEN(v: unknown): IENValue[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (x === "I" || x === "E" || x === "N" ? x : null));
}

/** IEN tags are parallel to a slot's lines. An Obsidian edit can shrink the
 *  slot and leave stale tags past the end - never push tags for lines that no
 *  longer exist. (Reorders within the same line count are undetectable here;
 *  see the README's limitations.) */
function clampIEN(ien: IENValue[], slotText: string): IENValue[] {
  const trimmed = slotText.trim();
  const lineCount = trimmed ? trimmed.split("\n").length : 0;
  return ien.slice(0, lineCount);
}

// ---------------------------------------------------------------------------
// Content hash (FNV-1a) - cheap local-edit detector

export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// Filenames

export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "untitled";
}

/** YYYY-MM-DD prefix from a sprint filename, if any. */
export function dateFromFilename(name: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(name);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Sprint

function sprintListItem(index: number, text: string): string {
  const [first = "", ...rest] = text.trim().split("\n");
  const lines = [`${index}. ${first}`];
  for (const line of rest) lines.push(`   ${line}`);
  return lines.join("\n");
}

export function sprintToMarkdown(dto: SprintDTO): string {
  const fm = frontmatter([
    ["bw-type", "sprint"],
    ["bw-id", emitScalar(dto.id)],
    ["bw-date", emitScalar(dto.date)],
    ["bw-duration-sec", String(dto.durationSec)],
    ["bw-created", emitScalar(dto.createdAt)],
    ["bw-updated", emitScalar(dto.updatedAt)],
  ]);

  const jokes = dto.jokes.map((j) => j.trim()).filter((j) => j.length > 0);
  const body = [`# 10 in 10 — ${dto.date}`, ""];
  jokes.forEach((j, i) => body.push(sprintListItem(i + 1, j)));

  return fm + body.join("\n").trimEnd() + "\n";
}

function parseSprintBody(body: string): string[] {
  const lines = body.split("\n");
  const items: string[] = [];
  let cur: string | null = null;
  for (const raw of lines) {
    if (/^#{1,6}\s/.test(raw)) continue; // skip headings (incl. the H1 title)
    const m = /^\s*\d+\.\s+(.*)$/.exec(raw);
    if (m) {
      if (cur !== null) items.push(cur.trim());
      cur = m[1];
    } else if (cur !== null) {
      if (raw.trim() === "") {
        items.push(cur.trim());
        cur = null;
      } else {
        cur += "\n" + raw.trim();
      }
    }
  }
  if (cur !== null) items.push(cur.trim());

  const numbered = items.filter((s) => s.length > 0);
  if (numbered.length > 0) return numbered;

  // Fallback: a plain list of lines (someone typed jokes without numbering).
  return lines
    .filter((l) => !/^#{1,6}\s/.test(l) && l.trim().length > 0)
    .map((l) => l.replace(/^[-*]\s+/, "").trim());
}

export interface ParsedSprint {
  id?: string;
  date: string;
  durationSec?: number;
  jokes: string[];
}

export function parseSprintFile(content: string, fallbackDate: string): ParsedSprint {
  const { fm, body } = splitContent(content);
  const id = typeof fm["bw-id"] === "string" ? fm["bw-id"] : undefined;
  const fmDate = asStr(fm["bw-date"]);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(fmDate) ? fmDate : fallbackDate;
  return {
    id,
    date,
    durationSec: asNum(fm["bw-duration-sec"]),
    jokes: parseSprintBody(body),
  };
}

// ---------------------------------------------------------------------------
// Joke

interface JokeMeta {
  setupComponents?: string[];
  developmentComponents?: string[];
  punchlineComponents?: string[];
  setupChecklistDone?: string[];
  setupRhythm?: Rhythm;
  developmentRhythm?: Rhythm;
  punchlineRhythm?: Rhythm;
  setupIEN?: IENValue[];
  developmentIEN?: IENValue[];
  punchlineIEN?: IENValue[];
  additionalPunchlines?: AdditionalPunchlineDTO[];
}

/** One `- **VOICE** — line` bullet per IEN-tagged line of a slot. */
function voiceLines(text: string, ien: IENValue[] | undefined): string[] {
  if (!ien || !ien.some((v) => v)) return [];
  const lines = text.trim().split("\n");
  const out: string[] = [];
  lines.forEach((line, i) => {
    const tag = ien[i];
    if (tag) out.push(`- **${IEN_VOICE[tag]}** — ${line}`);
  });
  return out;
}

/**
 * Read-only `## Voices` section: shouts the Interior / Exterior / Narrator
 * voice of each tagged line. Derived from the IEN markup that round-trips in
 * `bw-meta`, so it's regenerated on every pull and ignored on parse (editing
 * voices happens in JokeBakery). Empty when no line carries a voice.
 */
function voicesSection(dto: JokeDTO): string[] {
  const slots: Array<[string, string, IENValue[] | undefined]> = [
    ["Setup", dto.setup, dto.setupIEN],
    ["Development", dto.development, dto.developmentIEN],
    ["Punchline", dto.punchline, dto.punchlineIEN],
  ];
  const blocks: string[] = [];
  for (const [name, text, ien] of slots) {
    const vl = voiceLines(text, ien);
    if (vl.length) blocks.push(`**${name}**`, "", ...vl, "");
  }
  if (!blocks.length) return [];
  return [
    "## Voices",
    "",
    "*Read-only — the Interior / Exterior / Narrator voice of each line. Edit in JokeBakery.*",
    "",
    ...blocks,
  ];
}

export function jokeToMarkdown(dto: JokeDTO): string {
  const meta: JokeMeta = {
    setupComponents: dto.setupComponents,
    developmentComponents: dto.developmentComponents,
    punchlineComponents: dto.punchlineComponents,
    setupChecklistDone: dto.setupChecklistDone,
    setupRhythm: dto.setupRhythm,
    developmentRhythm: dto.developmentRhythm,
    punchlineRhythm: dto.punchlineRhythm,
    setupIEN: dto.setupIEN,
    developmentIEN: dto.developmentIEN,
    punchlineIEN: dto.punchlineIEN,
    additionalPunchlines: dto.additionalPunchlines,
  };

  const fm = frontmatter([
    ["bw-type", "joke"],
    ["bw-id", emitScalar(dto.id)],
    ["bw-created", emitScalar(dto.createdAt)],
    ["bw-updated", emitScalar(dto.updatedAt)],
    ["title", emitScalar(dto.title)],
    ["premise", emitScalar(dto.premise)],
    ["key-words", emitArray(dto.keyWords)],
    ["stage", String(dto.stage)],
    ["families", emitArray(dto.families)],
    ["joke-type", emitScalar(dto.jokeType)],
    ["joke-function", emitScalar(dto.jokeFunction)],
    ["topic-tags", emitArray(dto.topicTags)],
    ["theme", emitScalar(dto.theme)],
    ["angle", emitScalar(dto.angle)],
    ["bw-meta", emitJson(meta)],
  ]);

  const body: string[] = [];
  const section = (heading: string, text: string) => {
    if (text && text.trim()) body.push(`## ${heading}`, "", text.trim(), "");
  };

  section("Setup", dto.setup);
  section("Development", dto.development);
  section("Punchline", dto.punchline);

  body.push(...voicesSection(dto));

  if (dto.lists.length > 0) {
    // Read-only references to the attached lists. Each list is its own note
    // under Lists/ - edit contents there; attach/detach in JokeBakery. Only
    // labels are rendered (no items) so this round-trips losslessly on push.
    body.push(
      "## Lists",
      "",
      `*Read-only — open the list notes under ${LISTS_SUBDIR}/ to edit; attach/detach in JokeBakery.*`,
      ""
    );
    for (const l of dto.lists) body.push(`- ${l.label}`);
    body.push("");
  }

  section("Notes", dto.notes);
  section("Performance notes", dto.performanceNotes);
  section("Scratchpad", dto.scratchpad);

  const alts = dto.additionalPunchlines.filter((p) => p.text.trim());
  if (alts.length > 0) {
    body.push("## Alternative punchlines", "", "*Read-only — manage in JokeBakery.*", "");
    alts.forEach((p, i) => body.push(`### Alt ${i + 1}`, "", p.text.trim(), ""));
  }

  if (dto.setupVersions.length > 0) {
    body.push("## Setup versions", "", "*Read-only history from JokeBakery.*", "");
    dto.setupVersions.forEach((v, i) => body.push(`### v${i + 1}`, "", v.text.trim(), ""));
  }

  return fm + body.join("\n").trimEnd() + "\n";
}

/** Split a body into level-2 sections keyed by lowercased heading text. */
function parseBodySections(body: string): Record<string, string> {
  const map: Record<string, string> = {};
  let heading: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (heading !== null) map[heading] = buf.join("\n").trim();
    buf = [];
  };
  for (const raw of body.split("\n")) {
    const h = /^##\s+(.*)$/.exec(raw);
    if (h) {
      flush();
      heading = h[1].trim().toLowerCase();
      continue;
    }
    if (heading !== null) buf.push(raw);
  }
  flush();
  return map;
}

/**
 * Parse the joke's read-only `## Lists` reference section - one `- label` per
 * attached list (items live in the lists' own notes). Labels only, so the joke
 * push round-trips losslessly. The italic "Read-only…" hint line is ignored.
 */
function parseListReferences(
  block: string | undefined
): Array<{ label: string; items: ListItemDTO[] }> {
  if (!block) return [];
  const out: Array<{ label: string; items: ListItemDTO[] }> = [];
  for (const raw of block.split("\n")) {
    const item = /^[-*]\s+(.*)$/.exec(raw);
    if (!item) continue;
    const label = item[1].trim();
    if (label) out.push({ label, items: [] });
  }
  return out;
}

/** Parsed joke fields, ready for the sync engine to attach ref/baseUpdatedAt. */
export type ParsedJoke = Omit<JokePush, "ref" | "baseUpdatedAt">;

export function parseJokeFile(content: string): ParsedJoke {
  const { fm, body } = splitContent(content);
  const sections = parseBodySections(body);

  let meta: JokeMeta = {};
  if (typeof fm["bw-meta"] === "string") {
    try {
      meta = JSON.parse(fm["bw-meta"]) as JokeMeta;
    } catch {
      meta = {};
    }
  }

  const setup = sections["setup"] ?? "";
  const development = sections["development"] ?? "";
  const punchline = sections["punchline"] ?? "";
  const notes = sections["notes"] ?? "";
  const performanceNotes = sections["performance notes"] ?? "";
  let scratchpad = sections["scratchpad"] ?? "";

  // A new joke note with prose but no recognized headings: keep the text rather
  // than discard it - drop it in the scratchpad, mirroring "promote to joke".
  const recognizedKeys = [
    "setup",
    "development",
    "punchline",
    "notes",
    "performance notes",
    "scratchpad",
    "lists",
    "voices",
  ];
  const hasRecognized = recognizedKeys.some((k) => sections[k] !== undefined);
  if (!hasRecognized && body.trim()) {
    scratchpad = body.trim();
  }

  return {
    id: typeof fm["bw-id"] === "string" ? fm["bw-id"] : undefined,
    title: asStr(fm["title"]) || undefined,
    premise: asStr(fm["premise"]),
    keyWords: asStrArr(fm["key-words"]),
    stage: asNum(fm["stage"]),
    families: asStrArr(fm["families"]),
    jokeType: asStr(fm["joke-type"]),
    jokeFunction: asStr(fm["joke-function"]),
    topicTags: asStrArr(fm["topic-tags"]),
    theme: asStr(fm["theme"]),
    angle: asStr(fm["angle"]),
    setup,
    development,
    punchline,
    scratchpad,
    notes,
    performanceNotes,
    // Read-only references; the server ignores them on a joke push (lists are
    // their own synced entity). Parsed only so they round-trip in the file.
    lists: parseListReferences(sections["lists"]),
    setupComponents: meta.setupComponents ?? [],
    developmentComponents: meta.developmentComponents ?? [],
    punchlineComponents: meta.punchlineComponents ?? [],
    setupChecklistDone: meta.setupChecklistDone ?? [],
    setupRhythm: asRhythm(meta.setupRhythm),
    developmentRhythm: asRhythm(meta.developmentRhythm),
    punchlineRhythm: asRhythm(meta.punchlineRhythm),
    setupIEN: clampIEN(asIEN(meta.setupIEN), setup),
    developmentIEN: clampIEN(asIEN(meta.developmentIEN), development),
    punchlineIEN: clampIEN(asIEN(meta.punchlineIEN), punchline),
    additionalPunchlines: Array.isArray(meta.additionalPunchlines)
      ? meta.additionalPunchlines
      : [],
  };
}

/** Read the raw frontmatter map (typed values) without parsing the body. */
export function peekFrontmatter(content: string): Record<string, unknown> {
  return splitContent(content).fm;
}

/**
 * Strip JokeBakery identity (`bw-*` keys) so a (conflict) copy isn't re-synced,
 * while keeping the user-facing properties (title, stage, families, …) - the
 * copy exists precisely to preserve the losing version for a hand-merge.
 * Textual filtering keeps whatever formatting the file already had; a dropped
 * key's block-style continuation lines go with it.
 */
export function stripSyncIdentity(content: string): string {
  if (!content.startsWith("---")) return content;
  const lines = content.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return content;

  const kept: string[] = [];
  let dropping = false;
  for (const line of lines.slice(1, end)) {
    const key = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (key) dropping = key[1].startsWith("bw-");
    if (!dropping) kept.push(line);
  }
  const body = lines.slice(end + 1).join("\n").replace(/^\n+/, "");
  if (kept.length === 0) return body;
  return ["---", ...kept, "---", "", body].join("\n");
}

// ---------------------------------------------------------------------------
// List (its own note under Lists/)

export function listToMarkdown(dto: ListDTO): string {
  const fm = frontmatter([
    ["bw-type", "list"],
    ["bw-id", emitScalar(dto.id)],
    ["bw-created", emitScalar(dto.createdAt)],
    ["bw-updated", emitScalar(dto.updatedAt)],
    ["label", emitScalar(dto.label)],
  ]);

  const body: string[] = [`# ${dto.label}`, ""];
  if (dto.items.length === 0) body.push("*(empty)*");
  // Each item carries its stable id as an Obsidian block reference (`^id`), so
  // crashes that link to it survive edits and round-trip through the vault.
  // Afterthoughts hang under their item as indented sub-bullets (also id-tagged).
  else
    for (const it of dto.items) {
      body.push(`- ${it.text} ^${it.id}`);
      for (const a of it.afterthoughts ?? [])
        body.push(`    - ${a.text} ^${a.id}`);
    }

  return fm + body.join("\n").trimEnd() + "\n";
}

export interface ParsedList {
  id?: string;
  label: string;
  items: ListItemDTO[];
}

/**
 * Parse a list note: `label` from frontmatter (falling back to the filename),
 * items from the body's bullet list. Each bullet may carry a trailing block
 * reference (`- text ^id`); bullets a human typed without one get a fresh id.
 * Headings (incl. the H1 title) and the `*(empty)*` placeholder are ignored.
 *
 * An *indented* bullet is an afterthought of the most recent top-level item -
 * the riff chain ("Cat" -> "dog" -> "bone"). An indented bullet with no item
 * above it (a malformed file) is promoted to a top-level item so nothing is lost.
 */
export function parseListFile(content: string, fallbackLabel: string): ParsedList {
  const { fm, body } = splitContent(content);
  const id = typeof fm["bw-id"] === "string" ? fm["bw-id"] : undefined;
  const label = asStr(fm["label"]).trim() || fallbackLabel;

  const items: ListItemDTO[] = [];
  for (const raw of body.split("\n")) {
    if (/^\s*#{1,6}\s/.test(raw)) continue;
    // Capture leading whitespace so we can tell a top-level item from an
    // indented afterthought.
    const m = /^(\s*)[-*]\s+(.*)$/.exec(raw);
    if (!m) continue;
    const indented = m[1].length > 0;
    // Pull a trailing `^id` block ref off the line *before* trimming, so a real
    // id isn't lost and stray text isn't mistaken for one.
    const rest = m[2];
    const ref = /^(.*?)\s+\^([A-Za-z0-9-]+)\s*$/.exec(rest);
    const text = (ref ? ref[1] : rest).trim();
    if (!text || text === "*(empty)*") continue;
    const node: ListItemDTO = { id: ref ? ref[2] : newItemId(), text };

    const parent = items[items.length - 1];
    if (indented && parent) {
      (parent.afterthoughts ??= []).push(node);
    } else {
      items.push(node);
    }
  }

  return { id, label, items };
}

// ---------------------------------------------------------------------------
// Crash (a link between two list items, its own note under Crashes/)

export function crashToMarkdown(dto: CrashDTO): string {
  const fm = frontmatter([
    ["bw-type", "crash"],
    ["bw-id", emitScalar(dto.id)],
    ["bw-created", emitScalar(dto.createdAt)],
    ["bw-updated", emitScalar(dto.updatedAt)],
    ["a-list", emitScalar(dto.aListId)],
    ["a-item", emitScalar(dto.aItemId)],
    ["b-list", emitScalar(dto.bListId)],
    ["b-item", emitScalar(dto.bItemId)],
  ]);

  const body: string[] = [
    `# ${dto.aText} ⚡ ${dto.bText}`,
    "",
    // Obsidian links straight to the linked block in each list note.
    `- [[${dto.aLabel}#^${dto.aItemId}]] — ${dto.aText}`,
    `- [[${dto.bLabel}#^${dto.bItemId}]] — ${dto.bText}`,
    "",
  ];
  if (dto.note.trim()) {
    body.push("## Note", "", dto.note.trim(), "");
  }

  return fm + body.join("\n").trimEnd() + "\n";
}

export interface ParsedCrash {
  id?: string;
  aListId: string;
  aItemId: string;
  aLabel: string;
  aText: string;
  bListId: string;
  bItemId: string;
  bLabel: string;
  bText: string;
  note: string;
}

/** Parse a crash note. Canonical ids come from frontmatter; the labels and item
 *  text are recovered from the two `- [[label#^id]] — text` bullets (positional:
 *  first is the A side, second is B). The note is the `## Note` section, if any. */
export function parseCrashFile(content: string): ParsedCrash {
  const { fm, body } = splitContent(content);
  const id = typeof fm["bw-id"] === "string" ? fm["bw-id"] : undefined;

  const bulletRe = /^[-*]\s+\[\[(.+?)#\^([A-Za-z0-9-]+)\]\]\s*—\s*(.*)$/;
  const sides: Array<{ label: string; itemId: string; text: string }> = [];
  let inNote = false;
  const noteLines: string[] = [];
  for (const raw of body.split("\n")) {
    if (/^##\s+Note\s*$/.test(raw)) {
      inNote = true;
      continue;
    }
    if (inNote) {
      noteLines.push(raw);
      continue;
    }
    const m = bulletRe.exec(raw.trim());
    if (m) sides.push({ label: m[1].trim(), itemId: m[2], text: m[3].trim() });
  }

  const a = sides[0];
  const b = sides[1];
  return {
    id,
    aListId: asStr(fm["a-list"]),
    aItemId: asStr(fm["a-item"]) || a?.itemId || "",
    aLabel: a?.label ?? "",
    aText: a?.text ?? "",
    bListId: asStr(fm["b-list"]),
    bItemId: asStr(fm["b-item"]) || b?.itemId || "",
    bLabel: b?.label ?? "",
    bText: b?.text ?? "",
    note: noteLines.join("\n").trim(),
  };
}

// ---------------------------------------------------------------------------
// Ideas inbox (a single note, Ideas.md, at the sync folder root)

export function ideasToMarkdown(dto: IdeasDocDTO): string {
  const fm = frontmatter([
    ["bw-type", "ideas"],
    ["bw-id", emitScalar(dto.id)],
    ["bw-created", emitScalar(dto.createdAt)],
    ["bw-updated", emitScalar(dto.updatedAt)],
  ]);

  const body: string[] = ["# Ideas", ""];
  if (dto.items.length === 0) body.push("*(empty)*");
  // Same bullet contract as list notes: the stable id rides as an Obsidian
  // block reference. New bullets typed by hand get ids minted on parse.
  else for (const it of dto.items) body.push(`- ${it.text} ^${it.id}`);

  return fm + body.join("\n").trimEnd() + "\n";
}

export interface ParsedIdeas {
  id?: string;
  items: { id: string; text: string }[];
}

/** Parse Ideas.md. Every bullet (indented or not) is an idea - the inbox is
 *  flat. Bullets without a trailing `^id` get a fresh one. Headings and the
 *  `*(empty)*` placeholder are ignored. */
export function parseIdeasFile(content: string): ParsedIdeas {
  const { fm, body } = splitContent(content);
  const id = typeof fm["bw-id"] === "string" ? fm["bw-id"] : undefined;

  const items: { id: string; text: string }[] = [];
  for (const raw of body.split("\n")) {
    if (/^\s*#{1,6}\s/.test(raw)) continue;
    const m = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (!m) continue;
    const rest = m[1];
    const ref = /^(.*?)\s+\^([A-Za-z0-9-]+)\s*$/.exec(rest);
    const text = (ref ? ref[1] : rest).trim();
    if (!text || text === "*(empty)*") continue;
    items.push({ id: ref ? ref[2] : newItemId(), text });
  }
  return { id, items };
}

export { type SprintPush, type JokePush };
