# Vault Warden

Vault Warden is an Obsidian plugin for schema-driven, write-time vault hygiene.
As you edit a note, it validates that note's frontmatter — and its filename,
heading, and body — against YAML rule manifests that live in your own vault,
not in the plugin.

The plugin ships no assumptions about your classes, folders, tags, or fields.
All of that is data, stored as YAML in a schemas folder you point the plugin
at. Point the same plugin at a different vault with different manifests and it
enforces different rules, with no code changes.

## Why the schema lives in the vault

The manifests are plain YAML files in your vault. That means one set of rules
can drive two enforcement points with zero drift: this plugin catches issues in
the note you are editing, and an external batch validator (a CI job, a
server-side sweep) can read the exact same files to check the whole vault. Both
sides run the same conformance suite (see [Conformance](#conformance)), so they
agree by construction. Distribution is whatever already syncs your vault
(Obsidian Sync, a git mirror), and a config wipe becomes a visible diff rather
than a silent behaviour change.

## Features

- **Frontmatter validation** with stable, machine-checkable rule IDs:
  - Base fields — `FM-AREA-*`, `FM-NOTETYPE-*`, `FM-ORIGIN-*`
    (missing / invalid, with `required_unless` waivers)
  - Tags — `TAG-FORMAT`, `TAG-CASE`, `TAG-DEPTH`, `TAG-RETIRED`,
    `TAG-DUPLICATE`
  - Dates — `DATE-FORMAT` (ISO, including suffix-named fields on classless
    notes), `CREATED-MISSING`
  - Classes — `CLASS-UNKNOWN`, `CLASS-FIELD-MISSING` (including conditional
    `required_when`), `CLASS-FIELD-TYPE`, `CLASS-FIELD-VALUE`,
    `CLASS-EXPECTED`, `CLASS-MISFILED`, `STATUS-STALE`
  - Detected by the plugin from the note and the metadata cache: `FM-PARSE`
    (unparseable frontmatter), `LINK-BROKEN` (unresolved wikilinks)
- **Violations pane** — a right-sidebar view for the active note (status-bar
  badge and ribbon icon open it; a command opens it on mobile). Suppressed
  violations show separately; schema-load problems surface here too.
- **Two-tier fixes** — every mechanical violation carries a concrete fix. Each
  rule is **Manual** (a button in the pane) or **Automatic** (applied silently
  on detection), set per rule in settings. Fixes include tag re-casing (adopting
  your vault's established casing), de-duplication, date normalisation, class
  stamping, and `created` backfilled from the filesystem timestamp.
- **Filename ↔ H1 sync** — the filename is the lossy projection of the H1
  (`sanitise(H1) == filename`). Substantive drift renames the file to follow the
  H1 (backlinks update, old name optionally kept as an alias); cosmetic or
  degenerate H1 defects repair the H1 instead. All configurable, all guarded
  against destructive renames.
- **Class-aware properties editor** — the pane doubles as a Metadata Menu
  replacement: the note's class, its fields with current values, required-and-
  missing flagged, edited in place with type-appropriate widgets (value pickers
  fed from your sources, date pickers, note-link search, list chips). An
  optional per-class `display:` block gives friendly labels, icons, sections,
  and clickable link values.
- **New-note setup** — a creation hook stamps `class`, configured extras
  (e.g. `origin: manual`), and field defaults on notes born in mapped folders,
  and lays down a body scaffold from an optional per-class template.
- **Schema editor GUI** — every part of the schema (tags, dates, base fields,
  classes and their fields, folder map, exceptions, title sync, creation stamp)
  is editable from the tabbed settings screen. Edits are surgical,
  comment-preserving writes to the YAML files, which stay hand-editable.
- **Hot reload** — edit any schema file and validation picks it up immediately.
  Schema files may be `.yaml` or `.md` (YAML content), useful when Obsidian Sync
  isn't carrying non-native file types.

## Installing via BRAT

Vault Warden is not (yet) in the community plugin directory. Install it through
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable BRAT from Obsidian's Community Plugins browser.
2. In BRAT's settings, choose "Add beta plugin".
3. Enter `Bibbleq/obsidian-vault-warden`.
4. Enable Vault Warden in Community Plugins once BRAT has added it.

BRAT tracks new releases and offers updates as they land.

## Getting started

Open the plugin settings. If no schema exists at the configured path (default
`_vault/Metadata Sources/Schemas/Vault.yaml`), a **Create starter schema**
button scaffolds a commented vault schema, an example class manifest, and an
empty folder map to edit from there. Otherwise the header shows what loaded
(class, folder, and exception counts), and the tabs let you build up your rules.

## Schema format

See [`docs/SCHEMA.md`](docs/SCHEMA.md) for the full manifest format: the vault
schema (`Vault.yaml`), class manifests, field types, every rule, and the
`display:`, `body_template:`, and `title_sync:` blocks.

## Conformance

The rule semantics are pinned by an engine-agnostic JSON fixture suite in
[`test/fixtures/`](test/fixtures), documented in
[`docs/FIXTURES.md`](docs/FIXTURES.md). The suite is plain JSON — no YAML, no
Obsidian types — so an external validator (for example a Python
re-implementation) can run the exact same cases and match this plugin's engine
exactly.

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md) for the version history.

## Licence

MIT. See [`LICENSE`](LICENSE).
