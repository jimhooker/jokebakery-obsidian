/**
 * Sync engine. Two phases per run:
 *
 *   1. PUSH - scan the vault for files that are new or edited since the last
 *      sync and send them to JokeBakery. The server detects conflicts via the
 *      updatedAt we last saw; on conflict the server's version wins and the
 *      local copy is preserved under Conflicts/.
 *   2. PULL - fetch everything changed since our cursor and write it into the
 *      vault. Clean files are overwritten; locally-edited files that also moved
 *      on the server are left alone and the server version is dropped into
 *      Conflicts/.
 *
 * Identity is the server id stored in each file's frontmatter and mirrored in
 * `records` (keyed by id) so renames in Obsidian don't orphan a file.
 *
 * Not handled in this version: deletions don't propagate in either direction.
 */
import { App, TFile, Notice, normalizePath } from "obsidian";
import { JokeBakeryApi } from "./api";
import {
  CONFLICTS_SUBDIR,
  CRASHES_SUBDIR,
  GIGS_SUBDIR,
  IDEAS_FILENAME,
  JOKES_SUBDIR,
  LISTS_SUBDIR,
  SPRINTS_SUBDIR,
  crashToMarkdown,
  dateFromFilename,
  gigToMarkdown,
  hashString,
  ideasToMarkdown,
  isFileSyncConflictCopy,
  jokeMetaLost,
  jokeToMarkdown,
  listToMarkdown,
  newId,
  parseCrashFile,
  parseGigFile,
  parseIdeasFile,
  parseJokeFile,
  parseListFile,
  parseSprintFile,
  peekFrontmatter,
  slugify,
  sprintToMarkdown,
  stripSyncIdentity,
  withJokeTags,
  type JokeLinker,
  type JokeNote,
  type ParsedCrash,
  type ParsedIdeas,
  type ParsedJoke,
  type ParsedList,
  type ParsedSprint,
} from "./serialize";
import {
  CLIENT_PROTOCOL_VERSION,
  IDEAS_DOC_ID,
  type ChangesResult,
  type Deletion,
  type JokeBakerySyncSettings,
  type TagDTO,
  type PushBody,
  type PushResponse,
  type CrashDTO,
  type CrashPush,
  type GigDTO,
  type GigPush,
  type IdeasDocDTO,
  type IdeasPush,
  type JokeDTO,
  type JokePush,
  type ListDTO,
  type ListPush,
  type SprintDTO,
  type SprintPush,
  type SyncedEntityType,
} from "./types";

/** Any entity the plugin keeps a file for. */
type SyncedDTO =
  | SprintDTO
  | JokeDTO
  | ListDTO
  | CrashDTO
  | IdeasDocDTO
  | GigDTO;

const EMPTY_RHYTHM = { keys: [], colours: [] };

/** Queued local deletions at or past this count are held for explicit
 *  confirmation before being pushed - a deleted sync folder (or a vault gone
 *  sideways) queues one per file, and pushing them would soft-delete the
 *  user's whole library server-side in one sync. */
export const MASS_DELETE_LIMIT = 20;

/** A base timestamp old enough that any server copy counts as newer - used to
 *  mark a note for repair on the next pull. */
const EPOCH = "1970-01-01T00:00:00.000Z";

export interface SyncSummary {
  pushedCreated: number;
  pushedUpdated: number;
  pulledNew: number;
  pulledUpdated: number;
  deleted: number;
  /** Joke notes rewritten only because their tags changed. */
  retagged: number;
  conflicts: number;
  errors: string[];
}

function emptySummary(): SyncSummary {
  return {
    pushedCreated: 0,
    pushedUpdated: 0,
    pulledNew: 0,
    pulledUpdated: 0,
    deleted: 0,
    retagged: 0,
    conflicts: 0,
    errors: [],
  };
}

interface ScannedFile {
  file: TFile;
  type: SyncedEntityType;
  content: string;
  hash: string;
  id?: string;
}

/** The slice of the API the engine uses. Named so tests can drive the engine
 *  against a fake server without going near HTTP. */
export interface SyncApi {
  changes(since: string): Promise<ChangesResult>;
  push(body: PushBody): Promise<PushResponse>;
}

export class SyncEngine {
  constructor(
    private app: App,
    private settings: JokeBakerySyncSettings,
    private persist: () => Promise<void>,
    /** Asked before pushing >= MASS_DELETE_LIMIT deletions; false holds them. */
    private confirmMassDelete: (count: number) => Promise<boolean> = () =>
      Promise.resolve(false),
    private createApi: (settings: JokeBakerySyncSettings) => SyncApi = (s) =>
      new JokeBakeryApi(s.serverUrl, s.token)
  ) {}

  /** Filled by the scan when several vault files claim one `bw-id`; drained
   *  into the sync summary so the user is told which copy is being ignored. */
  private duplicateIdWarnings: string[] = [];

  // -- path helpers --------------------------------------------------------

  private sub(name: string): string {
    const f = this.settings.folder.replace(/\/+$/, "");
    return normalizePath(f ? `${f}/${name}` : name);
  }

  private exists(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(path) !== null;
  }

  private getFile(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  private async ensureParent(filePath: string): Promise<void> {
    const parts = filePath.split("/");
    parts.pop();
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!this.exists(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch {
          // racing/already-exists is fine
        }
      }
    }
  }

  private async writeFile(path: string, content: string): Promise<void> {
    await this.ensureParent(path);
    const existing = this.getFile(path);
    if (existing) await this.app.vault.modify(existing, content);
    else await this.app.vault.create(path, content);
  }

  private async uniquePath(path: string): Promise<string> {
    if (!this.exists(path)) return path;
    const dot = path.lastIndexOf(".");
    const stem = dot === -1 ? path : path.slice(0, dot);
    const ext = dot === -1 ? "" : path.slice(dot);
    for (let n = 2; ; n++) {
      const candidate = `${stem}-${n}${ext}`;
      if (!this.exists(candidate)) return candidate;
    }
  }

  /**
   * Remove an item locally: drop its record + any pending delete, then delete
   * the file. The record is cleared *first* so the vault's delete event doesn't
   * re-queue it as a local deletion (which would echo back to the server).
   */
  private async removeLocal(id: string, fallbackPath?: string): Promise<boolean> {
    const record = this.settings.records[id];
    const path = record?.path ?? fallbackPath;
    delete this.settings.records[id];
    this.settings.pendingDeletes = this.settings.pendingDeletes.filter(
      (d) => d.id !== id
    );
    if (!path) return false;
    const file = this.getFile(path);
    // Trash (per the user's "Deleted files" setting) rather than hard-delete,
    // so a server-driven deletion is recoverable on the vault side too.
    if (file) await this.app.fileManager.trashFile(file);
    return true;
  }

  /**
   * Where a freshly pulled item goes.
   *
   * The type is passed in rather than read off the DTO: a GigDTO carries no
   * `type` discriminant (the server's doesn't have one either), so `dto.type`
   * isn't available for gigs and the caller has to say what it pulled.
   */
  private defaultPath(type: SyncedEntityType, dto: SyncedDTO): string {
    switch (type) {
      case "sprint":
        return `${this.sub(SPRINTS_SUBDIR)}/${(dto as SprintDTO).date}.md`;
      case "list":
        return `${this.sub(LISTS_SUBDIR)}/${slugify((dto as ListDTO).label)}.md`;
      case "crash": {
        const c = dto as CrashDTO;
        return `${this.sub(CRASHES_SUBDIR)}/${slugify(`${c.aText}-x-${c.bText}`)}.md`;
      }
      case "gig": {
        const g = dto as GigDTO;
        return `${this.sub(GIGS_SUBDIR)}/${g.date}-${slugify(g.venue || "gig")}.md`;
      }
      case "ideas":
        return this.sub(IDEAS_FILENAME);
      default:
        return `${this.sub(JOKES_SUBDIR)}/${slugify((dto as JokeDTO).title)}.md`;
    }
  }

  /**
   * Render a synced entity to its note. Same reason as defaultPath for taking
   * the type explicitly: gigs have no discriminant to switch on.
   */
  private render(type: SyncedEntityType, dto: SyncedDTO): string {
    switch (type) {
      case "sprint":
        return sprintToMarkdown(dto as SprintDTO);
      case "list":
        return listToMarkdown(dto as ListDTO);
      case "crash":
        return crashToMarkdown(dto as CrashDTO);
      case "ideas":
        return ideasToMarkdown(dto as IdeasDocDTO);
      case "gig":
        return gigToMarkdown(dto as GigDTO, this.jokeLink);
      default:
        return jokeToMarkdown(dto as JokeDTO, this.tagNamesFor(dto.id));
    }
  }

  /**
   * Display text for a joke in a gig's lineup. A gig only carries joke IDs, so
   * this turns them into wikilinks when that joke is synced into this vault -
   * which is what makes a gig note a way INTO the material rather than a wall
   * of ids. Only the trailing `^lineupId` is read back on parse, so an
   * unresolvable link is cosmetic, never lossy.
   */
  private jokeLink: JokeLinker = (jokeId) => {
    const record = this.settings.records[jokeId];
    if (record && record.type === "joke") {
      const base = record.path.split("/").pop()?.replace(/\.md$/, "");
      if (base) return `[[${base}]]`;
    }
    return `joke \`${jokeId}\``;
  };

  private conflictCopyPath(originalPath: string): string {
    const base = originalPath.split("/").pop() ?? "item.md";
    const stem = base.replace(/\.md$/, "");
    return `${this.sub(CONFLICTS_SUBDIR)}/${stem} (conflict ${stamp()}).md`;
  }

  // -- scanning ------------------------------------------------------------

  private async scanLocalFiles(): Promise<ScannedFile[]> {
    const ideasPath = this.sub(IDEAS_FILENAME);
    const sprintsDir = this.sub(SPRINTS_SUBDIR) + "/";
    const jokesDir = this.sub(JOKES_SUBDIR) + "/";
    const listsDir = this.sub(LISTS_SUBDIR) + "/";
    const crashesDir = this.sub(CRASHES_SUBDIR) + "/";
    const gigsDir = this.sub(GIGS_SUBDIR) + "/";
    const out: ScannedFile[] = [];

    // The ideas inbox is a virtual doc keyed by a fixed id, not a folder scan:
    // once it's been synced once, `records[IDEAS_DOC_ID].path` is the file
    // that actually carries it, even after the user renames or moves it out
    // of the default location. Without this, a renamed Ideas.md silently
    // stops syncing (it no longer matches the default path, and pullRemote's
    // record lookup by id also wouldn't find it - see the write side below).
    const ideasRecordPath = this.settings.records[IDEAS_DOC_ID]?.path;

    for (const file of this.app.vault.getMarkdownFiles()) {
      let type: SyncedEntityType | null = null;
      if (file.path === ideasPath || file.path === ideasRecordPath) type = "ideas";
      else if (file.path.startsWith(sprintsDir)) type = "sprint";
      else if (file.path.startsWith(jokesDir)) type = "joke";
      else if (file.path.startsWith(listsDir)) type = "list";
      else if (file.path.startsWith(crashesDir)) type = "crash";
      else if (file.path.startsWith(gigsDir)) type = "gig";
      if (!type) continue;

      // A file-sync tool (Syncthing, Dropbox, iCloud) drops a COPY of a note
      // beside the original when two devices edited it. The copy keeps the
      // `bw-id` frontmatter, so without this it reads as a second file for the
      // same entity - and since `records` holds one hash per id, whichever copy
      // wasn't written last always looks dirty, so the two take turns pushing
      // and the item flip-flops forever. (Seen in the wild: a Syncthing copy
      // and the original alternating a list between nested and flat every five
      // minutes.) Skip them: a copy is never the file we sync.
      if (isFileSyncConflictCopy(file.basename)) continue;

      const content = await this.app.vault.cachedRead(file);
      const fm = peekFrontmatter(content);
      const id = typeof fm["bw-id"] === "string" ? fm["bw-id"] : undefined;
      out.push({ file, type, content, hash: hashString(content), id });
    }
    // Belt and braces: conflict-copy naming is not standardised, so also refuse
    // to push two files claiming one id whatever they are called. The file the
    // record already points at wins; the rest are left alone (never pushed,
    // never deleted) and reported so the user can merge and remove them.
    return this.dedupeById(out);
  }

  /** Of several files claiming one `bw-id`, the one we sync: the file the
   *  record already points at, else the first by path (stable, so the choice
   *  doesn't change under the user between syncs). The losers are returned as
   *  warnings, not silently dropped. */
  private dedupeById(scanned: ScannedFile[]): ScannedFile[] {
    const byId = new Map<string, ScannedFile[]>();
    for (const s of scanned) {
      if (!s.id) continue;
      const group = byId.get(s.id);
      if (group) group.push(s);
      else byId.set(s.id, [s]);
    }

    const dropped = new Set<ScannedFile>();
    this.duplicateIdWarnings = [];
    for (const [id, group] of byId) {
      if (group.length < 2) continue;
      const recordPath = this.settings.records[id]?.path;
      const sorted = [...group].sort((a, b) => a.file.path.localeCompare(b.file.path));
      const keep = sorted.find((s) => s.file.path === recordPath) ?? sorted[0]!;
      for (const s of group) if (s !== keep) dropped.add(s);
      this.duplicateIdWarnings.push(
        `${group.length} files share the id ${id}. Syncing ${keep.file.path}; ignoring ${group
          .filter((s) => s !== keep)
          .map((s) => s.file.path)
          .join(", ")}. Merge what you want to keep into the one being synced, then delete the others.`
      );
    }
    return dropped.size === 0 ? scanned : scanned.filter((s) => !dropped.has(s));
  }

  // -- DTO builders (for re-serializing local edits with assigned id) ------

  private sprintDTO(
    p: ParsedSprint,
    id: string,
    createdAt: string,
    updatedAt: string
  ): SprintDTO {
    return {
      type: "sprint",
      id,
      date: p.date,
      durationSec: p.durationSec ?? 0,
      jokes: p.jokes,
      createdAt,
      updatedAt,
    };
  }

  /**
   * Rebuild the joke note after a successful push, so the file carries its
   * canonical id.
   *
   * `created` decides what happens to fields the note didn't carry. On a
   * CREATE the parse is the whole truth (nothing existed server-side before),
   * so absent means empty and it's safe to write defaults in. On an UPDATE it
   * is not: the note simply predates the field, the server still holds a real
   * value, and writing a fabricated `''` here would make the NEXT push send it
   * as "clear this" and destroy that value. So the key is left out instead,
   * and a later pull fills it in. This is the second half of the fix in
   * parseJokeFile - presence-checking the parse alone doesn't help if the
   * re-write puts the fabricated blank straight back.
   */
  private jokeNote(
    p: ParsedJoke,
    id: string,
    createdAt: string,
    updatedAt: string,
    created: boolean
  ): JokeNote {
    const def = <T>(v: T | undefined, fallback: T): T | undefined =>
      v !== undefined ? v : created ? fallback : undefined;
    return {
      type: "joke",
      id,
      title: p.title ?? deriveTitle(p.setup ?? ""),
      premise: def(p.premise, ""),
      hinge: def(p.hinge, ""),
      keyWords: def(p.keyWords, []),
      setup: p.setup ?? "",
      development: p.development ?? "",
      punchline: p.punchline ?? "",
      scratchpad: p.scratchpad ?? "",
      setupComponents: p.setupComponents ?? [],
      developmentComponents: p.developmentComponents ?? [],
      punchlineComponents: p.punchlineComponents ?? [],
      families: def(p.families, []),
      jokeType: def(p.jokeType, ""),
      jokeFunction: def(p.jokeFunction, ""),
      theme: def(p.theme, ""),
      angle: def(p.angle, ""),
      stage: def(p.stage, 1),
      status: p.status !== undefined ? p.status : created ? null : undefined,
      notes: p.notes ?? "",
      performanceNotes: p.performanceNotes ?? "",
      setupChecklistDone: p.setupChecklistDone ?? [],
      setupRhythm: p.setupRhythm ?? { ...EMPTY_RHYTHM },
      developmentRhythm: p.developmentRhythm ?? { ...EMPTY_RHYTHM },
      punchlineRhythm: p.punchlineRhythm ?? { ...EMPTY_RHYTHM },
      setupIEN: p.setupIEN ?? [],
      developmentIEN: p.developmentIEN ?? [],
      punchlineIEN: p.punchlineIEN ?? [],
      setupBreaths: p.setupBreaths ?? [],
      developmentBreaths: p.developmentBreaths ?? [],
      punchlineBreaths: p.punchlineBreaths ?? [],
      additionalPunchlines: p.additionalPunchlines ?? [],
      lists: (p.lists ?? []).map((l) => ({
        id: "",
        label: l.label,
        items: l.items,
        createdAt,
      })),
      setupVersions: [],
      createdAt,
      updatedAt,
    };
  }

  private listDTO(
    p: ParsedList,
    id: string,
    createdAt: string,
    updatedAt: string
  ): ListDTO {
    return {
      type: "list",
      id,
      label: p.label,
      items: p.items,
      createdAt,
      updatedAt,
    };
  }

  private crashDTO(
    p: ParsedCrash,
    id: string,
    createdAt: string,
    updatedAt: string
  ): CrashDTO {
    return {
      type: "crash",
      id,
      aListId: p.aListId,
      aItemId: p.aItemId,
      aLabel: p.aLabel,
      aText: p.aText,
      bListId: p.bListId,
      bItemId: p.bItemId,
      bLabel: p.bLabel,
      bText: p.bText,
      note: p.note,
      createdAt,
      updatedAt,
    };
  }

  private ideasDTO(
    p: ParsedIdeas,
    id: string,
    createdAt: string,
    updatedAt: string
  ): IdeasDocDTO {
    return { type: "ideas", id, items: p.items, createdAt, updatedAt };
  }

  // -- push ----------------------------------------------------------------

  private async pushLocal(api: SyncApi, summary: SyncSummary): Promise<void> {
    const scanned = await this.scanLocalFiles();
    summary.errors.push(...this.duplicateIdWarnings);
    const dirty = new Map<string, ScannedFile>();
    // Gigs are looked up by id, not by path: gigPushSchema has no `ref` field
    // to echo, so the server returns the gig's own id as the result ref.
    const dirtyById = new Map<string, ScannedFile>();
    const sprints: SprintPush[] = [];
    const jokes: JokePush[] = [];
    const lists: ListPush[] = [];
    const crashes: CrashPush[] = [];
    const ideasArr: IdeasPush[] = [];
    const gigs: GigPush[] = [];

    for (const s of scanned) {
      const record = s.id ? this.settings.records[s.id] : undefined;
      const isDirty = !record || record.hash !== s.hash;
      if (!isDirty) continue;

      const ref = s.file.path;
      const baseUpdatedAt = record?.baseUpdatedAt;

      if (s.type === "gig") {
        // A gig is born in the app, at the moment a set's lineup is
        // snapshotted. A note here with no id was hand-made and has nothing to
        // update, so there's no create to attempt - say so and move on.
        const parsed = parseGigFile(s.content);
        summary.errors.push(...parsed.warnings.map((w) => `${ref}: ${w}`));
        if (!parsed.push) {
          summary.errors.push(
            `${ref}: not a JokeBakery gig (no bw-id). Gigs are created in the app when you log a set.`
          );
          continue;
        }
        dirty.set(ref, s);
        dirtyById.set(parsed.push.id, s);
        gigs.push({ ...parsed.push, baseUpdatedAt });
        continue;
      }

      dirty.set(ref, s);

      // A note with no id yet is a create. Mint the id HERE rather than
      // letting the server assign one: the server treats a create as "no row
      // exists for this id", so sending our own makes the create idempotent
      // and a retried push updates that row instead of making a second one.
      const idFor = (parsedId: string | undefined) => parsedId ?? newId();

      if (s.type === "sprint") {
        const fallback = dateFromFilename(s.file.basename) ?? todayLocal();
        const parsed = parseSprintFile(s.content, fallback);
        sprints.push({
          ref,
          id: idFor(parsed.id),
          baseUpdatedAt,
          date: parsed.date,
          durationSec: parsed.durationSec,
          jokes: parsed.jokes,
        });
      } else if (s.type === "list") {
        const parsed = parseListFile(s.content, s.file.basename);
        lists.push({
          ref,
          id: idFor(parsed.id),
          baseUpdatedAt,
          label: parsed.label,
          items: parsed.items,
        });
      } else if (s.type === "crash") {
        const parsed = parseCrashFile(s.content);
        crashes.push({
          ref,
          id: idFor(parsed.id),
          baseUpdatedAt,
          aListId: parsed.aListId,
          aItemId: parsed.aItemId,
          bListId: parsed.bListId,
          bItemId: parsed.bItemId,
          note: parsed.note,
        });
      } else if (s.type === "ideas") {
        const parsed = parseIdeasFile(s.content);
        ideasArr.push({
          ref,
          id: parsed.id,
          baseUpdatedAt,
          items: parsed.items,
        });
      } else {
        const parsed = parseJokeFile(s.content);
        jokes.push({ ref, baseUpdatedAt, ...parsed, id: idFor(parsed.id) });
      }
    }

    let deletes = [...this.settings.pendingDeletes];
    if (deletes.length >= MASS_DELETE_LIMIT) {
      if (!(await this.confirmMassDelete(deletes.length))) {
        summary.errors.push(
          `${deletes.length} queued deletions held back — run a manual sync to confirm deleting them in JokeBakery.`
        );
        deletes = [];
      }
    }

    if (
      sprints.length === 0 &&
      jokes.length === 0 &&
      lists.length === 0 &&
      crashes.length === 0 &&
      ideasArr.length === 0 &&
      gigs.length === 0 &&
      deletes.length === 0
    )
      return;

    const res = await api.push({
      sprints,
      jokes,
      lists,
      crashes,
      ideas: ideasArr,
      gigs,
      deletes,
      protocolVersion: CLIENT_PROTOCOL_VERSION,
    });

    for (const r of res.results) {
      // A "deleted" result means the server has no live copy: either a delete
      // we requested, or a file we pushed that was already deleted server-side.
      // Either way, drop it locally.
      if (r.status === "deleted") {
        const id = r.id ?? r.ref;
        await this.removeLocal(id, dirty.get(r.ref)?.file.path);
        summary.deleted++;
        continue;
      }

      // Gig results come back keyed by gig id (no ref to echo); everything
      // else by the file path we sent.
      const entry = dirty.get(r.ref) ?? dirtyById.get(r.ref);
      if (!entry) continue;

      if (r.status === "error") {
        summary.errors.push(`${entry.file.path}: ${r.message ?? "push error"}`);
        continue;
      }

      if (r.status === "conflict") {
        // Server wins. Preserve local edits under Conflicts/, write server copy.
        const server = r.server;
        const copyPath = await this.uniquePath(this.conflictCopyPath(entry.file.path));
        await this.writeFile(copyPath, stripSyncIdentity(entry.content));
        if (server) {
          // r.type, not server.type: a GigDTO has no `type` field.
          const content = this.render(entry.type, server);
          await this.writeFile(entry.file.path, content);
          this.settings.records[server.id] = {
            id: server.id,
            type: entry.type,
            path: entry.file.path,
            baseUpdatedAt: server.updatedAt,
            hash: hashString(content),
          };
        }
        summary.conflicts++;
        continue;
      }

      // created | updated - re-serialize locally with the canonical id so the
      // file carries its identity. (The immediate pull won't touch it: the
      // server didn't change between push and pull, so it's not "newer".)
      if (!r.id || !r.updatedAt) continue;
      const created = peekFrontmatter(entry.content)["bw-created"];
      const createdAt = typeof created === "string" ? created : r.updatedAt;

      // A gig note is a view of server state we only partly hold (the lineup's
      // running order, the retro actions, the set it came from). Rebuilding it
      // from our own parse would drop all of that, so leave the file as the
      // user left it and let the pull that runs next rewrite it from the
      // server - our push just bumped updatedAt, so it's coming down anyway.
      if (entry.type === "gig") {
        this.settings.records[r.id] = {
          id: r.id,
          type: "gig",
          path: entry.file.path,
          // Deliberately stale, so pullRemote treats the server copy as newer
          // and rewrites the note with the canonical version.
          baseUpdatedAt: EPOCH,
          hash: entry.hash,
        };
        summary.pushedUpdated++;
        continue;
      }

      let content: string;
      if (entry.type === "sprint") {
        const parsed = parseSprintFile(
          entry.content,
          dateFromFilename(entry.file.basename) ?? todayLocal()
        );
        content = sprintToMarkdown(this.sprintDTO(parsed, r.id, createdAt, r.updatedAt));
      } else if (entry.type === "list") {
        const parsed = parseListFile(entry.content, entry.file.basename);
        content = listToMarkdown(this.listDTO(parsed, r.id, createdAt, r.updatedAt));
      } else if (entry.type === "crash") {
        const parsed = parseCrashFile(entry.content);
        content = crashToMarkdown(this.crashDTO(parsed, r.id, createdAt, r.updatedAt));
      } else if (entry.type === "ideas") {
        // The pushed file is NOT the server state for this virtual doc: the
        // server just merged our bullets against everything the app captured
        // since the last pull, and its merged doc can contain bullets our
        // local parse never had (plus canonical ^ids for hand-typed
        // bullets that our own re-parse here would mint differently). Write
        // the server's merged doc so the note - and the base we record for
        // it - both match what the server actually stored. Fall back to the
        // local re-serialize only against an older server build that hasn't
        // started returning `server` on ideas pushes yet.
        if (r.server && r.type === "ideas") {
          content = ideasToMarkdown(r.server as IdeasDocDTO);
        } else {
          const parsed = parseIdeasFile(entry.content);
          content = ideasToMarkdown(this.ideasDTO(parsed, r.id, createdAt, r.updatedAt));
        }
      } else {
        const parsed = parseJokeFile(entry.content);
        content = jokeToMarkdown(
          this.jokeNote(parsed, r.id, createdAt, r.updatedAt, r.status === "created"),
          this.tagNamesFor(r.id)
        );
      }
      await this.writeFile(entry.file.path, content);
      // A joke whose bw-meta was damaged pushed none of the fields that live
      // in there, so the server still holds them but our re-write doesn't -
      // back-date the base so the pull below repairs the note from server
      // truth instead of leaving the empty defaults to be pushed next time.
      const repair = entry.type === "joke" && jokeMetaLost(entry.content);
      this.settings.records[r.id] = {
        id: r.id,
        type: entry.type,
        path: entry.file.path,
        baseUpdatedAt: repair ? EPOCH : r.updatedAt,
        hash: hashString(content),
      };
      if (repair) {
        summary.errors.push(
          `${entry.file.path}: sync data was missing from this note, so its components and rhythm marks were re-fetched from JokeBakery rather than cleared.`
        );
      }
      if (r.status === "created") summary.pushedCreated++;
      else summary.pushedUpdated++;
    }
  }

  // -- pull ----------------------------------------------------------------

  private async pullRemote(api: SyncApi, summary: SyncSummary): Promise<void> {
    // The first pull after upgrading into the tag store is a full one, so the
    // store starts with every tag rather than only those that change from
    // now on. The loop below already treats what it holds as "not newer", so
    // the cost is one large response, once. (A fresh install has no cursor
    // and gets the same full pull either way.)
    const since = this.settings.tagsPrimed ? this.settings.lastSyncCursor : "";
    const res = await api.changes(since);

    this.checkServerVersion(res.version, summary);

    const retag = this.mergeTags(res.tags ?? [], res.deletions);

    // Each entity is paired with its type rather than read off the DTO: gigs
    // carry no `type` discriminant, so the collection it arrived in is the
    // only thing that says what it is.
    const items: Array<[SyncedEntityType, SyncedDTO]> = [
      ...res.sprints.map((d): [SyncedEntityType, SyncedDTO] => ["sprint", d]),
      ...res.jokes.map((d): [SyncedEntityType, SyncedDTO] => ["joke", d]),
      // Guard for an older server build that doesn't send these collections.
      ...(res.lists ?? []).map((d): [SyncedEntityType, SyncedDTO] => ["list", d]),
      ...(res.crashes ?? []).map((d): [SyncedEntityType, SyncedDTO] => ["crash", d]),
      ...(res.gigs ?? []).map((d): [SyncedEntityType, SyncedDTO] => ["gig", d]),
      ...(res.ideas
        ? [["ideas", res.ideas] as [SyncedEntityType, SyncedDTO]]
        : []),
    ];

    for (const [type, dto] of items) {
      const content = this.render(type, dto);
      const newHash = hashString(content);
      const record = this.settings.records[dto.id];

      if (!record) {
        // The ideas inbox is a virtual singleton doc, not a per-row entity:
        // if a file already sits at its canonical path with no record yet,
        // that's the plugin's own not-yet-pushed Ideas.md (first sync on a
        // fresh vault, or a record lost some other way) - NOT a second
        // document to fork with uniquePath. Forking here would silently turn
        // sync one-way (the pulled copy gets a record and keeps updating;
        // the pre-existing file never gets pushed nor pulled into again).
        // Skip this dto for this cycle; the pre-existing file will get
        // pushed on the next sync (pushLocal scans it, since it matches
        // ideasPath), merge server-side, and come back with a canonical
        // result - at which point the record exists and pulls proceed
        // normally. Every other entity keeps the uniquePath fork behavior.
        if (type === "ideas" && this.exists(this.defaultPath(type, dto))) {
          continue;
        }
        const path = await this.uniquePath(this.defaultPath(type, dto));
        await this.writeFile(path, content);
        this.settings.records[dto.id] = {
          id: dto.id,
          type,
          path,
          baseUpdatedAt: dto.updatedAt,
          hash: newHash,
        };
        summary.pulledNew++;
        continue;
      }

      const file = this.getFile(record.path);
      const current = file ? await this.app.vault.cachedRead(file) : null;
      const serverNewer =
        new Date(dto.updatedAt).getTime() > new Date(record.baseUpdatedAt).getTime();

      if (!serverNewer) {
        // Nothing new from the server. Recreate the file if it went missing.
        if (current === null) {
          await this.writeFile(record.path, content);
          record.hash = newHash;
          record.baseUpdatedAt = dto.updatedAt;
        }
        continue;
      }

      const localDirty = current !== null && hashString(current) !== record.hash;
      if (localDirty) {
        // Both sides changed (push didn't resolve it, e.g. offline edit). Keep
        // local, drop the server version into Conflicts/ for manual merge.
        const copyPath = await this.uniquePath(this.conflictCopyPath(record.path));
        await this.writeFile(copyPath, content);
        summary.conflicts++;
        continue;
      }

      await this.writeFile(record.path, content);
      record.hash = newHash;
      record.baseUpdatedAt = dto.updatedAt;
      summary.pulledUpdated++;
    }

    // Tombstones: remove the local copy of anything deleted on the server.
    for (const del of res.deletions) {
      if (await this.removeLocal(del.id)) summary.deleted++;
    }

    // Jokes whose tags changed without the joke itself changing. A note the
    // loop above just rendered already carries the right tags, so this is a
    // no-op for it; a note with local edits is left alone, because the push
    // that carries those edits re-renders it with the current tags anyway.
    for (const jokeId of retag) {
      const record = this.settings.records[jokeId];
      if (!record || record.type !== "joke") continue;
      const file = this.getFile(record.path);
      if (!file) continue;
      const current = await this.app.vault.cachedRead(file);
      if (hashString(current) !== record.hash) continue;
      const next = withJokeTags(current, this.tagNamesFor(jokeId));
      if (next === current) continue;
      await this.writeFile(record.path, next);
      record.hash = hashString(next);
      summary.retagged++;
    }

    this.settings.tagsPrimed = true;
    this.settings.lastSyncCursor = res.now;
  }

  /**
   * Fold a pull's tags into the store, and say which jokes' notes may now
   * show the wrong tags: every joke a changed tag was on before or is on now
   * (a rename touches all of them), and every joke a deleted tag was on.
   */
  private mergeTags(tags: TagDTO[], deletions: Deletion[]): Set<string> {
    const touched = new Set<string>();
    const store = this.settings.tags;
    for (const t of tags) {
      const next = t.links.filter((l) => l.entityType === "joke").map((l) => l.entityId);
      for (const id of store[t.id]?.jokeIds ?? []) touched.add(id);
      for (const id of next) touched.add(id);
      store[t.id] = { name: t.name, jokeIds: next };
    }
    for (const d of deletions) {
      if (d.type !== "tag") continue;
      for (const id of store[d.id]?.jokeIds ?? []) touched.add(id);
      delete store[d.id];
    }
    return touched;
  }

  /** The names of the tags on a joke, in a fixed order so the same tags
   *  always render the same line (the note's hash depends on it). */
  private tagNamesFor(jokeId: string): string[] {
    const names: string[] = [];
    for (const t of Object.values(this.settings.tags)) {
      if (t.jokeIds.includes(jokeId)) names.push(t.name);
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Warn when the server speaks a newer wire version than this build.
   *
   * A version gap is not an error - the plugin keeps syncing everything it
   * understands - but it does mean some of the user's work can't round-trip,
   * and that degradation is otherwise completely silent. It has bitten before:
   * clients that predated list nesting pushed nested lists back flat, which is
   * exactly why the server now needs `protocolVersion` on every push. Say so
   * once per version bump rather than every sync.
   */
  private checkServerVersion(version: number | undefined, summary: SyncSummary): void {
    if (typeof version !== "number") return;
    if (version <= CLIENT_PROTOCOL_VERSION) return;
    if (version <= this.settings.protocolNoticeShownFor) return;
    this.settings.protocolNoticeShownFor = version;
    summary.errors.push(
      "JokeBakery has features this version of the plugin doesn't know about yet. " +
        "Update JokeBakery Sync from Obsidian's community plugins to keep everything in step."
    );
  }

  // -- entry point ---------------------------------------------------------

  async syncNow(opts: { silent?: boolean } = {}): Promise<SyncSummary> {
    const summary = emptySummary();
    if (!this.settings.token) {
      summary.errors.push("No access token set.");
      if (!opts.silent) new Notice("JokeBakery: set an access token in settings.");
      return summary;
    }

    const api = this.createApi(this.settings);
    try {
      await this.pushLocal(api, summary);
      await this.pullRemote(api, summary);
      this.settings.lastSyncAt = new Date().toISOString();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push(msg);
    }

    await this.persist();
    if (!opts.silent) new Notice(formatSummary(summary));
    return summary;
  }
}

// ---------------------------------------------------------------------------
// Helpers

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function stamp(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function deriveTitle(setup: string): string {
  const trimmed = setup.trim();
  if (!trimmed) return "Untitled";
  const words = trimmed.split(/\s+/).slice(0, 8).join(" ");
  return trimmed.split(/\s+/).length > 8 ? words + "…" : words;
}

function formatSummary(s: SyncSummary): string {
  const parts: string[] = [];
  const pushed = s.pushedCreated + s.pushedUpdated;
  const pulled = s.pulledNew + s.pulledUpdated;
  if (pushed) parts.push(`↑ ${pushed} pushed`);
  if (pulled) parts.push(`↓ ${pulled} pulled`);
  if (s.deleted) parts.push(`🗑 ${s.deleted} deleted`);
  if (s.retagged) parts.push(`${s.retagged} retagged`);
  if (s.conflicts) parts.push(`${s.conflicts} conflict${s.conflicts === 1 ? "" : "s"}`);
  if (s.errors.length) parts.push(`${s.errors.length} error${s.errors.length === 1 ? "" : "s"}`);
  const head = parts.length ? parts.join(" · ") : "already up to date";
  return `JokeBakery sync: ${head}` + (s.errors.length ? `\n${s.errors[0]}` : "");
}
