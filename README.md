# JokeBakery Sync (Obsidian plugin)

Two-way sync between [JokeBakery](https://jokebakery.com) and an
Obsidian vault. Your **sprints**, **jokes** and **lists** become Markdown files
you can read and edit in Obsidian; edits flow back to JokeBakery on the next
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
  jokes (attach/detach in JokeBakery).

A joke's `## Lists` section is now a **read-only** list of the labels attached to
that joke — open the matching note in `Lists/` to edit a list's contents.
`## Alternative punchlines` and `## Setup versions` are likewise read-only —
manage those in JokeBakery.

## Setup

1. In JokeBakery, go to **Settings → Obsidian sync** and **create an access
   token**. Copy it (you only see it once).
2. Install this plugin (see below), enable it, open its settings, and fill in:
   - **Server URL** — your JokeBakery address, e.g. `https://jokebakery.com`
   - **Access token** — the token you just created
   - **Vault folder** — defaults to `JokeBakery`
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

On the next sync these are created in JokeBakery and get their `bw-id` written
back into the file.

## Conflicts

Sync is last-writer-wins by modified time. If the same item changed on *both*
sides between syncs, nothing is lost: the losing version is written to
`<folder>/Conflicts/…` for you to merge by hand.

## Deletions

Deletions sync **both ways**:

- Delete a joke, sprint, or list in **JokeBakery** → its file is removed from
  the vault on the next pull (it goes to your trash, following Obsidian's
  "Deleted files" setting, so it's recoverable).
- Delete a synced **file in Obsidian** → the item is removed in JokeBakery on
  the next push. (JokeBakery keeps it as a soft-deleted tombstone, so it's
  recoverable in the database if needed.)

As a safety net, if 20 or more deletions are queued at once (e.g. the sync
folder itself was deleted), they are held back: auto-syncs skip them and a
manual **Sync now** asks for confirmation before deleting anything server-side.

Caveat: Obsidian-side deletions are detected while the plugin is running. Delete
items as **individual files** — deleting a synced file you no longer want is the
reliable signal. If a synced file goes missing without a delete event (e.g. it
was removed outside Obsidian), the next pull treats the server as authoritative
and restores it.

## Limitations (v1)

- Rhythm/IEN word-index markup and alternative punchlines are **pull-only** —
  edit them in JokeBakery, not Obsidian. If you delete lines from a slot in
  Obsidian, stale IEN voice tags past the new line count are dropped on push;
  reordering lines can still leave tags on the wrong line (fix in JokeBakery).

## Installing

### With BRAT (recommended)

The easiest way to add this to Obsidian today:

1. Install the **BRAT** community plugin (Beta Reviewer's Auto-update Tool) and
   enable it.
2. BRAT → **Add Beta plugin** → paste this repo:
   `https://github.com/jimhooker/jokebakery-obsidian`
3. BRAT installs the latest release. In Obsidian go to **Settings → Community
   plugins** and enable **JokeBakery Sync**, then configure it (see *Setup*).

BRAT keeps the plugin updated as new releases are published here.

### Manual

1. Download `main.js`, `manifest.json`, `styles.css` and `versions.json` from
   the [latest release](https://github.com/jimhooker/jokebakery-obsidian/releases),
   or build them yourself with `npm install && npm run build`.
2. Copy them into `<your-vault>/.obsidian/plugins/jokebakery-sync/`.
3. In Obsidian: **Settings → Community plugins**, enable **JokeBakery Sync**.

### Migrating from a pre-0.4.0 (BakerWriter-era) install

0.4.0 changed the plugin id from `bakerwriter-sync` to `jokebakery-sync`, so
Obsidian treats it as a new plugin. To keep your settings and sync state:

1. Install 0.4.0 (BRAT or manual) but don't enable it yet.
2. Copy `<vault>/.obsidian/plugins/bakerwriter-sync/data.json` into
   `<vault>/.obsidian/plugins/jokebakery-sync/`.
3. Enable **JokeBakery Sync**, then uninstall the old **BakerWriter Sync**.

Skipping step 2 also works — re-enter your token and folder and run a sync;
files are matched by their `bw-id`, so nothing duplicates.

### Develop

`npm run dev` runs esbuild in watch mode. Symlink this folder into your vault's
`.obsidian/plugins/` to iterate live. `npm test` runs the serialization
round-trip suite (vitest) — run it after touching `src/serialize.ts`.

## Privacy and network use

This plugin is a companion to the hosted [JokeBakery](https://jokebakery.com)
service and talks **only** to `https://jokebakery.com` (the Server URL setting
exists for development builds). On each sync it sends the contents of notes
inside the configured sync folder (your jokes, sprints, lists and crashes)
together with your access token, and pulls your items back. **No other part of
your vault is read or transmitted**, and there are no analytics or third-party
services. Your access token is stored in the plugin's `data.json` inside your
vault — treat it as a secret; you can revoke it any time in JokeBakery under
**Settings → Obsidian sync**.

Using the plugin requires a JokeBakery account (currently invite-only).

## How it works

The plugin talks to JokeBakery's `/api/sync` REST API with a Bearer token.
Each sync runs **push** (send new/edited vault files) then **pull** (write
changed server items into the vault). All Markdown ⇄ JSON translation happens
here in the plugin; the server only ever speaks JSON. See `src/serialize.ts`
for the file format and `src/sync.ts` for the sync algorithm.
