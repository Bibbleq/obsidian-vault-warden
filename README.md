# Vault Warden

Vault Warden is an Obsidian plugin for schema-driven, write-time vault hygiene.
It validates the frontmatter of the note you are editing against YAML rule
manifests that live in your own vault, not in the plugin.

The plugin ships no assumptions about your classes, folders, tags, or fields.
All of that is data, stored as YAML in a schemas folder you point the plugin
at. Point the same plugin at a different vault with different manifests and
it enforces different rules, with no code changes.

## Features (v0.2)

- Frontmatter rule validation with stable, machine-checkable rule IDs, shared
  with external batch validators so one manifest set drives every enforcement
  point:
  - Base fields — `FM-AREA-MISSING` / `FM-AREA-INVALID`,
    `FM-NOTETYPE-MISSING` / `FM-NOTETYPE-INVALID`,
    `FM-ORIGIN-MISSING` / `FM-ORIGIN-INVALID`
  - Tags — `TAG-FORMAT`, `TAG-CASE`, `TAG-DEPTH`, `TAG-RETIRED`, `TAG-DUPLICATE`
  - Dates — `DATE-FORMAT` (ISO, incl. suffix-named fields on classless notes),
    `CREATED-MISSING`
  - Classes — `CLASS-UNKNOWN`, `CLASS-FIELD-MISSING` (incl. conditional
    `required_when`), `CLASS-FIELD-TYPE`, `CLASS-FIELD-VALUE`,
    `CLASS-EXPECTED`, `CLASS-MISFILED`
- A right-sidebar violations pane (status-bar badge and ribbon icon open it;
  a command opens it on mobile, where there is no status bar).
- Violations carry a `mechanical` flag plus a concrete `suggested_fix`
  operation, the groundwork for the upcoming fix layer.
- Per-note `validator_ignore` frontmatter and a vault-wide `exceptions` file
  mark violations suppressed-but-reported (or skip a note entirely).
- A creation hook stamps `class:` (plus configured extras such as
  `origin: manual`) on notes created inside folders mapped in
  `class_locations`.
- Hot-reload: edit any schema file in the vault and validation picks it up
  immediately. Schema files may be `.yaml` or `.md` (YAML content) — useful
  when Obsidian Sync isn't configured to carry non-native file types.

## Installing via BRAT

Vault Warden is not (yet) in the community plugin directory. Install it
through [BRAT](https://github.com/TfTHacker/obsidian42-brat) instead:

1. Install and enable the BRAT plugin from Obsidian's Community Plugins browser.
2. Open BRAT's settings and choose "Add Beta Plugin".
3. Enter this repository's URL.
4. Enable Vault Warden in Community Plugins once BRAT has added it.

BRAT will track new releases published to this repository and offer updates
as they land.

## Schema format

See [`docs/SCHEMA.md`](docs/SCHEMA.md) for the full manifest format: the
`base.yaml` structure and how class manifests declare their fields.

## Conformance fixtures

See [`docs/FIXTURES.md`](docs/FIXTURES.md) for the conformance fixture
contract. The fixture suite under `test/fixtures/` is engine-agnostic plain
JSON, deliberately free of YAML or Obsidian types, so it can be consumed by
external validators (for example a Python re-implementation) that need to
match this plugin's rule semantics exactly.

## Roadmap

- One-click (and silent, for content-preserving cases) application of
  `suggested_fix` operations from the violations pane.
- Filename-to-H1 sync as a third leg alongside frontmatter and class validation.
- A class-aware field editor pane for editing frontmatter without hand-writing YAML.

## Licence

MIT. See [`LICENSE`](LICENSE).
