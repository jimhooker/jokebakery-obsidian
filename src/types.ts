/**
 * Wire types - mirror of the server's sync-dto.ts. Kept as a hand-written copy
 * so the plugin has no build-time dependency on the JokeBakery app.
 *
 * Naming note: the `bw-` frontmatter keys and the `bw_` token prefix predate
 * the JokeBakery rebrand. They are the stable wire/identity format baked into
 * every synced vault and issued token, so they deliberately keep the old
 * prefix. (The plugin id DID rebrand to `jokebakery-sync` in 0.4.0, before the
 * community-directory submission made it permanent.)
 */

export interface Rhythm {
  keys: number[];
  colours: number[];
}

/** The IEN voices. "O" (Other) is the fourth voice, added after the first
 *  release of this plugin - a build that only knew I/E/N mapped it to null on
 *  parse and pushed that back, silently wiping the tag server-side. */
export type IENValue = "I" | "E" | "N" | "O" | null;

/** A list item with a stable id, encoded in markdown as `- text ^id` (an
 *  Obsidian block reference). Mirrors the server's ListItem. `afterthoughts`
 *  are riffs on the item, written as indented sub-bullets under it. `parentId`
 *  (sync v5) links an item to its structural parent for nesting; absent/null =
 *  top-level. It round-trips via an explicit trailing `^^<parentId>` token so
 *  flat notes stay byte-identical. */
export interface ListItemDTO {
  id: string;
  text: string;
  afterthoughts?: ListItemDTO[];
  parentId?: string | null;
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
  breaths?: number[];
}

export interface JokeDTO {
  type: "joke";
  id: string;
  title: string;
  premise: string;
  hinge: string;
  keyWords: string[];
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
  theme: string;
  angle: string;
  stage: number;
  /** Manual working status, or null for none. One of JOKE_STATUSES. */
  status: string | null;
  notes: string;
  performanceNotes: string;
  setupChecklistDone: string[];
  setupRhythm: Rhythm;
  developmentRhythm: Rhythm;
  punchlineRhythm: Rhythm;
  setupIEN: IENValue[];
  developmentIEN: IENValue[];
  punchlineIEN: IENValue[];
  setupBreaths: number[];
  developmentBreaths: number[];
  punchlineBreaths: number[];
  additionalPunchlines: AdditionalPunchlineDTO[];
  lists: JokeListDTO[];
  setupVersions: SetupVersionDTO[];
  createdAt: string;
  updatedAt: string;
}

/** The ideas inbox as ONE virtual synced document (Ideas.md). The id is the
 *  fixed constant IDEAS_DOC_ID; bullets are active ideas. Pushes merge
 *  per-bullet server-side, so this entity never produces conflicts. */
export const IDEAS_DOC_ID = "ideas-inbox";

export interface IdeasDocDTO {
  type: "ideas";
  id: string;
  items: { id: string; text: string }[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A gig - one performance of a set, as it actually went. The lineup is
 * embedded (like a joke embeds its setup versions).
 *
 * NOTE: unlike every other DTO this one carries NO `type` discriminant - the
 * server's GigDTO has no such field. Anywhere a gig flows through code that
 * switches on `dto.type`, the type has to come from the surrounding context
 * (the collection it arrived in, or PushResult.type) instead.
 */
export interface GigLineupItemDTO {
  id: string;
  jokeId: string;
  routineId: string | null;
  routineTitle: string;
  position: number;
  /** performed | dropped | added. Set in the app; read-only here. */
  performed: string;
  isNew: boolean;
  /** Laugh-type slugs - see LAUGH_LABELS. */
  laughs: string[];
  rating: number | null;
  note: string;
}

export interface GigDTO {
  id: string;
  setId: string;
  setTitle: string;
  date: string;
  venue: string;
  vibe: string;
  billPosition: string;
  followed: string;
  crowd: string;
  plannedMinutes: number | null;
  actualMinutes: number | null;
  firstApplauseSeconds: number | null;
  recordingUrl: string | null;
  recordingReviewed: boolean;
  wentWell: string;
  wentBadly: string;
  notes: string;
  nextTime: Array<{ id: string; text: string; ideaId: string | null }>;
  routineNotes: Record<string, string>;
  lineup: GigLineupItemDTO[];
  createdAt: string;
  updatedAt: string;
}

/** Every entity the server can tombstone. The plugin only holds files for the
 *  ones it syncs; ids it doesn't know simply no-op, which is what makes it safe
 *  to accept the wider set from a newer server. */
export type EntityType =
  | "sprint"
  | "joke"
  | "list"
  | "crash"
  | "ideas"
  | "gig"
  | "routine"
  | "set"
  | "tag"
  | "teardown";

/** The subset this plugin actually keeps files for. */
export type SyncedEntityType =
  | "sprint"
  | "joke"
  | "list"
  | "crash"
  | "ideas"
  | "gig";

export interface Deletion {
  type: EntityType;
  id: string;
}

export interface ChangesResult {
  /** SYNC_PROTOCOL_VERSION the SERVER speaks. Absent on older builds. Used to
   *  warn when the server has moved past what this plugin can express. */
  version?: number;
  now: string;
  sprints: SprintDTO[];
  jokes: JokeDTO[];
  lists: ListDTO[];
  crashes: CrashDTO[];
  deletions: Deletion[];
  ideas?: IdeasDocDTO | null;
  gigs?: GigDTO[];
  /** Absent on a server build from before tags went over the wire. */
  tags?: TagDTO[];
}

/**
 * A tag as the server sends it: its name and every entity it is on. The
 * plugin keeps these in `settings.tags` (see StoredTag) because a change to a
 * tag comes down as the TAG, never as the jokes it touches: attaching,
 * detaching and renaming all bump the tag's updatedAt and nothing on the
 * joke. So the joke notes that now show the wrong tags are only knowable
 * from what the store held before the pull.
 */
export interface TagDTO {
  type: "tag";
  id: string;
  name: string;
  normalizedName: string;
  color: string;
  links: Array<{ entityType: string; entityId: string }>;
  createdAt: string;
  updatedAt: string;
}

/** What the plugin remembers of a tag between syncs: enough to render a
 *  joke's `tags` property and to know which notes a change invalidates. */
export interface StoredTag {
  name: string;
  jokeIds: string[];
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
  hinge?: string;
  keyWords?: string[];
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
  theme?: string;
  angle?: string;
  stage?: number;
  status?: string | null;
  notes?: string;
  performanceNotes?: string;
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
  lists?: JokeListPush[];
}

/**
 * The joke statuses the server's push schema accepts. The server validates
 * this as a zod enum, and ONE bad value 400s the entire push (every joke,
 * list and sprint in it), so a hand-typed status is checked against this list
 * client-side and dropped rather than sent.
 */
export const JOKE_STATUSES = [
  "tested",
  "working",
  "hit",
  "needsrewrite",
  "retired",
] as const;

/**
 * A gig push. Only outcome + retro fields are editable: a gig is born in the
 * app when a set's lineup is snapshotted, so there is no create path here and
 * `id` is required (not optional like every other push).
 *
 * There is also no `ref`: the server echoes the gig id back as the result's
 * `ref`, so the sync engine resolves gig results by id, not by file path.
 */
export interface GigLineupPush {
  id: string;
  laughs?: string[];
  rating?: number | null;
  note?: string;
  isNew?: boolean;
}

export interface GigPush {
  id: string;
  baseUpdatedAt?: string;
  venue?: string;
  vibe?: string;
  billPosition?: string;
  followed?: string;
  crowd?: string;
  actualMinutes?: number | null;
  firstApplauseSeconds?: number | null;
  recordingUrl?: string | null;
  recordingReviewed?: boolean;
  wentWell?: string;
  wentBadly?: string;
  notes?: string;
  routineNotes?: Record<string, string>;
  lineup?: GigLineupPush[];
}

export interface IdeasPush {
  ref: string;
  id?: string;
  baseUpdatedAt?: string;
  items: { id: string; text: string }[];
}

/** The sync wire version this plugin speaks. Sent on every push so the server
 *  knows which fields we can actually express: a build that stayed silent here
 *  predates list nesting, and the server preserves `parentId` for it rather
 *  than reading our flat items array as "un-nest everything". */
export const CLIENT_PROTOCOL_VERSION = 5;

export interface PushBody {
  sprints?: SprintPush[];
  jokes?: JokePush[];
  lists?: ListPush[];
  crashes?: CrashPush[];
  ideas?: IdeasPush[];
  gigs?: GigPush[];
  deletes?: Deletion[];
  protocolVersion?: number;
}

export type PushStatus =
  | "created"
  | "updated"
  | "conflict"
  | "deleted"
  | "error";

export interface PushResult {
  /** The file path we sent as `ref` - EXCEPT for gigs, where the server has no
   *  ref to echo and returns the gig id instead. */
  ref: string;
  type: EntityType;
  status: PushStatus;
  id?: string;
  updatedAt?: string;
  server?: SprintDTO | JokeDTO | ListDTO | CrashDTO | IdeasDocDTO | GigDTO;
  message?: string;
}

export interface PushResponse {
  now: string;
  results: PushResult[];
}

// --- Plugin-local persisted state ---

export interface SyncRecord {
  id: string;
  type: SyncedEntityType;
  /** Vault-relative path of the file representing this item. */
  path: string;
  /** Server updatedAt we last reconciled with - our conflict-detection base. */
  baseUpdatedAt: string;
  /** Hash of the file content at last sync, to detect local edits. */
  hash: string;
}

export interface JokeBakerySyncSettings {
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
  /** Every live tag the server has sent, keyed by tag id. See TagDTO for why
   *  the plugin has to keep these rather than read them off each joke. */
  tags: Record<string, StoredTag>;
  /** False until one full pull has filled `tags`. An install that upgraded
   *  into the store already has a cursor, and every tag it owns predates
   *  that cursor, so a normal incremental pull would never send them. */
  tagsPrimed: boolean;
  /** Highest server protocol version we've already warned about, so the
   *  "plugin is out of date" notice appears once per bump, not every sync. */
  protocolNoticeShownFor: number;
}

/** The pre-rebrand default server URL — migrated to the new domain on load. */
export const LEGACY_SERVER_URL = "https://bakerwriter.vercel.app";

export const DEFAULT_SETTINGS: JokeBakerySyncSettings = {
  serverUrl: "https://jokebakery.com",
  token: "",
  folder: "JokeBakery",
  autoSync: true,
  syncIntervalMin: 5,
  lastSyncCursor: "",
  lastSyncAt: "",
  records: {},
  pendingDeletes: [],
  tags: {},
  tagsPrimed: false,
  protocolNoticeShownFor: 0,
};
