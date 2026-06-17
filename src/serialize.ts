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
 *     and ignored on parse (managed in BakerWriter).
 *
 * Identity lives in frontmatter `bw-id`, never the filename - so renaming a
 * file in Obsidian doesn't break the link.
 */
import type {
  AdditionalPunchlineDTO,
  IENValue,
  JokeDTO,
  JokePush,
  ListDTO,
  Rhythm,
  SprintDTO,
  SprintPush,
} from "./types";

export const SPRINTS_SUBDIR = "Sprints";
export const JOKES_SUBDIR = "Jokes";
export const LISTS_SUBDIR = "Lists";
export const CONFLICTS_SUBDIR = "Conflicts";

const EMPTY_RHYTHM: Rhythm = { keys: [], colours: [] };

// ---------------------------------------------------------------------------
// Tiny YAML emit/parse (only the subset we produce)

function emitScalar(s: string): string {
  if (s === "") return "''";
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

function splitContent(content: string): { fm: Record<string, unknown>; body: string } {
  if (!content.startsWith("---")) return { fm: {}, body: content };
  const lines = content.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { fm: {}, body: content };

  const fm: Record<string, unknown> = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fm[line.slice(0, idx).trim()] = parseYamlValue(line.slice(idx + 1));
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
  return m ? m[1]! : null;
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
      cur = m[1]!;
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
  const id = typeof fm["bw-id"] === "string" ? (fm["bw-id"] as string) : undefined;
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

  if (dto.lists.length > 0) {
    // Read-only references to the attached lists. Each list is its own note
    // under Lists/ - edit contents there; attach/detach in BakerWriter. Only
    // labels are rendered (no items) so this round-trips losslessly on push.
    body.push(
      "## Lists",
      "",
      `*Read-only — open the list notes under ${LISTS_SUBDIR}/ to edit; attach/detach in BakerWriter.*`,
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
    body.push("## Alternative punchlines", "", "*Read-only — manage in BakerWriter.*", "");
    alts.forEach((p, i) => body.push(`### Alt ${i + 1}`, "", p.text.trim(), ""));
  }

  if (dto.setupVersions.length > 0) {
    body.push("## Setup versions", "", "*Read-only history from BakerWriter.*", "");
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
      heading = h[1]!.trim().toLowerCase();
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
): Array<{ label: string; items: string[] }> {
  if (!block) return [];
  const out: Array<{ label: string; items: string[] }> = [];
  for (const raw of block.split("\n")) {
    const item = /^[-*]\s+(.*)$/.exec(raw);
    if (!item) continue;
    const label = item[1]!.trim();
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
      meta = JSON.parse(fm["bw-meta"] as string) as JokeMeta;
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
  ];
  const hasRecognized = recognizedKeys.some((k) => sections[k] !== undefined);
  if (!hasRecognized && body.trim()) {
    scratchpad = body.trim();
  }

  return {
    id: typeof fm["bw-id"] === "string" ? (fm["bw-id"] as string) : undefined,
    title: asStr(fm["title"]) || undefined,
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
    setupIEN: asIEN(meta.setupIEN),
    developmentIEN: asIEN(meta.developmentIEN),
    punchlineIEN: asIEN(meta.punchlineIEN),
    additionalPunchlines: Array.isArray(meta.additionalPunchlines)
      ? meta.additionalPunchlines
      : [],
  };
}

/** Read the raw frontmatter map (typed values) without parsing the body. */
export function peekFrontmatter(content: string): Record<string, unknown> {
  return splitContent(content).fm;
}

/** Strip BakerWriter identity so a (conflict) copy isn't re-synced. */
export function stripSyncIdentity(content: string): string {
  const { body } = splitContent(content);
  return body;
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
  else for (const it of dto.items) body.push(`- ${it}`);

  return fm + body.join("\n").trimEnd() + "\n";
}

export interface ParsedList {
  id?: string;
  label: string;
  items: string[];
}

/**
 * Parse a list note: `label` from frontmatter (falling back to the filename),
 * items from the body's bullet list. Headings (incl. the H1 title) and the
 * `*(empty)*` placeholder are ignored.
 */
export function parseListFile(content: string, fallbackLabel: string): ParsedList {
  const { fm, body } = splitContent(content);
  const id = typeof fm["bw-id"] === "string" ? (fm["bw-id"] as string) : undefined;
  const label = asStr(fm["label"]).trim() || fallbackLabel;

  const items: string[] = [];
  for (const raw of body.split("\n")) {
    if (/^#{1,6}\s/.test(raw)) continue;
    const m = /^[-*]\s+(.*)$/.exec(raw);
    if (!m) continue;
    const t = m[1]!.trim();
    if (t && t !== "*(empty)*") items.push(t);
  }

  return { id, label, items };
}

export { type SprintPush, type JokePush };
