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
  JOKES_SUBDIR,
  LISTS_SUBDIR,
  SPRINTS_SUBDIR,
  crashToMarkdown,
  dateFromFilename,
  hashString,
  jokeToMarkdown,
  listToMarkdown,
  parseCrashFile,
  parseJokeFile,
  parseListFile,
  parseSprintFile,
  peekFrontmatter,
  slugify,
  sprintToMarkdown,
  stripSyncIdentity,
  type ParsedCrash,
  type ParsedJoke,
  type ParsedList,
  type ParsedSprint,
} from "./serialize";
import type {
  JokeBakerySyncSettings,
  CrashDTO,
  CrashPush,
  JokeDTO,
  JokePush,
  ListDTO,
  ListPush,
  SprintDTO,
  SprintPush,
} from "./types";

const EMPTY_RHYTHM = { keys: [], colours: [] };

/** Queued local deletions at or past this count are held for explicit
 *  confirmation before being pushed - a deleted sync folder (or a vault gone
 *  sideways) queues one per file, and pushing them would soft-delete the
 *  user's whole library server-side in one sync. */
export const MASS_DELETE_LIMIT = 20;

export interface SyncSummary {
  pushedCreated: number;
  pushedUpdated: number;
  pulledNew: number;
  pulledUpdated: number;
  deleted: number;
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
    conflicts: 0,
    errors: [],
  };
}

interface ScannedFile {
  file: TFile;
  type: "sprint" | "joke" | "list" | "crash";
  content: string;
  hash: string;
  id?: string;
}

export class SyncEngine {
  constructor(
    private app: App,
    private settings: JokeBakerySyncSettings,
    private persist: () => Promise<void>,
    /** Asked before pushing >= MASS_DELETE_LIMIT deletions; false holds them. */
    private confirmMassDelete: (count: number) => Promise<boolean> = () =>
      Promise.resolve(false)
  ) {}

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

  private defaultPath(dto: SprintDTO | JokeDTO | ListDTO | CrashDTO): string {
    if (dto.type === "sprint") return `${this.sub(SPRINTS_SUBDIR)}/${dto.date}.md`;
    if (dto.type === "list")
      return `${this.sub(LISTS_SUBDIR)}/${slugify(dto.label)}.md`;
    if (dto.type === "crash")
      return `${this.sub(CRASHES_SUBDIR)}/${slugify(`${dto.aText}-x-${dto.bText}`)}.md`;
    return `${this.sub(JOKES_SUBDIR)}/${slugify(dto.title)}.md`;
  }

  private conflictCopyPath(originalPath: string): string {
    const base = originalPath.split("/").pop() ?? "item.md";
    const stem = base.replace(/\.md$/, "");
    return `${this.sub(CONFLICTS_SUBDIR)}/${stem} (conflict ${stamp()}).md`;
  }

  // -- scanning ------------------------------------------------------------

  private async scanLocalFiles(): Promise<ScannedFile[]> {
    const sprintsDir = this.sub(SPRINTS_SUBDIR) + "/";
    const jokesDir = this.sub(JOKES_SUBDIR) + "/";
    const listsDir = this.sub(LISTS_SUBDIR) + "/";
    const crashesDir = this.sub(CRASHES_SUBDIR) + "/";
    const out: ScannedFile[] = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      let type: "sprint" | "joke" | "list" | "crash" | null = null;
      if (file.path.startsWith(sprintsDir)) type = "sprint";
      else if (file.path.startsWith(jokesDir)) type = "joke";
      else if (file.path.startsWith(listsDir)) type = "list";
      else if (file.path.startsWith(crashesDir)) type = "crash";
      if (!type) continue;

      const content = await this.app.vault.cachedRead(file);
      const fm = peekFrontmatter(content);
      const id = typeof fm["bw-id"] === "string" ? (fm["bw-id"] as string) : undefined;
      out.push({ file, type, content, hash: hashString(content), id });
    }
    return out;
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

  private jokeDTO(
    p: ParsedJoke,
    id: string,
    createdAt: string,
    updatedAt: string
  ): JokeDTO {
    return {
      type: "joke",
      id,
      title: p.title ?? deriveTitle(p.setup ?? ""),
      premise: p.premise ?? "",
      keyWords: p.keyWords ?? [],
      setup: p.setup ?? "",
      development: p.development ?? "",
      punchline: p.punchline ?? "",
      scratchpad: p.scratchpad ?? "",
      setupComponents: p.setupComponents ?? [],
      developmentComponents: p.developmentComponents ?? [],
      punchlineComponents: p.punchlineComponents ?? [],
      families: p.families ?? [],
      jokeType: p.jokeType ?? "",
      jokeFunction: p.jokeFunction ?? "",
      topicTags: p.topicTags ?? [],
      theme: p.theme ?? "",
      angle: p.angle ?? "",
      stage: p.stage ?? 1,
      notes: p.notes ?? "",
      performanceNotes: p.performanceNotes ?? "",
      setupChecklistDone: p.setupChecklistDone ?? [],
      setupRhythm: p.setupRhythm ?? { ...EMPTY_RHYTHM },
      developmentRhythm: p.developmentRhythm ?? { ...EMPTY_RHYTHM },
      punchlineRhythm: p.punchlineRhythm ?? { ...EMPTY_RHYTHM },
      setupIEN: p.setupIEN ?? [],
      developmentIEN: p.developmentIEN ?? [],
      punchlineIEN: p.punchlineIEN ?? [],
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

  // -- push ----------------------------------------------------------------

  private async pushLocal(api: JokeBakeryApi, summary: SyncSummary): Promise<void> {
    const scanned = await this.scanLocalFiles();
    const dirty = new Map<string, ScannedFile>();
    const sprints: SprintPush[] = [];
    const jokes: JokePush[] = [];
    const lists: ListPush[] = [];
    const crashes: CrashPush[] = [];

    for (const s of scanned) {
      const record = s.id ? this.settings.records[s.id] : undefined;
      const isDirty = !record || record.hash !== s.hash;
      if (!isDirty) continue;

      dirty.set(s.file.path, s);
      const ref = s.file.path;
      const baseUpdatedAt = record?.baseUpdatedAt;

      if (s.type === "sprint") {
        const fallback = dateFromFilename(s.file.basename) ?? todayLocal();
        const parsed = parseSprintFile(s.content, fallback);
        sprints.push({
          ref,
          id: parsed.id,
          baseUpdatedAt,
          date: parsed.date,
          durationSec: parsed.durationSec,
          jokes: parsed.jokes,
        });
      } else if (s.type === "list") {
        const parsed = parseListFile(s.content, s.file.basename);
        lists.push({
          ref,
          id: parsed.id,
          baseUpdatedAt,
          label: parsed.label,
          items: parsed.items,
        });
      } else if (s.type === "crash") {
        const parsed = parseCrashFile(s.content);
        crashes.push({
          ref,
          id: parsed.id,
          baseUpdatedAt,
          aListId: parsed.aListId,
          aItemId: parsed.aItemId,
          bListId: parsed.bListId,
          bItemId: parsed.bItemId,
          note: parsed.note,
        });
      } else {
        const parsed = parseJokeFile(s.content);
        jokes.push({ ref, baseUpdatedAt, ...parsed });
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
      deletes.length === 0
    )
      return;

    const res = await api.push({ sprints, jokes, lists, crashes, deletes });

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

      const entry = dirty.get(r.ref);
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
          const content =
            server.type === "sprint"
              ? sprintToMarkdown(server)
              : server.type === "list"
                ? listToMarkdown(server)
                : server.type === "crash"
                  ? crashToMarkdown(server)
                  : jokeToMarkdown(server);
          await this.writeFile(entry.file.path, content);
          this.settings.records[server.id] = {
            id: server.id,
            type: server.type,
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
      } else {
        const parsed = parseJokeFile(entry.content);
        content = jokeToMarkdown(this.jokeDTO(parsed, r.id, createdAt, r.updatedAt));
      }
      await this.writeFile(entry.file.path, content);
      this.settings.records[r.id] = {
        id: r.id,
        type: entry.type,
        path: entry.file.path,
        baseUpdatedAt: r.updatedAt,
        hash: hashString(content),
      };
      if (r.status === "created") summary.pushedCreated++;
      else summary.pushedUpdated++;
    }
  }

  // -- pull ----------------------------------------------------------------

  private async pullRemote(api: JokeBakeryApi, summary: SyncSummary): Promise<void> {
    const res = await api.changes(this.settings.lastSyncCursor);
    const items: Array<SprintDTO | JokeDTO | ListDTO | CrashDTO> = [
      ...res.sprints,
      ...res.jokes,
      // Guard for an older server build that doesn't send these collections.
      ...(res.lists ?? []),
      ...(res.crashes ?? []),
    ];

    for (const dto of items) {
      const content =
        dto.type === "sprint"
          ? sprintToMarkdown(dto)
          : dto.type === "list"
            ? listToMarkdown(dto)
            : dto.type === "crash"
              ? crashToMarkdown(dto)
              : jokeToMarkdown(dto);
      const newHash = hashString(content);
      const record = this.settings.records[dto.id];

      if (!record) {
        const path = await this.uniquePath(this.defaultPath(dto));
        await this.writeFile(path, content);
        this.settings.records[dto.id] = {
          id: dto.id,
          type: dto.type,
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

    this.settings.lastSyncCursor = res.now;
  }

  // -- entry point ---------------------------------------------------------

  async syncNow(opts: { silent?: boolean } = {}): Promise<SyncSummary> {
    const summary = emptySummary();
    if (!this.settings.token) {
      summary.errors.push("No access token set.");
      if (!opts.silent) new Notice("JokeBakery: set an access token in settings.");
      return summary;
    }

    const api = new JokeBakeryApi(this.settings.serverUrl, this.settings.token);
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
  if (s.conflicts) parts.push(`${s.conflicts} conflict${s.conflicts === 1 ? "" : "s"}`);
  if (s.errors.length) parts.push(`${s.errors.length} error${s.errors.length === 1 ? "" : "s"}`);
  const head = parts.length ? parts.join(" · ") : "already up to date";
  return `JokeBakery sync: ${head}` + (s.errors.length ? `\n${s.errors[0]}` : "");
}
