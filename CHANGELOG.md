# Changelog

All notable changes to Vault Warden. Format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions are the plugin's
release tags (bare, no `v` prefix, per Obsidian convention).

## 0.10.0

- TAG-CASE / TAG-FORMAT fixes adopt the vault's established segment casing
  (e.g. `LLM` over `Llm`), built from the tag index. Absent in fixtures, so
  the PascalCase fallback keeps engine parity.
- `FM-PARSE`: a note whose frontmatter block fails to parse is now surfaced
  (previously indistinguishable from a note with no frontmatter) and
  short-circuits other rules.
- `LINK-BROKEN`: the active note's unresolved wikilink targets, from the
  metadata cache (report-only). Both new rules honour `validator_ignore` and
  exceptions.

## 0.9.x — properties pane polish

- **0.9.5** — Editing a field prefills the current value; new notes stamp
  `created` from the filesystem timestamp; `CREATED-MISSING` gains a mechanical
  fix using that timestamp.
- **0.9.4** — A pencil edit button on every non-list row (link-valued rows
  navigate on click, so the pencil is the guaranteed edit path).
- **0.9.3** — URL values render as clickable external links; list fields
  without a manifest spec append rather than clobber.
- **0.9.2** — Display sections and the base-field group are collapsible with
  persisted state; value pickers gain an "Add option" entry that persists the
  new option to its source list or manifest and applies it.
- **0.9.1** — Larger property rows, section headings, and icons.
- **0.9.0** — Per-class `display:` templates: sections with icons, colours,
  friendly labels, and clickable link values; unlisted fields collapse into
  "More fields".

## 0.8.x — tabbed settings

- **0.8.2** — `required_when` editable as a `field=value` input in the class
  editor.
- **0.8.1** — The properties panel's required-and-missing highlight honours
  `required_unless` / `required_when`.
- **0.8.0** — Settings reorganised: a header card (version, schema path, status
  chips) and five tabs (Overview, Rules, Classes, Title sync, Exceptions), with
  each rule's fix-mode dropdown co-located with its config and an
  automatic-fixes audit row on Overview.

## 0.7.0 — schema editor GUI

- Every schema component is editable from settings via a comment-preserving YAML
  write layer (add/edit/remove tags, dates, base fields, classes and their
  fields, folder map, exceptions, title sync). The YAML files stay
  hand-editable; comments and key order survive edits.

## 0.6.0 — body scaffolds

- Class manifests gain `body_template:`, pointing at a markdown file whose body
  (frontmatter discarded, `{{title}}` / `{{date}}` substituted) scaffolds new
  notes. New-note setup — class, creation stamp, field defaults, body scaffold —
  now happens in one hook, and only ever writes into an empty body.

## 0.5.0 — class-aware properties editor

- The pane grows a properties section: detected class, base plus manifest
  fields with current values, required-missing flagged, edited in place with
  type-appropriate widgets. Manifest fields gain optional `default:` values and
  an "apply class defaults" action.
- `STATUS-STALE` joins the shared engine contract, with today's date injected by
  the adapter and verified at parity.

## 0.4.x — filename ↔ H1 sync

- **0.4.2** — Automatic fixes also run for a note edited then left before its
  save landed (Obsidian saves after focus leaves).
- **0.4.1** — Date picker for manual date fixes.
- **0.4.0** — Filename ↔ H1 sync: `H1-MISSING` / `H1-WHITESPACE` /
  `H1-DEGENERATE` repair the H1, `FILENAME-SYNC` renames the file to follow it,
  with hard guards. Each fix-capable rule gains a Manual / Automatic setting.

## 0.3.x — fix layer

- **0.3.1** — Comma-joined tag strings are normalised before tag rules run,
  matching how Obsidian's tag index reads them.
- **0.3.0** — The pane applies fixes: per-violation Fix (mechanical) and Set…
  (manual override with schema-fed pickers), plus Fix all. Settings gain a
  rules-by-category overview.

## 0.2.x — Keep validator contract

- **0.2.1** — The vault-wide schema file is `Vault.yaml` (legacy `base.yaml`
  still accepted).
- **0.2.0** — Realigned to the live reference validator's contract: richer
  manifest grammar, the full write-time rule set, per-violation `mechanical` +
  `suggested_fix`, and the right-sidebar violations pane. Conformance suite
  verified at parity against the reference engine.

## 0.1.0

- Initial release: the pure rule engine, an engine-agnostic conformance fixture
  suite, the schema loader with hot reload, and the BRAT release pipeline.
