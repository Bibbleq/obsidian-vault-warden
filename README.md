# Vault Warden

Vault Warden is an Obsidian plugin for schema-driven, write-time vault hygiene.
It validates the frontmatter of the note you are editing against YAML rule
manifests that live in your own vault, not in the plugin.

The plugin ships no assumptions about your classes, folders, tags, or fields.
All of that is data, stored as YAML in a schemas folder you point the plugin
at. Point the same plugin at a different vault with different manifests and
it enforces different rules, with no code changes.

## Features (v0.1)

- Frontmatter rule validation with stable, machine-checkable rule IDs:
  - `CLASS-FIELD-MISSING` — a required field for the note's class is absent.
  - `CLASS-FIELD-TYPE` — a field's value doesn't match its declared type.
  - `DATE-FORMAT` — a date-like field doesn't match one of the accepted formats.
  - `TAG-CASE` — a tag doesn't match the configured case style.
  - `TAG-RETIRED` — a tag has been retired in favour of a replacement (or removal).
  - `FM-AREA-INVALID` — a frontmatter value isn't present in its backing source list.
  - `CLASS-UNDECLARED` — a note's folder implies a class it doesn't declare.
- Two-tier fix classification (`auto` / `confirm` / `none`) declared per rule
  in the manifest, so the plugin knows which fixes it may apply silently and
  which need confirmation.
- `validator_ignore` frontmatter opt-out, so individual notes can suppress
  specific rule IDs without disabling the rule vault-wide.
- Hot-reload of manifests: edit a schema file in the vault and validation
  picks it up immediately, no reload required.

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

- One-click fixes for `auto`-tier rules directly from the validation surface.
- Filename-to-H1 sync as a third leg alongside frontmatter and class validation.
- A class-aware field editor pane for editing frontmatter without hand-writing YAML.

## Licence

MIT. See [`LICENSE`](LICENSE).
