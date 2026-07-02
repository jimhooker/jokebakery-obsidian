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
  jokeToMarkdown,
  listToMarkdown,
  parseCrashFile,
  parseJokeFile,
  parseListFile,
  parseSprintFile,
  peekFrontmatter,
  sprintToMarkdown,
  stripSyncIdentity,
} from "../src/serialize";
import type { CrashDTO, JokeDTO, ListDTO, SprintDTO } from "../src/types";

function jokeDTO(overrides: Partial<JokeDTO> = {}): JokeDTO {
  return {
    type: "joke",
    id: "jk_123",
    title: "Airline food",
    premise: "Airports are tiny failed cities",
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
    notes: "some notes",
    performanceNotes: "slow down",
    setupChecklistDone: ["chk1"],
    setupRhythm: { keys: [1, 3], colours: [0, 2] },
    developmentRhythm: { keys: [], colours: [] },
    punchlineRhythm: { keys: [5], colours: [1] },
    setupIEN: ["I", "N"],
    developmentIEN: [null],
    punchlineIEN: ["E"],
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
