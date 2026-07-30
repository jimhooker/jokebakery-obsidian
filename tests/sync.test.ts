/**
 * Sync engine tests.
 *
 * The serializer suite covers "does a file round-trip". This one covers the
 * decisions AROUND that: what gets pushed, what gets left alone, and what
 * happens when the two sides disagree. Those are the paths where a bug costs
 * somebody real material, and until this file existed none of them ran outside
 * a live vault.
 */
import { describe, expect, it } from "vitest";
import { SyncEngine, MASS_DELETE_LIMIT } from "../src/sync";
import { jokeToMarkdown, gigToMarkdown } from "../src/serialize";
import {
  DEFAULT_SETTINGS,
  type GigDTO,
  type JokeBakerySyncSettings,
  type JokeDTO,
} from "../src/types";
import { FakeApi, FakeApp, emptyChanges } from "./fake-vault";

const NOW = "2026-07-30T12:00:00.000Z";
const EARLIER = "2026-07-01T09:00:00.000Z";

function settings(overrides: Partial<JokeBakerySyncSettings> = {}): JokeBakerySyncSettings {
  return {
    ...DEFAULT_SETTINGS,
    token: "bw_test",
    records: {},
    pendingDeletes: [],
    ...overrides,
  };
}

function makeEngine(
  app: FakeApp,
  api: FakeApi,
  s: JokeBakerySyncSettings,
  confirmMassDelete: (n: number) => Promise<boolean> = () => Promise.resolve(false)
) {
  return new SyncEngine(
    app as never,
    s,
    () => Promise.resolve(),
    confirmMassDelete,
    () => api
  );
}

function jokeDTO(overrides: Partial<JokeDTO> = {}): JokeDTO {
  return {
    type: "joke",
    id: "joke1",
    title: "The cat one",
    premise: "Cats run the house",
    hinge: "run",
    keyWords: ["cat"],
    setup: "My cat has a routine.",
    development: "",
    punchline: "I live here on sufferance.",
    scratchpad: "",
    setupComponents: [],
    developmentComponents: [],
    punchlineComponents: [],
    families: ["Observational"],
    jokeType: "",
    jokeFunction: "",
    topicTags: [],
    theme: "",
    angle: "",
    stage: 2,
    status: null,
    notes: "",
    performanceNotes: "",
    setupChecklistDone: [],
    setupRhythm: { keys: [], colours: [] },
    developmentRhythm: { keys: [], colours: [] },
    punchlineRhythm: { keys: [], colours: [] },
    setupIEN: [],
    developmentIEN: [],
    punchlineIEN: [],
    setupBreaths: [],
    developmentBreaths: [],
    punchlineBreaths: [],
    additionalPunchlines: [],
    lists: [],
    setupVersions: [],
    createdAt: EARLIER,
    updatedAt: NOW,
    ...overrides,
  };
}

function gigDTO(overrides: Partial<GigDTO> = {}): GigDTO {
  return {
    id: "gig1",
    setId: "set1",
    setTitle: "Twenty at the Cellar",
    date: "2026-07-14",
    venue: "The Comedy Cellar",
    vibe: "Rowdy",
    billPosition: "opener",
    followed: "A juggler",
    crowd: "80, mostly couples",
    plannedMinutes: 20,
    actualMinutes: 22,
    firstApplauseSeconds: 150,
    recordingUrl: null,
    recordingReviewed: false,
    wentWell: "The opener landed.",
    wentBadly: "Lost them in the middle.",
    notes: "",
    nextTime: [{ id: "n1", text: "Cut the airport bit", ideaId: null }],
    routineNotes: { r1: "Never gets going before the callback." },
    lineup: [
      {
        id: "lin1",
        jokeId: "joke1",
        routineId: "r1",
        routineTitle: "Airport bit",
        position: 1,
        performed: "performed",
        isNew: false,
        laughs: ["rolling"],
        rating: 4,
        note: "Solid.",
      },
      {
        id: "lin2",
        jokeId: "joke2",
        routineId: "r1",
        routineTitle: "Airport bit",
        position: 2,
        performed: "dropped",
        isNew: true,
        laughs: [],
        rating: null,
        note: "",
      },
    ],
    createdAt: EARLIER,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("pull", () => {
  it("writes a pulled joke and records it", async () => {
    const app = new FakeApp();
    const api = new FakeApi(emptyChanges({ jokes: [jokeDTO()] }));
    const s = settings();

    await makeEngine(app, api, s).syncNow({ silent: true });

    const path = "JokeBakery/Jokes/the-cat-one.md";
    expect(app.read(path)).toContain("My cat has a routine.");
    expect(s.records["joke1"]).toMatchObject({ type: "joke", path, baseUpdatedAt: NOW });
    expect(s.lastSyncCursor).toBe(NOW);
  });

  it("trashes the local copy when the server tombstones an item", async () => {
    const app = new FakeApp();
    const path = "JokeBakery/Jokes/the-cat-one.md";
    app.write(path, jokeToMarkdown(jokeDTO()));
    const s = settings({
      records: {
        joke1: { id: "joke1", type: "joke", path, baseUpdatedAt: NOW, hash: "x" },
      },
    });
    // Same hash as the file, so the push phase sees nothing to send.
    s.records["joke1"]!.hash = hashOf(app.read(path)!);

    const api = new FakeApi(
      emptyChanges({ deletions: [{ type: "joke", id: "joke1" }] })
    );
    const summary = await makeEngine(app, api, s).syncNow({ silent: true });

    expect(app.read(path)).toBeUndefined();
    expect(app.vault.trashed).toEqual([path]);
    expect(s.records["joke1"]).toBeUndefined();
    expect(summary.deleted).toBe(1);
  });

  it("keeps local edits and parks the server copy in Conflicts/", async () => {
    const app = new FakeApp();
    const path = "JokeBakery/Jokes/the-cat-one.md";
    app.write(path, "---\nbw-id: joke1\n---\n\n## Setup\n\nMy own edit.\n");
    const s = settings({
      records: {
        joke1: {
          id: "joke1",
          type: "joke",
          path,
          baseUpdatedAt: EARLIER,
          // Stale hash => the file counts as locally edited.
          hash: "stale",
        },
      },
    });
    // Nothing to push (the push phase would clear the dirt), so drive the pull
    // directly by answering the push with an empty result set.
    const api = new FakeApi(emptyChanges({ jokes: [jokeDTO()] }), () => ({
      now: NOW,
      results: [],
    }));

    const summary = await makeEngine(app, api, s).syncNow({ silent: true });

    expect(app.read(path)).toContain("My own edit.");
    const conflict = [...app.vault.files.keys()].find((p) =>
      p.startsWith("JokeBakery/Conflicts/")
    );
    expect(conflict).toBeDefined();
    expect(summary.conflicts).toBe(1);
  });
});

describe("push", () => {
  it("mints an id for a new note so a retried create can't duplicate it", async () => {
    const app = new FakeApp();
    app.write("JokeBakery/Jokes/new-one.md", "## Setup\n\nA brand new joke.\n");
    const s = settings();
    const api = new FakeApi();

    await makeEngine(app, api, s).syncNow({ silent: true });

    const pushed = api.lastPush?.jokes?.[0];
    expect(pushed?.id).toBeTruthy();
    expect(pushed?.setup).toBe("A brand new joke.");
    // The id we sent is the id the note ends up carrying.
    expect(app.read("JokeBakery/Jokes/new-one.md")).toContain(`bw-id: ${pushed!.id}`);
  });

  it("sends the protocol version on every push", async () => {
    const app = new FakeApp();
    app.write("JokeBakery/Jokes/new-one.md", "## Setup\n\nSomething.\n");
    const api = new FakeApi();

    await makeEngine(app, api, settings()).syncNow({ silent: true });

    expect(api.lastPush?.protocolVersion).toBe(5);
  });

  it("ignores a file two notes claim, rather than letting them fight", async () => {
    const app = new FakeApp();
    const content = jokeToMarkdown(jokeDTO());
    app.write("JokeBakery/Jokes/the-cat-one.md", content);
    app.write("JokeBakery/Jokes/the-cat-one-copy.md", content);
    const s = settings();
    const api = new FakeApi();

    const summary = await makeEngine(app, api, s).syncNow({ silent: true });

    expect(api.lastPush?.jokes ?? []).toHaveLength(1);
    expect(summary.errors.join(" ")).toContain("share the id joke1");
  });
});

describe("frontmatter absence is not an instruction", () => {
  /**
   * The regression this suite exists for. A note written before a field
   * existed simply has no such key. Coercing that to "" and pushing it tells
   * the server to CLEAR a value the user set on the web.
   */
  const noPremise = [
    "---",
    "bw-type: joke",
    "bw-id: joke1",
    "bw-created: 2026-07-01T09:00:00.000Z",
    "bw-updated: 2026-07-01T09:00:00.000Z",
    "title: The cat one",
    "stage: 2",
    "bw-meta: '{}'",
    "---",
    "",
    "## Setup",
    "",
    "Edited in Obsidian.",
    "",
  ].join("\n");

  it("pushes no premise when the note never had one", async () => {
    const app = new FakeApp();
    const path = "JokeBakery/Jokes/the-cat-one.md";
    app.write(path, noPremise);
    const s = settings({
      records: {
        joke1: { id: "joke1", type: "joke", path, baseUpdatedAt: EARLIER, hash: "stale" },
      },
    });
    const api = new FakeApi();

    await makeEngine(app, api, s).syncNow({ silent: true });

    const pushed = api.lastPush?.jokes?.[0];
    expect(pushed).toBeDefined();
    expect("premise" in pushed!).toBe(false);
    expect("hinge" in pushed!).toBe(false);
    expect("families" in pushed!).toBe(false);
    // The edit we DID make still goes.
    expect(pushed!.setup).toBe("Edited in Obsidian.");
  });

  it("does not write a fabricated blank back into the note after pushing", async () => {
    const app = new FakeApp();
    const path = "JokeBakery/Jokes/the-cat-one.md";
    app.write(path, noPremise);
    const s = settings({
      records: {
        joke1: { id: "joke1", type: "joke", path, baseUpdatedAt: EARLIER, hash: "stale" },
      },
    });
    const api = new FakeApi();

    await makeEngine(app, api, s).syncNow({ silent: true });

    // If the re-write put `premise: ''` in, the NEXT push would send it as a
    // real "clear this" - the clobber would just be one sync later.
    expect(app.read(path)).not.toMatch(/^premise:/m);
    expect(app.read(path)).not.toMatch(/^hinge:/m);
  });

  it("fills in defaults on a CREATE, where absent really does mean empty", async () => {
    const app = new FakeApp();
    app.write("JokeBakery/Jokes/fresh.md", "## Setup\n\nBrand new.\n");
    const api = new FakeApi();

    await makeEngine(app, api, settings()).syncNow({ silent: true });

    expect(app.read("JokeBakery/Jokes/fresh.md")).toMatch(/^premise: ''$/m);
  });

  it("keeps the server's marks when a note has lost its bw-meta", async () => {
    const app = new FakeApp();
    const path = "JokeBakery/Jokes/the-cat-one.md";
    app.write(
      path,
      "---\nbw-type: joke\nbw-id: joke1\ntitle: The cat one\n---\n\n## Setup\n\nEdited.\n"
    );
    const s = settings({
      records: {
        joke1: { id: "joke1", type: "joke", path, baseUpdatedAt: EARLIER, hash: "stale" },
      },
    });
    const api = new FakeApi();

    await makeEngine(app, api, s).syncNow({ silent: true });

    const pushed = api.lastPush?.jokes?.[0];
    // No zeroed arrays: the components and rhythm marks stay where they are.
    expect("setupComponents" in pushed!).toBe(false);
    expect("setupRhythm" in pushed!).toBe(false);
    expect("setupIEN" in pushed!).toBe(false);
    // And the note is marked for repair from server truth on the next pull.
    expect(s.records["joke1"]!.baseUpdatedAt).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("gigs", () => {
  it("writes a pulled gig, linking each lineup joke to its note", async () => {
    const app = new FakeApp();
    const s = settings({
      records: {
        joke1: {
          id: "joke1",
          type: "joke",
          path: "JokeBakery/Jokes/the-cat-one.md",
          baseUpdatedAt: NOW,
          hash: "h",
        },
      },
    });
    const api = new FakeApi(emptyChanges({ gigs: [gigDTO()] }));

    await makeEngine(app, api, s).syncNow({ silent: true });

    const path = "JokeBakery/Gigs/2026-07-14-the-comedy-cellar.md";
    const note = app.read(path);
    expect(note).toBeDefined();
    // A synced joke becomes a link; an unsynced one degrades to its id.
    expect(note).toContain("[[the-cat-one]]");
    expect(note).toContain("joke2");
    expect(note).toContain("rating: 4");
    expect(note).toContain("laughs: Rolling");
    expect(note).toContain("*(dropped)*");
    expect(note).toContain("Cut the airport bit");
    expect(s.records["gig1"]).toMatchObject({ type: "gig", path });
  });

  it("pushes edited outcomes and leaves the read-only parts alone", async () => {
    const app = new FakeApp();
    const path = "JokeBakery/Gigs/2026-07-14-the-comedy-cellar.md";
    const note = gigToMarkdown(gigDTO(), (id) => `joke ${id}`)
      .replace("rating: 4", "rating: 5")
      .replace("laughs: Rolling", "laughs: Rolling, Applause break")
      .replace("Lost them in the middle.", "Lost them in the middle, then won them back.");
    app.write(path, note);
    const s = settings({
      records: {
        gig1: { id: "gig1", type: "gig", path, baseUpdatedAt: EARLIER, hash: "stale" },
      },
    });
    const api = new FakeApi();

    await makeEngine(app, api, s).syncNow({ silent: true });

    const pushed = api.lastPush?.gigs?.[0];
    expect(pushed?.id).toBe("gig1");
    expect(pushed?.wentBadly).toBe("Lost them in the middle, then won them back.");
    expect(pushed?.lineup).toContainEqual(
      expect.objectContaining({ id: "lin1", rating: 5, laughs: ["rolling", "applausebreak"] })
    );
    // Read-only fields are never sent, whatever the note says.
    expect(pushed).not.toHaveProperty("date");
    expect(pushed).not.toHaveProperty("setId");
    expect(pushed).not.toHaveProperty("nextTime");
  });

  it("drops a value the server would reject instead of failing the whole sync", async () => {
    const app = new FakeApp();
    const path = "JokeBakery/Gigs/2026-07-14-the-comedy-cellar.md";
    app.write(
      path,
      gigToMarkdown(gigDTO(), (id) => `joke ${id}`)
        .replace("rating: 4", "rating: 9")
        .replace("laughs: Rolling", "laughs: Belly laugh")
    );
    const s = settings({
      records: {
        gig1: { id: "gig1", type: "gig", path, baseUpdatedAt: EARLIER, hash: "stale" },
      },
    });
    const api = new FakeApi();

    const summary = await makeEngine(app, api, s).syncNow({ silent: true });

    const lin1 = api.lastPush?.gigs?.[0]?.lineup?.find((l) => l.id === "lin1");
    expect(lin1?.rating).toBeUndefined();
    expect(lin1?.laughs).toEqual([]);
    expect(summary.errors.join(" ")).toContain("must be 1-5");
    expect(summary.errors.join(" ")).toContain("isn't a laugh type");
  });

  it("refuses to invent a gig from a hand-made note", async () => {
    const app = new FakeApp();
    app.write("JokeBakery/Gigs/last-night.md", "# Last night\n\nWent fine.\n");
    const api = new FakeApi();

    const summary = await makeEngine(app, api, settings()).syncNow({ silent: true });

    expect(api.lastPush).toBeUndefined();
    expect(summary.errors.join(" ")).toContain("created in the app");
  });
});

describe("safety rails", () => {
  it("holds a pile of deletions back until a human confirms", async () => {
    const app = new FakeApp();
    const pendingDeletes = Array.from({ length: MASS_DELETE_LIMIT }, (_, i) => ({
      type: "joke" as const,
      id: `joke${i}`,
    }));
    const s = settings({ pendingDeletes });
    const api = new FakeApi();

    const summary = await makeEngine(app, api, s, () => Promise.resolve(false)).syncNow({
      silent: true,
    });

    expect(api.lastPush).toBeUndefined();
    expect(summary.errors.join(" ")).toContain("held back");
    // Still queued, so confirming later still works.
    expect(s.pendingDeletes).toHaveLength(MASS_DELETE_LIMIT);
  });

  it("sends them once confirmed", async () => {
    const app = new FakeApp();
    const pendingDeletes = Array.from({ length: MASS_DELETE_LIMIT }, (_, i) => ({
      type: "joke" as const,
      id: `joke${i}`,
    }));
    const api = new FakeApi();

    await makeEngine(app, api, settings({ pendingDeletes }), () =>
      Promise.resolve(true)
    ).syncNow({ silent: true });

    expect(api.lastPush?.deletes).toHaveLength(MASS_DELETE_LIMIT);
  });

  it("warns once when the server speaks a newer wire version", async () => {
    const app = new FakeApp();
    const s = settings();
    const api = new FakeApi(emptyChanges({ version: 99 }));

    const first = await makeEngine(app, api, s).syncNow({ silent: true });
    expect(first.errors.join(" ")).toContain("Update JokeBakery Sync");

    const second = await makeEngine(app, api, s).syncNow({ silent: true });
    expect(second.errors.join(" ")).not.toContain("Update JokeBakery Sync");
  });

  it("says nothing when the server is on the same version", async () => {
    const app = new FakeApp();
    const api = new FakeApi(emptyChanges({ version: 5 }));

    const summary = await makeEngine(app, api, settings()).syncNow({ silent: true });

    expect(summary.errors).toEqual([]);
  });

  it("does not fork Ideas.md when the file exists but the record doesn't", async () => {
    const app = new FakeApp();
    app.write("JokeBakery/Ideas.md", "# Ideas\n\n- an idea I typed\n");
    const api = new FakeApi(
      emptyChanges({
        ideas: {
          type: "ideas",
          id: "ideas-inbox",
          items: [{ id: "i1", text: "from the app" }],
          createdAt: EARLIER,
          updatedAt: NOW,
        },
      }),
      () => ({ now: NOW, results: [] })
    );

    await makeEngine(app, api, settings()).syncNow({ silent: true });

    const ideaFiles = [...app.vault.files.keys()].filter((p) => p.includes("Ideas"));
    expect(ideaFiles).toEqual(["JokeBakery/Ideas.md"]);
  });
});

/** FNV-1a, matching src/serialize.ts - so a test can pre-seed a clean record. */
function hashOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
