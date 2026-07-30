/**
 * An in-memory vault good enough to run the real SyncEngine against.
 *
 * Only the handful of Vault/FileManager methods the engine actually calls are
 * implemented. Everything is synchronous underneath and returned as a resolved
 * promise, so tests read as straight-line code.
 */
import { TFile, TFolder, type TAbstractFile } from "./obsidian-stub";
import type {
  ChangesResult,
  PushBody,
  PushResponse,
  PushResult,
} from "../src/types";

export class FakeVault {
  /** path -> file contents */
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  readonly trashed: string[] = [];

  getMarkdownFiles(): TFile[] {
    return [...this.files.keys()]
      .filter((p) => p.endsWith(".md"))
      .sort()
      .map((p) => new TFile(p));
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    if (this.files.has(path)) return new TFile(path);
    if (this.folders.has(path)) return new TFolder(path);
    return null;
  }

  cachedRead(file: TFile): Promise<string> {
    return Promise.resolve(this.files.get(file.path) ?? "");
  }

  read(file: TFile): Promise<string> {
    return this.cachedRead(file);
  }

  create(path: string, content: string): Promise<TFile> {
    this.files.set(path, content);
    return Promise.resolve(new TFile(path));
  }

  modify(file: TFile, content: string): Promise<void> {
    this.files.set(file.path, content);
    return Promise.resolve();
  }

  createFolder(path: string): Promise<void> {
    this.folders.add(path);
    return Promise.resolve();
  }
}

export class FakeApp {
  readonly vault = new FakeVault();
  readonly fileManager = {
    trashFile: (file: TFile): Promise<void> => {
      this.vault.files.delete(file.path);
      this.vault.trashed.push(file.path);
      return Promise.resolve();
    },
  };

  /** Seed a file without going through the engine. */
  write(path: string, content: string): void {
    this.vault.files.set(path, content);
  }

  read(path: string): string | undefined {
    return this.vault.files.get(path);
  }
}

/**
 * A stand-in server. `changes` replays whatever the test queued; `push`
 * records the body and answers with the results the test supplied (defaulting
 * to "everything updated cleanly").
 */
export class FakeApi {
  pushes: PushBody[] = [];
  changesCalls: string[] = [];

  constructor(
    private nextChanges: ChangesResult = emptyChanges(),
    private pushResponder: (body: PushBody) => PushResponse = defaultPushResponse
  ) {}

  setChanges(c: ChangesResult): void {
    this.nextChanges = c;
  }

  changes(since: string): Promise<ChangesResult> {
    this.changesCalls.push(since);
    return Promise.resolve(this.nextChanges);
  }

  /**
   * Round-trips the body through JSON exactly as the real transport does.
   *
   * That matters: the engine leans on `JSON.stringify` dropping `undefined`
   * properties to mean "don't touch this field". An in-memory object still has
   * those keys (set to undefined), so asserting on it would report a field as
   * "sent" when the server would never see it - and, worse, would pass if the
   * code started sending a real empty value instead.
   */
  push(body: PushBody): Promise<PushResponse> {
    const wire = JSON.parse(JSON.stringify(body)) as PushBody;
    this.pushes.push(wire);
    return Promise.resolve(this.pushResponder(wire));
  }

  /** The single push body sent in this run, for assertions. */
  get lastPush(): PushBody | undefined {
    return this.pushes[this.pushes.length - 1];
  }
}

export function emptyChanges(overrides: Partial<ChangesResult> = {}): ChangesResult {
  return {
    now: "2026-07-30T12:00:00.000Z",
    sprints: [],
    jokes: [],
    lists: [],
    crashes: [],
    deletions: [],
    ideas: null,
    gigs: [],
    ...overrides,
  };
}

/** Accept everything: each pushed item comes back as a clean update. */
export function defaultPushResponse(body: PushBody): PushResponse {
  const now = "2026-07-30T12:00:00.000Z";
  const results: PushResult[] = [];
  const add = (
    type: PushResult["type"],
    ref: string,
    id: string | undefined,
    created: boolean
  ) =>
    results.push({
      ref,
      type,
      status: created ? "created" : "updated",
      id: id ?? "server-assigned",
      updatedAt: now,
    });

  for (const s of body.sprints ?? []) add("sprint", s.ref, s.id, !s.baseUpdatedAt);
  for (const j of body.jokes ?? []) add("joke", j.ref, j.id, !j.baseUpdatedAt);
  for (const l of body.lists ?? []) add("list", l.ref, l.id, !l.baseUpdatedAt);
  for (const c of body.crashes ?? []) add("crash", c.ref, c.id, !c.baseUpdatedAt);
  for (const i of body.ideas ?? []) add("ideas", i.ref, i.id, false);
  // Gigs echo their own id as the ref - they have no ref field to send.
  for (const g of body.gigs ?? []) add("gig", g.id, g.id, false);
  for (const d of body.deletes ?? [])
    results.push({ ref: d.id, type: d.type, status: "deleted", id: d.id });
  return { now, results };
}
