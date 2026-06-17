# BakerWriter Sync (Obsidian plugin)

Two-way sync between [BakerWriter](https://github.com/jimhooker/bakerwriter) and an
Obsidian vault. Your **sprints**, **jokes** and **lists** become Markdown files
you can read and edit in Obsidian; edits flow back to BakerWriter on the next
sync.

## What you get in the vault

```
<folder>/
  Sprints/
    2026-06-06.md        # one "10 in 10" sprint per file, named by its date
  Jokes/
    whats-the-deal-with-airline-food.md
  Lists/
    dentist.md           # one reusable list per file
  Conflicts/             # auto-created only when a sync conflict happens
```

- **Sprints** → `Sprints/YYYY-MM-DD.md`. A numbered list of joke lines. If you do
  two sprints in one day the second is `…-2.md`; identity is the `bw-id` in the
  file's frontmatter, not the filename, so renaming is safe.
- **Jokes** → `Jokes/<slug>.md`. Editable prose under `## Setup`,
  `## Development`, `## Punchline`, plus `## Notes` and `## Scratchpad`.
  Structured fields (stage, families, tags, theme, angle) are Obsidian
  properties; rhythm/IEN markup rides in an opaque `bw-meta` property.
- **Lists** → `Lists/<slug>.md`. A user-owned, reusable list: its items are a
  plain bullet list in the body; edit them here. A list can be attached to many
  jokes (attach/detach in BakerWriter).

A joke's `## Lists` section is now a **read-only** list of the labels attached to
that joke — open the matching note in `Lists/` to edit a list's contents.
`## Alternative punchlines` and `## Setup versions` are likewise read-only —
manage those in BakerWriter.

## Setup

1. In BakerWriter, go to **Settings → Obsidian sync** and **create an access
   token**. Copy it (you only see it once).
2. Install this plugin (see below), enable it, open its settings, and fill in:
   - **Server URL** — your BakerWriter address, e.g. `https://bakerwriter.vercel.app`
   - **Access token** — the token you just created
   - **Vault folder** — defaults to `BakerWriter`
3. Click **Test connection**, then **Sync now**. Auto-sync (on startup + on a
   timer) is on by default.

## Creating items from Obsidian

- **New sprint:** add a note in `<folder>/Sprints` named after its date
  (`2026-06-10.md`) and write one joke per line (numbered or not).
- **New joke:** add a note in `<folder>/Jokes`. Use `## Setup` / `## Punchline`
  headings, or just write freeform — freeform text lands in the joke's
  scratchpad.
- **New list:** add a note in `<folder>/Lists`. The note title (or `label`
  property) is the list name; write one item per bullet line.

On the next sync these are created in BakerWriter and get their `bw-id` written
back into the file.

## Conflicts

Sync is last-writer-wins by modified time. If the same item changed on *both*
sides between syncs, nothing is lost: the losing version is written to
`<folder>/Conflicts/…` for you to merge by hand.

## Deletions

Deletions sync **both ways**:

- Delete a joke, sprint, or list in **BakerWriter** → its file is removed from
  the vault on the next pull.
- Delete a synced **file in Obsidian** → the item is removed in BakerWriter on
  the next push. (BakerWriter keeps it as a soft-deleted tombstone, so it's
  recoverable in the database if needed.)

Caveat: Obsidian-side deletions are detected while the plugin is running. Delete
items as **individual files** — deleting a synced file you no longer want is the
reliable signal. If a synced file goes missing without a delete event (e.g. it
was removed outside Obsidian), the next pull treats the server as authoritative
and restores it.

## Limitations (v1)

- Rhythm/IEN word-index markup and alternative punchlines are **pull-only** —
  edit them in BakerWriter, not Obsidian.

## Installing

### With BRAT (recommended)

The easiest way to add this to Obsidian today:

1. Install the **BRAT** community plugin (Beta Reviewer's Auto-update Tool) and
   enable it.
2. BRAT → **Add Beta plugin** → paste this repo:
   `https://github.com/jimhooker/bakerwriter-obsidian`
3. BRAT installs the latest release. In Obsidian go to **Settings → Community
   plugins** and enable **BakerWriter Sync**, then configure it (see *Setup*).

BRAT keeps the plugin updated as new releases are published here.

### Manual

1. Download `main.js`, `manifest.json` and `versions.json` from the
   [latest release](https://github.com/jimhooker/bakerwriter-obsidian/releases),
   or build them yourself with `npm install && npm run build`.
2. Copy them into `<your-vault>/.obsidian/plugins/bakerwriter-sync/`.
3. In Obsidian: **Settings → Community plugins**, enable **BakerWriter Sync**.

### Develop

`npm run dev` runs esbuild in watch mode. Symlink this folder into your vault's
`.obsidian/plugins/` to iterate live.

## How it works

The plugin talks to BakerWriter's `/api/sync` REST API with a Bearer token.
Each sync runs **push** (send new/edited vault files) then **pull** (write
changed server items into the vault). All Markdown ⇄ JSON translation happens
here in the plugin; the server only ever speaks JSON. See `src/serialize.ts`
for the file format and `src/sync.ts` for the sync algorithm.
