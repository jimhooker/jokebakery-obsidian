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
import { JOKE_STATUSES } from "./types";
import type {
  AdditionalPunchlineDTO,
  CrashDTO,
  GigDTO,
  GigLineupPush,
  GigPush,
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

/**
 * Mint an id client-side. Mirrors src/lib/id.ts in the app.
 *
 * Used for two things: bullets a human typed straight into Obsidian (no `^id`
 * yet), and new NOTES, so a create carries its id up front. The server treats
 * "create" as "no row exists for this id" rather than "the client sent no
 * id", so sending one makes a create idempotent - which is what lets a push be
 * safely retried after a timeout without risking a duplicate.
 */
export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 14);
}

/**
 * Does this file name look like a COPY a file-sync tool made of a note, rather
 * than a note the user keeps?
 *
 * Syncthing, Dropbox and the like leave a duplicate beside the original when
 * two devices edited it. The duplicate carries the same `bw-id` frontmatter, so
 * to the sync engine it reads as a second file for one entity, and the pair
 * take turns pushing over each other (see scanLocalFiles). A copy is never the
 * file we sync, so it is skipped entirely - never pushed, never deleted, left
 * for the user to merge and remove by hand.
 *
 * Deliberately NOT matched: iCloud's `Note 2.md`. That pattern is far too close
 * to names people genuinely use ("Set 2"), and ignoring a real note is worse
 * than syncing a stray copy - the id-level guard catches those anyway.
 */
export function isFileSyncConflictCopy(basename: string): boolean {
  return (
    // Syncthing: `Note.sync-conflict-20260721-100720-2QQTU7R`
    /\.sync-conflict-\d{8}-\d{6}-\w+$/i.test(basename) ||
    // Dropbox: `Note (jim's conflicted copy 2026-07-21)`
    /\([^()]*conflicted copy[^()]*\)$/i.test(basename) ||
    // Obsidian Sync, and the copies this plugin writes itself
    /\(conflict\b[^()]*\)$/i.test(basename)
  );
}

export const SPRINTS_SUBDIR = "Sprints";
export const JOKES_SUBDIR = "Jokes";
export const LISTS_SUBDIR = "Lists";
export const CONFLICTS_SUBDIR = "Conflicts";
export const CRASHES_SUBDIR = "Crashes";
export const GIGS_SUBDIR = "Gigs";
export const IDEAS_FILENAME = "Ideas.md";

const EMPTY_RHYTHM: Rhythm = { keys: [], colours: [] };

/** The IEN voice names, shouted. Mirrors IEN_LABELS in src/lib/ien-meta.ts.
 *  "O" (Other) is the fourth voice and must be listed here: a missing entry
 *  renders `**undefined**` in the Voices section. */
const IEN_VOICE: Record<"I" | "E" | "N" | "O", string> = {
  I: "INTERIOR",
  E: "EXTERIOR",
  N: "NARRATOR",
  O: "OTHER",
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

/** Emit a frontmatter block. A pair whose value is `undefined` is OMITTED -
 *  see JokeNote for why "we don't know this value" has to stay distinct from
 *  "this value is empty". */
function frontmatter(pairs: Array<[string, string | undefined]>): string {
  const kept = pairs.filter((p): p is [string, string] => p[1] !== undefined);
  return "---\n" + kept.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n---\n\n";
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
/** Coerce a stored IEN array. Anything that isn't a known voice becomes null -
 *  so this list MUST include every voice the app can set, or syncing a joke
 *  back from the vault silently strips the ones missing here. */
function asIEN(v: unknown): IENValue[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) =>
    x === "I" || x === "E" || x === "N" || x === "O" ? x : null
  );
}

function asNumArr(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is number => typeof x === "number" && isFinite(x));
}

/**
 * Read a frontmatter key ONLY if it is actually present.
 *
 * This is the whole defence against silent server-side wipes. Every push field
 * is optional, and the server applies any field that isn't `undefined`. A vault
 * note written before a field existed simply has no such key, and coercing that
 * absence to `""`/`[]` would push a real "clear this" instruction and destroy a
 * value the user set on the web. Absent MUST stay absent.
 */
function strIfPresent(fm: Record<string, unknown>, key: string): string | undefined {
  return key in fm ? asStr(fm[key]) : undefined;
}

function strArrIfPresent(
  fm: Record<string, unknown>,
  key: string
): string[] | undefined {
  return key in fm ? asStrArr(fm[key]) : undefined;
}

/**
 * Coerce a hand-editable status. The server takes a zod ENUM here and one bad
 * value 400s the whole push - every joke, list and sprint in the batch - so an
 * unrecognized status is dropped (leaving the server's value alone) rather
 * than sent. An explicitly empty value clears it.
 */
function asStatus(v: unknown): string | null | undefined {
  if (v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (s === "") return null;
  return (JOKE_STATUSES as readonly string[]).includes(s) ? s : undefined;
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
  setupBreaths?: number[];
  developmentBreaths?: number[];
  punchlineBreaths?: number[];
  additionalPunchlines?: AdditionalPunchlineDTO[];
}

/**
 * Frontmatter keys whose value can be genuinely UNKNOWN when we re-write a
 * note after pushing it: the file never carried the key, so we didn't parse a
 * value and must not invent one. Emitting a fabricated `''` here would put a
 * real empty value in the file, and the NEXT push would then send it as
 * "clear this" and wipe whatever the user had set on the web. Undefined =
 * leave the key out. A DTO pulled from the server has all of them.
 */
type OptionalNoteKeys =
  | "title"
  | "premise"
  | "hinge"
  | "keyWords"
  | "stage"
  | "families"
  | "jokeType"
  | "jokeFunction"
  | "topicTags"
  | "theme"
  | "angle"
  | "status";

export type JokeNote = Omit<JokeDTO, OptionalNoteKeys> &
  Partial<Pick<JokeDTO, OptionalNoteKeys>>;

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
 * Read-only `## Voices` section: shouts the Interior / Exterior / Narrator /
 * Other voice of each tagged line. Derived from the IEN markup that round-trips
 * in `bw-meta`, so it's regenerated on every pull and ignored on parse (editing
 * voices happens in JokeBakery). Empty when no line carries a voice.
 */
function voicesSection(dto: JokeNote): string[] {
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
    "*Read-only — the Interior / Exterior / Narrator / Other voice of each line. Edit in JokeBakery.*",
    "",
    ...blocks,
  ];
}

/** Apply an emitter to a value only when it's known; undefined omits the key. */
function opt<T>(v: T | undefined, emit: (v: T) => string): string | undefined {
  return v === undefined ? undefined : emit(v);
}

export function jokeToMarkdown(dto: JokeNote): string {
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
    setupBreaths: dto.setupBreaths,
    developmentBreaths: dto.developmentBreaths,
    punchlineBreaths: dto.punchlineBreaths,
    additionalPunchlines: dto.additionalPunchlines,
  };

  const fm = frontmatter([
    ["bw-type", "joke"],
    ["bw-id", emitScalar(dto.id)],
    ["bw-created", emitScalar(dto.createdAt)],
    ["bw-updated", emitScalar(dto.updatedAt)],
    ["title", opt(dto.title, emitScalar)],
    ["premise", opt(dto.premise, emitScalar)],
    ["hinge", opt(dto.hinge, emitScalar)],
    ["key-words", opt(dto.keyWords, emitArray)],
    ["stage", opt(dto.stage, String)],
    // Null status = "none set". Omitted rather than emitted as empty, so the
    // note stays tidy; setting `status: hit` by hand still applies it, and an
    // explicitly empty `status:` clears it.
    ["status", dto.status ? emitScalar(dto.status) : undefined],
    ["families", opt(dto.families, emitArray)],
    ["joke-type", opt(dto.jokeType, emitScalar)],
    ["joke-function", opt(dto.jokeFunction, emitScalar)],
    ["topic-tags", opt(dto.topicTags, emitArray)],
    ["theme", opt(dto.theme, emitScalar)],
    ["angle", opt(dto.angle, emitScalar)],
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

  const id = typeof fm["bw-id"] === "string" ? fm["bw-id"] : undefined;

  let meta: JokeMeta | null = null;
  if (typeof fm["bw-meta"] === "string") {
    try {
      meta = JSON.parse(fm["bw-meta"]) as JokeMeta;
    } catch {
      meta = null;
    }
  }

  // `bw-meta` carries everything that has no readable representation in the
  // note: components, rhythm, IEN, breaths, alternative punchlines. If it is
  // missing or unreadable on a joke we've ALREADY synced, that is damage (a
  // mangled property block, a hand-copied file), not an instruction - pushing
  // the zeroed arrays would wipe every mark the user made in the app. Send
  // nothing for those fields and let the server keep what it has. A brand new
  // note has no id, so it still gets proper empty defaults on create.
  const metaLost = meta === null && id !== undefined;
  const m = meta ?? {};
  const metaArr = <T>(v: T[] | undefined, fallback: T[]): T[] | undefined =>
    metaLost ? undefined : (v ?? fallback);

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

  // EVERY frontmatter-derived field below is presence-checked (see
  // strIfPresent): a key the note doesn't carry must push as `undefined`, not
  // as a fabricated empty that the server would apply as "clear this".
  return {
    id,
    title: asStr(fm["title"]) || undefined,
    premise: strIfPresent(fm, "premise"),
    hinge: strIfPresent(fm, "hinge"),
    keyWords: strArrIfPresent(fm, "key-words"),
    stage: asNum(fm["stage"]),
    status: "status" in fm ? asStatus(fm["status"]) : undefined,
    families: strArrIfPresent(fm, "families"),
    jokeType: strIfPresent(fm, "joke-type"),
    jokeFunction: strIfPresent(fm, "joke-function"),
    topicTags: strArrIfPresent(fm, "topic-tags"),
    theme: strIfPresent(fm, "theme"),
    angle: strIfPresent(fm, "angle"),
    // Body sections are different: the prose IS the editable surface, so a
    // deleted `## Notes` section really does mean "clear the notes".
    setup,
    development,
    punchline,
    scratchpad,
    notes,
    performanceNotes,
    // Read-only references; the server ignores them on a joke push (lists are
    // their own synced entity). Parsed only so they round-trip in the file.
    lists: parseListReferences(sections["lists"]),
    setupComponents: metaArr(m.setupComponents, []),
    developmentComponents: metaArr(m.developmentComponents, []),
    punchlineComponents: metaArr(m.punchlineComponents, []),
    setupChecklistDone: metaArr(m.setupChecklistDone, []),
    setupRhythm: metaLost ? undefined : asRhythm(m.setupRhythm),
    developmentRhythm: metaLost ? undefined : asRhythm(m.developmentRhythm),
    punchlineRhythm: metaLost ? undefined : asRhythm(m.punchlineRhythm),
    setupIEN: metaLost ? undefined : clampIEN(asIEN(m.setupIEN), setup),
    developmentIEN: metaLost
      ? undefined
      : clampIEN(asIEN(m.developmentIEN), development),
    punchlineIEN: metaLost
      ? undefined
      : clampIEN(asIEN(m.punchlineIEN), punchline),
    // Breaths are word-index arrays like rhythm, not line-parallel like IEN,
    // so they round-trip opaquely with no clamping.
    setupBreaths: metaLost ? undefined : asNumArr(m.setupBreaths),
    developmentBreaths: metaLost ? undefined : asNumArr(m.developmentBreaths),
    punchlineBreaths: metaLost ? undefined : asNumArr(m.punchlineBreaths),
    additionalPunchlines: metaArr(
      Array.isArray(m.additionalPunchlines) ? m.additionalPunchlines : undefined,
      []
    ),
  };
}

/** Read the raw frontmatter map (typed values) without parsing the body. */
export function peekFrontmatter(content: string): Record<string, unknown> {
  return splitContent(content).fm;
}

/**
 * Has this joke note lost its `bw-meta`?
 *
 * True only for a note that IS already synced (it has a `bw-id`) but whose
 * meta blob is missing or unreadable - damage, not an edit. parseJokeFile
 * responds by pushing nothing for the fields that live in there, so the server
 * keeps them; the sync engine then uses this to force the note to be re-pulled
 * from server truth, so the damaged file is repaired rather than left to be
 * rewritten from the empty defaults it currently parses to.
 */
export function jokeMetaLost(content: string): boolean {
  const fm = splitContent(content).fm;
  if (typeof fm["bw-id"] !== "string") return false;
  if (typeof fm["bw-meta"] !== "string") return true;
  try {
    JSON.parse(fm["bw-meta"]);
    return false;
  } catch {
    return true;
  }
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

/**
 * Structural nesting id regexes. MUST stay in lockstep with src/lib/list-md.ts
 * in the app (this plugin is a separate esbuild project and cannot import it).
 */
const LIST_ID = "[A-Za-z0-9-]+";
const LIST_PARENT_RE = new RegExp(`^(.*?)\\s+\\^\\^(${LIST_ID})\\s*$`);
const LIST_REF_RE = new RegExp(`^(.*?)\\s+\\^(${LIST_ID})\\s*$`);

interface ListTreeNode {
  item: ListItemDTO;
  children: ListTreeNode[];
}

/** Adjacency list -> ordered nested tree (mirror of src/lib/list-tree.ts
 *  buildTree). Orphans (missing/dangling parentId) hoist to top level; siblings
 *  keep array order. */
function buildListTree(items: ListItemDTO[]): ListTreeNode[] {
  const byId = new Map(items.map((it) => [it.id, it]));
  const nodes = new Map<string, ListTreeNode>(
    items.map((it) => [it.id, { item: it, children: [] }])
  );
  const roots: ListTreeNode[] = [];
  for (const it of items) {
    const pid = it.parentId ?? null;
    const parent = pid && byId.has(pid) ? nodes.get(pid) : undefined;
    if (parent && pid !== it.id) parent.children.push(nodes.get(it.id)!);
    else roots.push(nodes.get(it.id)!);
  }
  return roots;
}

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
  // Structural children (sync v5) nest 2 spaces per depth and carry an explicit
  // trailing `^^<parentId>` token; a flat list (no parentId) emits neither the
  // extra indent nor the token, so existing vault notes stay byte-identical.
  else {
    const walk = (nodes: ListTreeNode[], depth: number): void => {
      for (const node of nodes) {
        const it = node.item;
        const pad = "  ".repeat(depth);
        const parentTok = depth > 0 && it.parentId ? ` ^^${it.parentId}` : "";
        body.push(`${pad}- ${it.text} ^${it.id}${parentTok}`);
        for (const a of it.afterthoughts ?? [])
          body.push(`    - ${a.text} ^${a.id}`);
        walk(node.children, depth + 1);
      }
    };
    walk(buildListTree(dto.items), 0);
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
 * A structural child (sync v5) carries an explicit trailing `^^<parentId>`
 * token; its `parentId` is read straight from that token (indentation is
 * cosmetic). A bullet with no `^^` token that is *indented* is an afterthought
 * of the most recent top-level item - the riff chain ("Cat" -> "dog" -> "bone").
 * An indented bullet with no item above it (a malformed file) is promoted to a
 * top-level item so nothing is lost.
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
    let rest = m[2];

    // 1. Pull a trailing `^^<parentId>` (structural nesting) off first, so the
    //    single-caret block-ref match below can't mistake it for the id.
    let parentId: string | null = null;
    const pm = LIST_PARENT_RE.exec(rest);
    if (pm) {
      parentId = pm[2];
      rest = pm[1];
    }

    // 2. Pull a trailing `^id` block ref off *before* trimming, so a real id
    //    isn't lost and stray text isn't mistaken for one.
    const ref = LIST_REF_RE.exec(rest);
    const text = (ref ? ref[1] : rest).trim();
    if (!text || text === "*(empty)*") continue;
    const node: ListItemDTO = { id: ref ? ref[2] : newId(), text };

    if (parentId !== null) {
      node.parentId = parentId;
      items.push(node);
    } else if (indented && items.length > 0) {
      (items[items.length - 1]!.afterthoughts ??= []).push(node);
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
// Gig (one performance of a set, its own note under Gigs/)
//
// A gig is BORN IN THE APP - it's the snapshot of a set's lineup taken on the
// night - so this note is an outcome/debrief surface, never a create path. The
// date, the set it came from, the running order and which jokes were in it are
// all read-only here; what you can edit is how it went.
//
// Every editable field is length/range/enum constrained server-side, and ONE
// bad value 400s the entire push (every joke, list and sprint in the same
// batch, not just this gig). So parseGigFile validates before sending and
// DROPS anything that wouldn't pass, reporting it as a warning rather than
// letting a typo take the whole sync down.

/** Laugh-type slugs and their labels. Mirrors data/laugh-types.json in the app
 *  (this plugin is a separate esbuild project and can't import it). Notes are
 *  written with the labels; parsing accepts either, case-insensitively. The
 *  server silently drops slugs it doesn't recognize, so an unknown one here is
 *  reported to the user instead of vanishing. */
const LAUGH_LABELS: Record<string, string> = {
  applausebreak: "Applause break",
  rolling: "Rolling",
  recognition: "Recognition",
  titter: "Titter",
  groan: "Groan",
  gasp: "Gasp",
  cheer: "Cheer",
  silence: "Silence",
};

const LAUGH_SLUG_BY_NAME = new Map<string, string>();
for (const [slug, label] of Object.entries(LAUGH_LABELS)) {
  LAUGH_SLUG_BY_NAME.set(slug, slug);
  LAUGH_SLUG_BY_NAME.set(label.toLowerCase(), slug);
}

export const LAUGH_HINT = Object.values(LAUGH_LABELS).join(", ");

/** Resolves a joke id to display text for the lineup - a `[[wikilink]]` when
 *  that joke is synced into this vault, else something human-readable. Only
 *  the trailing `^id` is read back on parse, so this text is free to change. */
export type JokeLinker = (jokeId: string) => string;

function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

/** Emit a nullable number: null becomes an empty scalar, which parses back to
 *  null (i.e. "clear this"), keeping the field hand-editable. */
function emitNullableNum(n: number | null): string {
  return n === null ? "''" : String(n);
}

/** Read a nullable, range-checked integer. Returns `undefined` for anything
 *  the server would reject, so a typo drops the one field instead of 400ing
 *  the whole push. */
function asNullableInt(
  v: unknown,
  min: number,
  max: number
): number | null | undefined {
  if (v === null || v === "") return null;
  if (typeof v !== "number" || !Number.isInteger(v)) return undefined;
  return v >= min && v <= max ? v : undefined;
}

export function gigToMarkdown(dto: GigDTO, jokeLink: JokeLinker): string {
  const fm = frontmatter([
    ["bw-type", "gig"],
    ["bw-id", emitScalar(dto.id)],
    ["bw-created", emitScalar(dto.createdAt)],
    ["bw-updated", emitScalar(dto.updatedAt)],
    // Read-only provenance: the gig is a snapshot of this set on this date.
    ["bw-set", emitScalar(dto.setId)],
    ["bw-date", emitScalar(dto.date)],
    ["set-title", emitScalar(dto.setTitle)],
    ["planned-minutes", emitNullableNum(dto.plannedMinutes)],
    // Editable.
    ["venue", emitScalar(dto.venue)],
    ["bill-position", emitScalar(dto.billPosition)],
    ["followed", emitScalar(dto.followed)],
    ["vibe", emitScalar(dto.vibe)],
    ["crowd", emitScalar(dto.crowd)],
    ["actual-minutes", emitNullableNum(dto.actualMinutes)],
    ["first-applause-seconds", emitNullableNum(dto.firstApplauseSeconds)],
    ["recording-url", emitScalar(dto.recordingUrl ?? "")],
    ["recording-reviewed", String(dto.recordingReviewed)],
  ]);

  const body: string[] = [
    `# ${dto.venue || "Gig"} — ${dto.date}`,
    "",
    "## Lineup",
    "",
    "*Edit the rating (1-5), laughs and note on each joke. The running order, " +
      "and which jokes were in the set, are managed in JokeBakery.*",
    "",
    `*Laughs: ${LAUGH_HINT}.*`,
    "",
  ];

  if (dto.lineup.length === 0) body.push("*(no jokes recorded)*", "");
  dto.lineup.forEach((item, i) => {
    // The trailing `^id` is the anchor everything is read back from; the label
    // in front of it is cosmetic.
    const routine = item.routineTitle ? `**${item.routineTitle}** — ` : "";
    const dropped = item.performed === "dropped" ? " *(dropped)*" : "";
    const added = item.performed === "added" ? " *(added on the night)*" : "";
    body.push(
      `${i + 1}. ${routine}${jokeLink(item.jokeId)}${dropped}${added} ^${item.id}`
    );
    body.push(`    - rating: ${item.rating === null ? "" : item.rating}`);
    body.push(
      `    - laughs: ${item.laughs.map((s) => LAUGH_LABELS[s] ?? s).join(", ")}`
    );
    body.push(`    - new: ${item.isNew ? "yes" : "no"}`);
    body.push(`    - note: ${item.note.replace(/\n+/g, " ").trim()}`);
  });
  body.push("");

  const section = (heading: string, text: string) => {
    body.push(`## ${heading}`, "", text.trim(), "");
  };
  section("What went well", dto.wentWell);
  section("What went badly", dto.wentBadly);
  section("Notes", dto.notes);

  // Every routine that either appears in the lineup or already carries a note.
  // Both, because routineNotes is pushed as a whole map: leaving an existing
  // key out of the note would delete that note on the next push.
  const routineTitles = new Map<string, string>();
  for (const item of dto.lineup) {
    if (item.routineId) routineTitles.set(item.routineId, item.routineTitle);
  }
  for (const routineId of Object.keys(dto.routineNotes)) {
    if (!routineTitles.has(routineId)) routineTitles.set(routineId, "");
  }
  if (routineTitles.size > 0) {
    body.push(
      "## Routine notes",
      "",
      "*How each routine landed. Keep the `^` marker on the heading.*",
      ""
    );
    for (const [routineId, title] of routineTitles) {
      body.push(`### ${title || routineId} ^rt-${routineId}`, "");
      const note = (dto.routineNotes[routineId] ?? "").trim();
      if (note) body.push(note, "");
    }
  }

  if (dto.nextTime.length > 0) {
    body.push(
      "## Next time",
      "",
      "*Read-only — manage these retro actions in JokeBakery.*",
      ""
    );
    for (const n of dto.nextTime) body.push(`- ${n.text}`);
    body.push("");
  }

  return fm + body.join("\n").trimEnd() + "\n";
}

export interface ParsedGig {
  /** Absent when the note carries no `bw-id`, i.e. somebody created a gig note
   *  by hand. Gigs can't be created from the vault, so those are skipped. */
  push?: GigPush;
  /** Edits that were dropped because the server would have rejected them. */
  warnings: string[];
}

/** Pull the `- key: value` detail bullets out of one lineup entry. */
function lineupDetails(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of lines) {
    const m = /^\s*[-*]\s+([a-z]+)\s*:\s*(.*)$/i.exec(raw);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

/**
 * Parse a gig note back into a push. Read-only fields (date, set, running
 * order, membership, next-time actions) are ignored entirely; the editable
 * ones are validated to the server's own limits first - see the note at the
 * top of this section for why that matters.
 */
export function parseGigFile(content: string): ParsedGig {
  const { fm, body } = splitContent(content);
  const id = typeof fm["bw-id"] === "string" ? fm["bw-id"] : undefined;
  const warnings: string[] = [];
  if (!id) return { warnings };

  const push: GigPush = { id };

  // Venue is `min(1)` server-side: an emptied venue would 400 the push, so it
  // is dropped rather than sent. Everything else is length-capped.
  const capped = (
    key: string,
    max: number,
    label: string,
    allowEmpty = true
  ): string | undefined => {
    const v = strIfPresent(fm, key);
    if (v === undefined) return undefined;
    if (!allowEmpty && v.trim() === "") {
      warnings.push(`${label} can't be empty; left unchanged.`);
      return undefined;
    }
    if (v.length > max) {
      warnings.push(`${label} is longer than ${max} characters; left unchanged.`);
      return undefined;
    }
    return v;
  };

  push.venue = capped("venue", 200, "Venue", false);
  push.vibe = capped("vibe", 2000, "Vibe");
  push.billPosition = capped("bill-position", 100, "Bill position");
  push.followed = capped("followed", 200, "Followed");
  push.crowd = capped("crowd", 2000, "Crowd");

  if ("actual-minutes" in fm) {
    const v = asNullableInt(fm["actual-minutes"], 1, 1440);
    if (v === undefined) warnings.push("Actual minutes must be 1-1440; left unchanged.");
    else push.actualMinutes = v;
  }
  if ("first-applause-seconds" in fm) {
    const v = asNullableInt(fm["first-applause-seconds"], 0, 7200);
    if (v === undefined)
      warnings.push("First applause seconds must be 0-7200; left unchanged.");
    else push.firstApplauseSeconds = v;
  }
  if ("recording-url" in fm) {
    const raw = asStr(fm["recording-url"]).trim();
    if (raw === "") push.recordingUrl = null;
    else if (/^https?:\/\//i.test(raw) && raw.length <= 2000) push.recordingUrl = raw;
    else warnings.push("Recording URL must start with http:// or https://; left unchanged.");
  }
  const reviewed = asBool(fm["recording-reviewed"]);
  if (reviewed !== undefined) push.recordingReviewed = reviewed;

  const sections = parseBodySections(body);
  const prose = (key: string, max: number, label: string): string | undefined => {
    const v = sections[key];
    if (v === undefined) return undefined;
    if (v.length > max) {
      warnings.push(`${label} is longer than ${max} characters; left unchanged.`);
      return undefined;
    }
    return v;
  };
  push.wentWell = prose("what went well", 10000, "What went well");
  push.wentBadly = prose("what went badly", 10000, "What went badly");
  push.notes = prose("notes", 10000, "Notes");

  // --- lineup ---
  const lineupBlock = sections["lineup"];
  if (lineupBlock !== undefined) {
    const entries: Array<{ id: string; lines: string[] }> = [];
    for (const raw of lineupBlock.split("\n")) {
      const head = /^\s*\d+\.\s+(.*?)\s+\^([A-Za-z0-9-]+)\s*$/.exec(raw);
      if (head) {
        entries.push({ id: head[2], lines: [] });
        continue;
      }
      const last = entries[entries.length - 1];
      if (last) last.lines.push(raw);
    }

    const lineup: GigLineupPush[] = [];
    for (const entry of entries) {
      const d = lineupDetails(entry.lines);
      const item: GigLineupPush = { id: entry.id };

      if ("rating" in d) {
        const raw = d["rating"]!;
        if (raw === "") item.rating = null;
        else {
          const n = Number(raw);
          if (Number.isInteger(n) && n >= 1 && n <= 5) item.rating = n;
          else warnings.push(`Rating "${raw}" must be 1-5; left unchanged.`);
        }
      }
      if ("laughs" in d) {
        const names = d["laughs"]!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const slugs: string[] = [];
        for (const name of names) {
          const slug = LAUGH_SLUG_BY_NAME.get(name.toLowerCase());
          if (!slug) warnings.push(`"${name}" isn't a laugh type; ignored.`);
          else if (!slugs.includes(slug)) slugs.push(slug);
        }
        if (slugs.length > 8) {
          warnings.push("A joke can carry at most 8 laugh types; left unchanged.");
        } else {
          item.laughs = slugs;
        }
      }
      if ("new" in d) {
        const b = asBool(d["new"]!) ?? /^(yes|y)$/i.test(d["new"]!.trim());
        item.isNew = b;
      }
      if ("note" in d) {
        const n = d["note"]!;
        if (n.length > 2000) warnings.push("A lineup note is over 2000 characters; left unchanged.");
        else item.note = n;
      }

      // Only send rows that actually carry an edit - `id` alone is a no-op.
      if (Object.keys(item).length > 1) lineup.push(item);
    }
    if (lineup.length > 0) push.lineup = lineup;
  }

  // --- routine notes ---
  // Absent section = don't touch. Present = the whole map, since the server
  // replaces routineNotes wholesale.
  const routineBlock = sections["routine notes"];
  if (routineBlock !== undefined) {
    const notes: Record<string, string> = {};
    let currentId: string | null = null;
    let buf: string[] = [];
    const flush = () => {
      if (currentId !== null) {
        const text = buf.join("\n").trim();
        if (text.length > 2000) {
          warnings.push("A routine note is over 2000 characters; left unchanged.");
        } else if (text) {
          notes[currentId] = text;
        }
      }
      buf = [];
    };
    for (const raw of routineBlock.split("\n")) {
      const h = /^###\s+.*\^rt-([A-Za-z0-9-]+)\s*$/.exec(raw);
      if (h) {
        flush();
        currentId = h[1];
        continue;
      }
      if (currentId !== null) buf.push(raw);
    }
    flush();
    push.routineNotes = notes;
  }

  return { push, warnings };
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
    items.push({ id: ref ? ref[2] : newId(), text });
  }
  return { id, items };
}

export { type SprintPush, type JokePush };
