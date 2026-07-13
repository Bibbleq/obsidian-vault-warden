# Vault Warden schema reference

Vault Warden is driven entirely by YAML manifests stored **in your vault**. Nothing about
your vault's classes, folders, tags, or fields is hardcoded in the plugin.

This format is shared with external batch validators (the same files can drive a
CI/server-side validator); the conformance fixtures in `test/fixtures/` pin the
semantics both sides must implement.

## Files

All schema files live in one folder (default `_vault/Metadata Sources/Schemas/`; the
plugin setting points at the base file inside it). Every file may have either a
`.yaml` or `.md` extension — Obsidian Sync only carries non-native file types when
"sync all other types" is enabled, so `.md` files whose entire content is YAML are
accepted as equivalent transport. `.yaml` wins when both exist.

| stem | purpose |
|---|---|
| `Vault` / `vault` (legacy: `base`) | vault-wide schema: base fields, tag rules, date rules |
| `class_locations` | folder-prefix → class map (optional) |
| `exceptions` | notes deliberately outside the rules (optional) |
| anything else | one class manifest per file |

## Vault.yaml

```yaml
base_schema_version: 2

fields:            # checked on EVERY note
  area:
    type: select:Areas        # values from <Metadata Sources>/Areas.md
    required: true
  notetype:
    type: multi:Note Types
    required: true
    required_unless: class     # optional once class types the note
  origin:
    type: select:Origin
    required: true

tags:
  max_depth: 2                 # TAG-DEPTH: max '/'-separated levels
  retired:                     # TAG-RETIRED: remove on sight (case-insensitive)
    - OldTag

dates:
  name_suffixes: [_date, _deadline]   # DATE-FORMAT applies to any field with
                                      # these suffixes, classed or not
  presence_only: [created]            # never format-checked ('linter_managed'
                                      # accepted as a legacy key name)

# Plugin-only key (batch validators ignore unknown keys): extra frontmatter
# stamped alongside class: by the creation hook.
creation_stamp:
  origin: manual
```

Only `area`, `notetype`, and `origin` have base-field rules (`FM-AREA-*`,
`FM-NOTETYPE-*`, `FM-ORIGIN-*`); other names under `fields:` are ignored.

## Class manifests

```yaml
manifest_version: 2
class: Recipe                  # authoritative; filename is convention
fields:
  created: {type: date, required: true}
  status:
    type: select               # inline closed list
    required: true
    values: [Draft, Published]
  source: {type: wikilink}
  servings: {type: number}
  link: {type: url}
  steps: {type: list}
  superseded_by:
    type: wikilink
    required_when: {field: status, equals: Superseded}
  origin:
    type: text
    default: manual            # used by "apply class defaults" / field editor
  created:
    type: datetime
    default: "{{now}}"         # tokens: {{today}} -> YYYY-MM-DD, {{now}} -> ISO datetime
lifecycle:                     # drives STATUS-STALE
  - date_field: publish_date
    when_status: [Draft]
    suggest: Published
    # age_days: 90             # optional: stale only when MORE than N days past
```

`default:` is plugin-side (batch validators ignore it): the field editor's
"apply class defaults" inserts defaults for missing fields. The same
`{{today}}`/`{{now}}` tokens work in the base schema's `creation_stamp` values.

### Field type grammar

`date`, `datetime`, `list`, `wikilink`, `text`, `number`, `url`,
`select` / `multi` (inline `values:`), `select:<Source>` / `multi:<Source>`
(values from the line-list note `<Metadata Sources>/<Source>.md` — one value per
line, blank lines skipped). A missing source note resolves to an **empty** value
set, which disables membership checking (fail open).

## class_locations.yaml

```yaml
locations:
  - prefix: "Projects/Recipes/"    # plain string prefix, longest match wins
    class: Recipe
```

## exceptions.yaml

```yaml
exceptions:
  - path: Agents.md                 # exact path — or pattern: "*.excalidraw.md"
    reason: pointer file, no frontmatter by design
  - path: Projects/Recipes/Hub.md
    rules: [CLASS-EXPECTED]         # omit rules = FULL skip (no violations at all)
    reason: hub note inside a mapped folder
```

Exactly one of `path` / `pattern` per entry. With `rules:`, matching notes get those
violations **suppressed-but-reported**; without it the note is fully skipped.

## Rules (write-time subset)

| ID | Fires when |
|---|---|
| `FM-AREA-MISSING` † | base field `area` empty (mechanical when the folder path derives a valid area — longest segment-prefix match) |
| `FM-AREA-INVALID` | `area` present but not in its value set |
| `FM-NOTETYPE-MISSING` | `notetype` empty and `required_unless` field also empty |
| `FM-NOTETYPE-INVALID` | any `notetype` entry not in its value set |
| `FM-ORIGIN-MISSING` / `-INVALID` | same pattern for `origin` |
| `TAG-FORMAT` † | tag fails `^[A-Za-z0-9]+(/[A-Za-z0-9]+)*$` (or a non-string tag entry) |
| `TAG-CASE` † | tag is well-formed but a segment starts lowercase |
| `TAG-DEPTH` | tag deeper than `max_depth` levels |
| `TAG-RETIRED` † | tag in the retired list (case-insensitive, `#` stripped) |
| `TAG-DUPLICATE` † | exact duplicate entries in the tags list (one violation per note) |
| `DATE-FORMAT` † | a date-typed manifest field or `name_suffixes` field isn't ISO (`YYYY-MM-DD` optionally `T HH:mm[:ss[.f]][Z|±hh:mm]`); mechanical for the space-instead-of-T shape |
| `CREATED-MISSING` | `created` is empty |
| `CLASS-UNKNOWN` | declared class has no manifest |
| `CLASS-FIELD-MISSING` | required (or `required_when`-triggered) class field is empty |
| `CLASS-FIELD-TYPE` | value has the wrong shape for its declared type |
| `CLASS-FIELD-VALUE` | select/multi value not in the closed value set |
| `CLASS-EXPECTED` † | no class, under a mapped prefix (mechanical: set the mapped class) |
| `CLASS-MISFILED` | classed note living outside every prefix mapped to its class |
| `STATUS-STALE` † | a `lifecycle` entry's date has passed (or is older than `age_days`) while `status` is still in `when_status` — suggests the next status. Engines only run it when the caller injects today's date (`today`, YYYY-MM-DD), keeping validation deterministic |

† = can be mechanical (violation carries a concrete `suggested_fix`).

Batch-only rules (`FILENAME-COLLISION`, `LINK-BROKEN`, `INBOX-STALE`,
`AREA-FOLDER-MISMATCH`, `BODY-TAG`, `TAG-SPARSE`, `TAG-TWIN`, `FM-PARSE`, …) are
deliberately not implemented in the plugin — they need whole-vault context or human
judgement.

### Semantics shared by all rules

- **Emptiness**: absent, `null`, empty/whitespace string, empty list, empty mapping.
- **Class resolution**: `class` may be a list; the first entry (stringified) names the
  class. An empty class = unclassed.
- **Tags**: a bare string tags value counts as a one-entry list; a single leading `#`
  is stripped before checking. Comma-joined string entries (`"A,B"`) are normalized
  into separate tags before any tag rule runs — matching how Obsidian's own tag index
  reads them — and additionally raise one mechanical `TAG-FORMAT` violation whose fix
  rewrites the tags as a proper list. `TAG-DUPLICATE` judges the normalized entries.
- **Suppression**: rule IDs listed in the note's `validator_ignore` frontmatter
  (string or list, matched case-insensitively) or in a matching rule-scoped
  exception mark those violations `suppressed: true` — reported, not dropped.
- Suggested tag-casing fixes Pascal-case each segment (splitting on `-`/`_`/space);
  an engine with vault-wide casing knowledge may substitute established casings
  (e.g. `LLM` over `Llm`), so fixtures don't assert casing suggestions beyond the
  Pascal fallback.
