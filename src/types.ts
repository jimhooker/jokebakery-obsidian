/**
 * Wire types - mirror of the server's sync-dto.ts. Kept as a hand-written copy
 * so the plugin has no build-time dependency on the BakerWriter app.
 */

export interface Rhythm {
  keys: number[];
  colours: number[];
}

export type IENValue = "I" | "E" | "N" | null;

/** A list item with a stable id, encoded in markdown as `- text ^id` (an
 *  Obsidian block reference). Mirrors the server's ListItem. `afterthoughts`
 *  are riffs on the item, written as indented sub-bullets under it. */
export interface ListItemDTO {
  id: string;
  text: string;
  afterthoughts?: ListItemDTO[];
}

export interface SprintDTO {
  type: "sprint";
  id: string;
  date: string; // YYYY-MM-DD
  durationSec: number;
  jokes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface JokeListDTO {
  id: string;
  label: string;
  items: ListItemDTO[];
  createdAt: string;
}

/** A user-owned list as its own synced file. The `lists` on a JokeDTO are
 *  read-only references to these; the editable source of truth is the file. */
export interface ListDTO {
  type: "list";
  id: string;
  label: string;
  items: ListItemDTO[];
  createdAt: string;
  updatedAt: string;
}

/** A crash - a link between two list items - as its own synced file. The ids
 *  are canonical; labels/text are denormalized for a readable note. */
export interface CrashDTO {
  type: "crash";
  id: string;
  aListId: string;
  aItemId: string;
  aLabel: string;
  aText: string;
  bListId: string;
  bItemId: string;
  bLabel: string;
  bText: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface SetupVersionDTO {
  id: string;
  text: string;
  createdAt: string;
}

export interface AdditionalPunchlineDTO {
  id: string;
  text: string;
  components: string[];
  rhythm: Rhythm;
  ien?: IENValue[];
}

export interface JokeDTO {
  type: "joke";
  id: string;
  title: string;
  premise: string;
  setup: string;
  development: string;
  punchline: string;
  scratchpad: string;
  setupComponents: string[];
  developmentComponents: string[];
  punchlineComponents: string[];
  families: string[];
  jokeType: string;
  jokeFunction: string;
  topicTags: string[];
  theme: string;
  angle: string;
  stage: number;
  notes: string;
  performanceNotes: string;
  setupChecklistDone: string[];
  setupRhythm: Rhythm;
  developmentRhythm: Rhythm;
  punchlineRhythm: Rhythm;
  setupIEN: IENValue[];
  developmentIEN: IENValue[];
  punchlineIEN: IENValue[];
  additionalPunchlines: AdditionalPunchlineDTO[];
  lists: JokeListDTO[];
  setupVersions: SetupVersionDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface Deletion {
  type: "sprint" | "joke" | "list" | "crash";
  id: string;
}

export interface ChangesResult {
  now: string;
  sprints: SprintDTO[];
  jokes: JokeDTO[];
  lists: ListDTO[];
  crashes: CrashDTO[];
  deletions: Deletion[];
}

// --- Push (plugin -> server) ---

export interface SprintPush {
  ref: string;
  id?: string;
  baseUpdatedAt?: string;
  date: string;
  durationSec?: number;
  jokes: string[];
}

export interface JokeListPush {
  id?: string;
  label: string;
  items: ListItemDTO[];
}

export interface ListPush {
  ref: string;
  id?: string;
  baseUpdatedAt?: string;
  label: string;
  items: ListItemDTO[];
}

export interface CrashPush {
  ref: string;
  id?: string;
  baseUpdatedAt?: string;
  aListId: string;
  aItemId: string;
  bListId: string;
  bItemId: string;
  note?: string;
}

export interface JokePush {
  ref: string;
  id?: string;
  baseUpdatedAt?: string;
  title?: string;
  premise?: string;
  setup?: string;
  development?: string;
  punchline?: string;
  scratchpad?: string;
  setupComponents?: string[];
  developmentComponents?: string[];
  punchlineComponents?: string[];
  families?: string[];
  jokeType?: string;
  jokeFunction?: string;
  topicTags?: string[];
  theme?: string;
  angle?: string;
  stage?: number;
  notes?: string;
  performanceNotes?: string;
  setupChecklistDone?: string[];
  setupRhythm?: Rhythm;
  developmentRhythm?: Rhythm;
  punchlineRhythm?: Rhythm;
  setupIEN?: IENValue[];
  developmentIEN?: IENValue[];
  punchlineIEN?: IENValue[];
  additionalPunchlines?: AdditionalPunchlineDTO[];
  lists?: JokeListPush[];
}

export interface PushBody {
  sprints?: SprintPush[];
  jokes?: JokePush[];
  lists?: ListPush[];
  crashes?: CrashPush[];
  deletes?: Deletion[];
}

export type PushStatus =
  | "created"
  | "updated"
  | "conflict"
  | "deleted"
  | "error";

export interface PushResult {
  ref: string;
  type: "sprint" | "joke" | "list" | "crash";
  status: PushStatus;
  id?: string;
  updatedAt?: string;
  server?: SprintDTO | JokeDTO | ListDTO | CrashDTO;
  message?: string;
}

export interface PushResponse {
  now: string;
  results: PushResult[];
}

// --- Plugin-local persisted state ---

export interface SyncRecord {
  id: string;
  type: "sprint" | "joke" | "list" | "crash";
  /** Vault-relative path of the file representing this item. */
  path: string;
  /** Server updatedAt we last reconciled with - our conflict-detection base. */
  baseUpdatedAt: string;
  /** Hash of the file content at last sync, to detect local edits. */
  hash: string;
}

export interface BakerWriterSyncSettings {
  serverUrl: string;
  token: string;
  folder: string;
  autoSync: boolean;
  syncIntervalMin: number;
  /** Cursor for the changes feed - the `now` from the last successful pull. */
  lastSyncCursor: string;
  /** ISO time of the last successful sync, for the status bar. */
  lastSyncAt: string;
  /** Per-item sync state, keyed by server id. */
  records: Record<string, SyncRecord>;
  /** Items deleted in the vault, awaiting a push to delete them server-side. */
  pendingDeletes: Deletion[];
}

export const DEFAULT_SETTINGS: BakerWriterSyncSettings = {
  serverUrl: "https://bakerwriter.vercel.app",
  token: "",
  folder: "BakerWriter",
  autoSync: true,
  syncIntervalMin: 5,
  lastSyncCursor: "",
  lastSyncAt: "",
  records: {},
  pendingDeletes: [],
};
