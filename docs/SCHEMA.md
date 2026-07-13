# Vault Warden schema reference

Vault Warden is driven entirely by YAML manifests stored **in your vault**. Nothing about
your vault's classes, folders, tags, or fields is hardcoded in the plugin.

Two kinds of file live in the schemas folder (the folder containing your configured base
schema file, default `_vault/Metadata Sources/Schemas/`):

- **`base.yaml`** — vault-wide configuration: rule settings, folder→class map, title-sync
  behaviour. Exactly one; its path is a plugin setting.
- **Class manifests** — one YAML file per note class (e.g. `Recipe.yaml`), declaring that
  class's frontmatter fields. Every `.yaml`/`.yml` file in the schemas folder other than
  the base file is treated as a class manifest.

All files are parsed with Obsidian's built-in YAML parser and hot-reloaded when anything
in the schemas folder changes.

## base.yaml

```yaml
version: 1

# Folder of "line-list" notes used by select: field types and source-backed rules.
# A line-list note is a plain .md file with one valid value per line
# (empty lines and lines starting with '#' are ignored).
metadata_sources: "_vault/Metadata Sources"

# Frontmatter key that names a note's class.
class_key: class

# Frontmatter key holding a list of rule IDs to skip for that note.
ignore_key: validator_ignore

# Optional frontmatter property kept in sync with the H1/filename (third sync leg).
# Empty string = disabled. (Sync engine ships in a later phase; the key is reserved.)
frontmatter_title: ""

# Folder path -> class name. Used by CLASS-UNDECLARED and by the creation hook.
# Paths are vault-relative folder paths without trailing slash; a note matches if it
# is inside the folder or any subfolder. The deepest (longest) match wins.
class_locations:
  "Projects/Recipes": Recipe

# Extra frontmatter keys stamped (alongside class_key) when the creation hook fires.
creation_stamp:
  origin: manual

# Rule configuration. A rule runs only if its ID appears here.
# Every rule takes `fix: auto | confirm | none` — the fix tier
# (auto = content-preserving, applied silently; confirm = one-click from the pane;
# none = report only). The tier is carried on each violation; the fix layer itself
# ships in a later phase.
rules:
  CLASS-FIELD-MISSING: { fix: confirm }
  CLASS-FIELD-TYPE: { fix: none }
  DATE-FORMAT:
    fix: auto
    # Accepted formats for date-typed fields. Tokens: YYYY MM DD HH mm ss.
    # Everything else in a pattern is a literal character.
    formats:
      - "YYYY-MM-DD"
      - "YYYY-MM-DDTHH:mm"
      - "YYYY-MM-DDTHH:mm:ss"
  TAG-CASE:
    fix: auto
    # Currently only "pascal": every '/'-separated segment of every tag must be
    # PascalCase (optional leading digits, then an uppercase letter, then
    # letters/digits — e.g. Microsoft/Copilot, 3DPrinting/Klipper).
    style: pascal
  TAG-RETIRED:
    fix: confirm
    # Exact full-tag match -> replacement. Empty/null replacement = remove.
    map:
      OldTag: NewTag
      DeadTag: ""
  FM-AREA-INVALID:
    fix: confirm
    # Vault-wide select check on one base field, independent of class.
    field: area
    source: Areas          # -> <metadata_sources>/Areas.md
  CLASS-UNDECLARED: { fix: auto }

# Filename <-> H1 sync configuration (sync engine ships in a later phase; the block
# is defined now so manifests are forward-compatible).
title_sync:
  strip: ":|#^[]\\/?"      # characters removed when projecting H1 -> filename
  replacement: ""           # what each stripped char becomes ("" = removed)
  ignore:                    # path prefixes exempt from sync
    - "_vault/Templates/"
```

## Class manifests

One file per class. The file must contain a top-level `class:` key; the filename is
conventionally `<ClassName>.yaml` but the `class:` key is authoritative.

```yaml
class: Recipe
fields:
  created:
    type: date
    required: true
  area:
    type: select:Areas     # value must appear in <metadata_sources>/Areas.md
    required: true
  tags:
    type: list
  source:
    type: wikilink          # "[[Note]]" / "[[Note|alias]]" / "[[Note#heading]]"
  servings:
    type: text              # any scalar string
    required: false          # default
```

### Field types

| type | valid value |
|---|---|
| `date` | string matching one of the `DATE-FORMAT` patterns |
| `select:<Source>` | string appearing in the line-list note `<metadata_sources>/<Source>.md` — if the source list cannot be resolved, the membership check is skipped (fail open) |
| `list` | YAML sequence (array) |
| `wikilink` | string of the form `[[...]]` (alias/heading/block suffixes allowed) |
| `text` | scalar string |

### Emptiness

A field counts as **missing** when the key is absent, or its value is `null`, an empty
string, a whitespace-only string, or an empty list. Type checks only run on non-missing
values.

## Rules

| ID | Scope | Fires when |
|---|---|---|
| `CLASS-FIELD-MISSING` | classed notes | a `required: true` field of the note's class is missing |
| `CLASS-FIELD-TYPE` | classed notes | a present field's value doesn't satisfy its declared type |
| `DATE-FORMAT` | classed notes | a `date`-typed field holds a string that matches no configured format |
| `TAG-CASE` | all notes | any frontmatter tag has a segment that fails the configured case style |
| `TAG-RETIRED` | all notes | any frontmatter tag exactly matches a key in the retired map |
| `FM-AREA-INVALID` | all notes | the configured field is present but its value is not in the configured source list |
| `CLASS-UNDECLARED` | all notes | the note lives under a `class_locations` folder but has no class declared |

Precedence notes:

- For a `date`-typed field: a non-string value → `CLASS-FIELD-TYPE`; a string in the
  wrong format → `DATE-FORMAT`. Never both.
- If a class field is `select:`-typed **and** is the same field named by
  `FM-AREA-INVALID`, only `FM-AREA-INVALID` fires for an invalid value (stable-ID
  contract with external validators). `CLASS-FIELD-TYPE` still fires if the value is
  not a string at all.
- A note whose declared class has no manifest produces no class-scoped violations.
- A `select:` value not in its source list is a `CLASS-FIELD-TYPE` violation (there is
  no dedicated select rule ID).
- `CLASS-UNDECLARED` violations report `field` = the configured `class_key` and
  `expected` = the class mapped for the deepest matching folder.
- In the `TAG-RETIRED` map, a `null` replacement is equivalent to `""` (remove the
  tag); violations report `expected: ""` in both cases.

## validator_ignore

A note can opt out of specific rules:

```yaml
---
class: Recipe
validator_ignore:
  - DATE-FORMAT
---
```

The key name is the base schema's `ignore_key`. A bare string is accepted as a
single-entry list.
