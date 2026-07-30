/**
 * Round-trip tests for the Markdown <-> DTO translation layer. The two
 * properties that matter:
 *
 *   1. emit -> parse is lossless for every entity (a pulled file pushes back
 *      unchanged), and
 *   2. parsing survives Obsidian-NORMALIZED frontmatter - the block-style
 *      arrays / requoted scalars Obsidian writes whenever a user touches any
 *      property in the Properties UI. Misreading those as empty erased fields
 *      server-side before this suite existed.
 */
import { describe, expect, it } from "vitest";
import {
  crashToMarkdown,
  ideasToMarkdown,
  isFileSyncConflictCopy,
  jokeToMarkdown,
  listToMarkdown,
  gigToMarkdown,
  parseCrashFile,
  parseGigFile,
  parseIdeasFile,
  parseJokeFile,
  parseListFile,
  parseSprintFile,
  peekFrontmatter,
  sprintToMarkdown,
  stripSyncIdentity,
} from "../src/serialize";
import type {
  CrashDTO,
  GigDTO,
  IdeasDocDTO,
  JokeDTO,
  ListDTO,
  SprintDTO,
} from "../src/types";

function jokeDTO(overrides: Partial<JokeDTO> = {}): JokeDTO {
  return {
    type: "joke",
    id: "jk_123",
    title: "Airline food",
    premise: "Airports are tiny failed cities",
    hinge: "failed",
    keyWords: ["airports", "cities"],
    setup: "First line of setup\nSecond line of setup",
    development: "A development line",
    punchline: "The punchline",
    scratchpad: "scratch",
    setupComponents: ["c1"],
    developmentComponents: [],
    punchlineComponents: ["c2", "c3"],
    families: ["observational", "act-out"],
    jokeType: "one-liner",
    jokeFunction: "opener",
    topicTags: ["travel"],
    theme: "alienation",
    angle: "everything is fake",
    stage: 3,
    status: null,
    notes: "some notes",
    performanceNotes: "slow down",
    setupChecklistDone: ["chk1"],
    setupRhythm: { keys: [1, 3], colours: [0, 2] },
    developmentRhythm: { keys: [], colours: [] },
    punchlineRhythm: { keys: [5], colours: [1] },
    setupIEN: ["I", "N"],
    developmentIEN: [null],
    punchlineIEN: ["E"],
    setupBreaths: [2],
    developmentBreaths: [],
    punchlineBreaths: [],
    additionalPunchlines: [
      { id: "ap1", text: "Alt punch", components: [], rhythm: { keys: [], colours: [] } },
    ],
    lists: [{ id: "l1", label: "Airports", items: [], createdAt: "2026-01-01T00:00:00Z" }],
    setupVersions: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

function ideasDTO(overrides: Partial<IdeasDocDTO> = {}): IdeasDocDTO {
  return {
    type: "ideas",
    id: "id_123",
    items: [
      { id: "it1", text: "first idea" },
      { id: "it2", text: "second idea" },
    ],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

describe("joke round trip", () => {
  it("emit -> parse preserves every pushed field", () => {
    const dto = jokeDTO();
    const parsed = parseJokeFile(jokeToMarkdown(dto));

    expect(parsed.id).toBe(dto.id);
    expect(parsed.title).toBe(dto.title);
    expect(parsed.premise).toBe(dto.premise);
    expect(parsed.keyWords).toEqual(dto.keyWords);
    expect(parsed.setup).toBe(dto.setup);
    expect(parsed.development).toBe(dto.development);
    expect(parsed.punchline).toBe(dto.punchline);
    expect(parsed.scratchpad).toBe(dto.scratchpad);
    expect(parsed.notes).toBe(dto.notes);
    expect(parsed.performanceNotes).toBe(dto.performanceNotes);
    expect(parsed.stage).toBe(dto.stage);
    expect(parsed.families).toEqual(dto.families);
    expect(parsed.jokeType).toBe(dto.jokeType);
    expect(parsed.jokeFunction).toBe(dto.jokeFunction);
    expect(parsed.topicTags).toEqual(dto.topicTags);
    expect(parsed.theme).toBe(dto.theme);
    expect(parsed.angle).toBe(dto.angle);
    expect(parsed.setupComponents).toEqual(dto.setupComponents);
    expect(parsed.punchlineComponents).toEqual(dto.punchlineComponents);
    expect(parsed.setupChecklistDone).toEqual(dto.setupChecklistDone);
    expect(parsed.setupRhythm).toEqual(dto.setupRhythm);
    expect(parsed.punchlineRhythm).toEqual(dto.punchlineRhythm);
    expect(parsed.setupIEN).toEqual(dto.setupIEN);
    expect(parsed.punchlineIEN).toEqual(dto.punchlineIEN);
    expect(parsed.additionalPunchlines).toEqual(dto.additionalPunchlines);
    expect(parsed.lists).toEqual([{ label: "Airports", items: [] }]);
  });

  it("preserves values with quotes, colons and unicode", () => {
    const dto = jokeDTO({
      title: "It's a 'title': with — punctuation",
      theme: "true", // YAML boolean lookalike must stay a string
      angle: "2026-06-06", // date lookalike too
    });
    const parsed = parseJokeFile(jokeToMarkdown(dto));
    expect(parsed.title).toBe(dto.title);
    expect(parsed.theme).toBe("true");
    expect(parsed.angle).toBe("2026-06-06");
  });

  it("preserves a multiline premise", () => {
    const dto = jokeDTO({ premise: "line one\nline two" });
    const parsed = parseJokeFile(jokeToMarkdown(dto));
    expect(parsed.premise).toBe("line one\nline two");
  });

  it("clamps IEN tags to the slot's line count", () => {
    // Simulate an Obsidian edit that deleted the second setup line but left
    // the stale bw-meta tags behind.
    const md = jokeToMarkdown(jokeDTO()).replace("\nSecond line of setup", "");
    const parsed = parseJokeFile(md);
    expect(parsed.setup).toBe("First line of setup");
    expect(parsed.setupIEN).toEqual(["I"]);
  });

  it("keeps freeform prose (no headings) as scratchpad", () => {
    const parsed = parseJokeFile("just an idea I had\non two lines\n");
    expect(parsed.scratchpad).toBe("just an idea I had\non two lines");
    expect(parsed.id).toBeUndefined();
  });
});

describe("Obsidian-normalized frontmatter", () => {
  it("reads block-style arrays and requoted scalars (Properties UI rewrite)", () => {
    // What Obsidian writes after the user edits any property in its UI.
    const meta = JSON.stringify({ setupIEN: ["I"], setupRhythm: { keys: [1], colours: [2] } });
    const md = [
      "---",
      "bw-type: joke",
      "bw-id: jk_123",
      'bw-created: "2026-01-01T00:00:00Z"',
      'bw-updated: "2026-01-02T00:00:00Z"',
      "title: Airline food",
      "key-words:",
      "  - airports",
      "  - cities",
      "stage: 3",
      "families:",
      "  - observational",
      "  - act-out",
      "topic-tags:",
      "  - travel",
      "theme: alienation",
      "angle: everything is fake",
      `bw-meta: "${meta.replace(/"/g, '\\"')}"`,
      "---",
      "",
      "## Setup",
      "",
      "First line of setup",
      "",
    ].join("\n");

    const parsed = parseJokeFile(md);
    expect(parsed.id).toBe("jk_123");
    expect(parsed.keyWords).toEqual(["airports", "cities"]);
    expect(parsed.families).toEqual(["observational", "act-out"]);
    expect(parsed.topicTags).toEqual(["travel"]);
    expect(parsed.stage).toBe(3);
    expect(parsed.setupIEN).toEqual(["I"]);
    expect(parsed.setupRhythm).toEqual({ keys: [1], colours: [2] });
  });

  it("falls back leniently on malformed YAML and keeps bw-id", () => {
    const md = [
      "---",
      "bw-id: jk_999",
      "title: fine",
      "broken: [unclosed",
      "---",
      "",
      "## Setup",
      "",
      "text",
      "",
    ].join("\n");
    const parsed = parseJokeFile(md);
    expect(parsed.id).toBe("jk_999");
    expect(parsed.setup).toBe("text");
  });
});

describe("stripSyncIdentity", () => {
  it("drops bw-* keys (incl. block continuations) but keeps user properties", () => {
    const md = [
      "---",
      "bw-type: joke",
      "bw-id: jk_123",
      "title: Airline food",
      "families:",
      "  - observational",
      "bw-meta: '{}'",
      "---",
      "",
      "## Setup",
      "",
      "text",
    ].join("\n");
    const out = stripSyncIdentity(md);
    expect(out).not.toContain("bw-id");
    expect(out).not.toContain("bw-meta");
    expect(out).toContain("title: Airline food");
    expect(out).toContain("- observational");
    expect(out).toContain("## Setup");
    expect(peekFrontmatter(out)["bw-id"]).toBeUndefined();
    expect(peekFrontmatter(out)["title"]).toBe("Airline food");
  });

  it("drops the fence entirely when only bw-* keys exist", () => {
    const md = ["---", "bw-type: sprint", "bw-id: sp_1", "---", "", "# body"].join("\n");
    expect(stripSyncIdentity(md)).toBe("# body");
  });
});

describe("sprint round trip", () => {
  it("preserves jokes including multiline items", () => {
    const dto: SprintDTO = {
      type: "sprint",
      id: "sp_1",
      date: "2026-06-06",
      durationSec: 600,
      jokes: ["first joke", "second joke\nwith a second line", "third"],
      createdAt: "2026-06-06T10:00:00Z",
      updatedAt: "2026-06-06T10:10:00Z",
    };
    const parsed = parseSprintFile(sprintToMarkdown(dto), "1970-01-01");
    expect(parsed.id).toBe("sp_1");
    expect(parsed.date).toBe("2026-06-06");
    expect(parsed.durationSec).toBe(600);
    expect(parsed.jokes).toEqual(dto.jokes);
  });

  it("survives a YAML parser turning the unquoted date into a Date object", () => {
    const md = ["---", "bw-id: sp_2", "bw-date: 2026-06-06", "---", "", "1. a joke"].join("\n");
    const parsed = parseSprintFile(md, "1970-01-01");
    expect(parsed.date).toBe("2026-06-06");
  });
});

describe("list round trip", () => {
  it("preserves items, ids and afterthoughts", () => {
    const dto: ListDTO = {
      type: "list",
      id: "ls_1",
      label: "Dentist",
      items: [
        { id: "it1", text: "drill" },
        { id: "it2", text: "chair", afterthoughts: [{ id: "it3", text: "recliner" }] },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    const parsed = parseListFile(listToMarkdown(dto), "fallback");
    expect(parsed.id).toBe("ls_1");
    expect(parsed.label).toBe("Dentist");
    expect(parsed.items).toEqual(dto.items);
  });

  it("assigns fresh ids to hand-typed bullets and keeps existing block refs", () => {
    const md = ["---", "label: Dentist", "---", "", "- old item ^abc123", "- brand new item"].join("\n");
    const parsed = parseListFile(md, "fallback");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toEqual({ id: "abc123", text: "old item" });
    expect(parsed.items[1]!.text).toBe("brand new item");
    expect(parsed.items[1]!.id).toMatch(/^[a-z0-9]{12}$/);
  });
});

describe("crash round trip", () => {
  it("preserves both sides and the note", () => {
    const dto: CrashDTO = {
      type: "crash",
      id: "cr_1",
      aListId: "ls_1",
      aItemId: "it1",
      aLabel: "Dentist",
      aText: "drill",
      bListId: "ls_2",
      bItemId: "it9",
      bLabel: "Airports",
      bText: "security theatre",
      note: "a drill at security",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    const parsed = parseCrashFile(crashToMarkdown(dto));
    expect(parsed.id).toBe("cr_1");
    expect(parsed.aListId).toBe("ls_1");
    expect(parsed.aItemId).toBe("it1");
    expect(parsed.aLabel).toBe("Dentist");
    expect(parsed.aText).toBe("drill");
    expect(parsed.bListId).toBe("ls_2");
    expect(parsed.bItemId).toBe("it9");
    expect(parsed.bText).toBe("security theatre");
    expect(parsed.note).toBe("a drill at security");
  });
});

describe("ideas round trip", () => {
  it("preserves id and items with their ids", () => {
    const dto = ideasDTO();
    const parsed = parseIdeasFile(ideasToMarkdown(dto));
    expect(parsed.id).toBe("id_123");
    expect(parsed.items).toEqual(dto.items);
  });

  it("renders empty doc with placeholder and parses back to empty", () => {
    const dto = ideasDTO({ items: [] });
    const md = ideasToMarkdown(dto);
    expect(md).toContain("*(empty)*");
    const parsed = parseIdeasFile(md);
    expect(parsed.id).toBe("id_123");
    expect(parsed.items).toEqual([]);
  });

  it("assigns fresh ids to hand-typed bullets without block refs", () => {
    const md = ["---", "bw-id: id_456", "---", "", "# Ideas", "", "- first item", "- second item"].join("\n");
    const parsed = parseIdeasFile(md);
    expect(parsed.id).toBe("id_456");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]!.text).toBe("first item");
    expect(parsed.items[0]!.id).toMatch(/^[a-z0-9]{12}$/);
    expect(parsed.items[1]!.text).toBe("second item");
    expect(parsed.items[1]!.id).toMatch(/^[a-z0-9]{12}$/);
  });

  it("keeps existing block refs and mints fresh ids for new bullets", () => {
    const md = ["---", "label: Ideas", "---", "", "- old idea ^abc123", "- brand new idea"].join("\n");
    const parsed = parseIdeasFile(md);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toEqual({ id: "abc123", text: "old idea" });
    expect(parsed.items[1]!.text).toBe("brand new idea");
    expect(parsed.items[1]!.id).toMatch(/^[a-z0-9]{12}$/);
  });

  it("parses indented bullets as flat ideas (inbox style)", () => {
    const md = [
      "---",
      "bw-id: id_789",
      "---",
      "",
      "# Ideas",
      "",
      "- top level ^top1",
      "    - indented ^ind1",
      "        - deeply indented ^deep1",
      "- another top ^top2",
    ].join("\n");
    const parsed = parseIdeasFile(md);
    expect(parsed.items).toHaveLength(4);
    expect(parsed.items[0]).toEqual({ id: "top1", text: "top level" });
    expect(parsed.items[1]).toEqual({ id: "ind1", text: "indented" });
    expect(parsed.items[2]).toEqual({ id: "deep1", text: "deeply indented" });
    expect(parsed.items[3]).toEqual({ id: "top2", text: "another top" });
  });

  it("ignores headings and the H1 title on parse", () => {
    const md = [
      "---",
      "bw-id: id_999",
      "---",
      "",
      "# Ideas",
      "",
      "## Section heading",
      "",
      "- idea one ^id1",
      "",
      "### Subsection",
      "",
      "- idea two ^id2",
      "",
      "some freeform text",
    ].join("\n");
    const parsed = parseIdeasFile(md);
    expect(parsed.id).toBe("id_999");
    expect(parsed.items).toEqual([
      { id: "id1", text: "idea one" },
      { id: "id2", text: "idea two" },
    ]);
  });
});

describe("the Other voice", () => {
  it("round-trips O and names it in the Voices section", () => {
    const dto = jokeDTO({
      setup: "One line\nTwo line",
      setupIEN: ["O", "I"],
    });
    const md = jokeToMarkdown(dto);

    // The bug this guards: a build that only knew I/E/N rendered `**undefined**`
    // here and pushed the O tag back as null, wiping it server-side.
    expect(md).toContain("**OTHER** — One line");
    expect(parseJokeFile(md).setupIEN).toEqual(["O", "I"]);
  });

  it("still discards a voice that isn't a voice", () => {
    const md = jokeToMarkdown(jokeDTO()).replace(
      /"setupIEN":\[[^\]]*\]/,
      '"setupIEN":["I","X"]'
    );
    expect(parseJokeFile(md).setupIEN).toEqual(["I", null]);
  });
});

describe("joke status", () => {
  it("round-trips a real status", () => {
    const md = jokeToMarkdown(jokeDTO({ status: "hit" }));
    expect(md).toMatch(/^status: hit$/m);
    expect(parseJokeFile(md).status).toBe("hit");
  });

  it("omits the key when no status is set", () => {
    expect(jokeToMarkdown(jokeDTO({ status: null }))).not.toMatch(/^status:/m);
  });

  it("drops a status the server's enum would reject", () => {
    // One bad enum value 400s the WHOLE push, so a typo must not be sent.
    const md = jokeToMarkdown(jokeDTO({ status: "hit" })).replace(
      "status: hit",
      "status: hilarious"
    );
    expect(parseJokeFile(md).status).toBeUndefined();
  });

  it("treats an explicitly empty status as 'clear it'", () => {
    const md = jokeToMarkdown(jokeDTO({ status: "hit" })).replace(
      "status: hit",
      "status: ''"
    );
    expect(parseJokeFile(md).status).toBeNull();
  });
});

describe("breaths", () => {
  it("round-trips through bw-meta", () => {
    const md = jokeToMarkdown(jokeDTO({ setupBreaths: [1, 4], punchlineBreaths: [2] }));
    const parsed = parseJokeFile(md);
    expect(parsed.setupBreaths).toEqual([1, 4]);
    expect(parsed.punchlineBreaths).toEqual([2]);
  });
});

describe("gig round trip", () => {
  const dto: GigDTO = {
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
    recordingUrl: "https://example.com/set.mp3",
    recordingReviewed: true,
    wentWell: "The opener landed.",
    wentBadly: "Lost them in the middle.",
    notes: "Bring the shorter mic stand.",
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
        isNew: true,
        laughs: ["rolling", "recognition"],
        rating: 4,
        note: "Solid.",
      },
    ],
    createdAt: "2026-07-14T22:00:00Z",
    updatedAt: "2026-07-15T09:00:00Z",
  };

  it("preserves every editable field", () => {
    const md = gigToMarkdown(dto, (id) => `[[${id}]]`);
    const { push, warnings } = parseGigFile(md);

    expect(warnings).toEqual([]);
    expect(push).toMatchObject({
      id: "gig1",
      venue: "The Comedy Cellar",
      vibe: "Rowdy",
      billPosition: "opener",
      followed: "A juggler",
      crowd: "80, mostly couples",
      actualMinutes: 22,
      firstApplauseSeconds: 150,
      recordingUrl: "https://example.com/set.mp3",
      recordingReviewed: true,
      wentWell: "The opener landed.",
      wentBadly: "Lost them in the middle.",
      notes: "Bring the shorter mic stand.",
      routineNotes: { r1: "Never gets going before the callback." },
    });
    expect(push?.lineup).toEqual([
      { id: "lin1", rating: 4, laughs: ["rolling", "recognition"], isNew: true, note: "Solid." },
    ]);
  });

  it("never sends the fields a gig owns rather than the vault", () => {
    const { push } = parseGigFile(gigToMarkdown(dto, (id) => id));
    for (const readOnly of ["date", "setId", "setTitle", "plannedMinutes", "nextTime", "lineupOrder"]) {
      expect(push).not.toHaveProperty(readOnly);
    }
  });

  it("reads laugh types by label or by slug", () => {
    const md = gigToMarkdown(dto, (id) => id).replace(
      "laughs: Rolling, Recognition",
      "laughs: groan, Applause break"
    );
    expect(parseGigFile(md).push?.lineup?.[0]?.laughs).toEqual([
      "groan",
      "applausebreak",
    ]);
  });

  it("refuses a recording URL that isn't http(s)", () => {
    const md = gigToMarkdown(dto, (id) => id).replace(
      /^recording-url: .*$/m,
      "recording-url: 'javascript:alert(1)'"
    );
    const { push, warnings } = parseGigFile(md);
    expect(push).not.toHaveProperty("recordingUrl");
    expect(warnings.join(" ")).toContain("http://");
  });

  it("won't send an emptied venue, which the server requires", () => {
    const md = gigToMarkdown(dto, (id) => id).replace(
      "venue: The Comedy Cellar",
      "venue: ''"
    );
    const { push, warnings } = parseGigFile(md);
    expect(push?.venue).toBeUndefined();
    expect(warnings.join(" ")).toContain("Venue");
  });

  it("has nothing to push for a note that was never a gig", () => {
    expect(parseGigFile("# Last night\n\nWent fine.\n").push).toBeUndefined();
  });
});

describe("file-sync conflict copies", () => {
  it("spots the copies a file-sync tool leaves beside a note", () => {
    // Syncthing, as seen in the wild flip-flopping a real list.
    expect(
      isFileSyncConflictCopy(
        "things-my-mum-can-do-from-her-chair.sync-conflict-20260721-100720-2QQTU7R"
      )
    ).toBe(true);
    expect(
      isFileSyncConflictCopy("My list (jim's conflicted copy 2026-07-21)")
    ).toBe(true);
    expect(isFileSyncConflictCopy("My list (conflict 2026-07-21 10-07-20)")).toBe(
      true
    );
  });

  it("leaves notes a human would plausibly name alone", () => {
    expect(isFileSyncConflictCopy("things-my-mum-can-do-from-her-chair")).toBe(
      false
    );
    // iCloud's `Note 2` shape is deliberately not matched - too close to real
    // names, and ignoring a genuine note is worse than syncing a stray copy.
    expect(isFileSyncConflictCopy("Set 2")).toBe(false);
    expect(isFileSyncConflictCopy("Jokes about conflict")).toBe(false);
    expect(isFileSyncConflictCopy("Conflict (the play)")).toBe(false);
  });
});
