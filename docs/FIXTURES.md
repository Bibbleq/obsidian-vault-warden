# Conformance fixture contract

The files under `test/fixtures/` are the shared conformance suite for every engine that
implements Vault Warden's rule semantics (this plugin's TypeScript engine, external
Python validators, anything else). They are plain JSON and deliberately engine-agnostic:
no YAML, no Obsidian types, no implementation details.

## File format

Each `*.json` file holds an array of cases so related cases can share a file:

```json
[
  {
    "name": "required field absent",
    "config": {
      "class_key": "class",
      "ignore_key": "validator_ignore",
      "rules": { "CLASS-FIELD-MISSING": { "fix": "confirm" } }
    },
    "classes": {
      "Recipe": {
        "class": "Recipe",
        "fields": { "created": { "type": "date", "required": true } }
      }
    },
    "sources": {},
    "file": {
      "path": "Recipes/Flapjack.md",
      "frontmatter": { "class": "Recipe" }
    },
    "expect": [
      { "rule": "CLASS-FIELD-MISSING", "field": "created" }
    ]
  }
]
```

Field meanings match `src/engine/types.ts` (`ValidationInput`):

- `config` — the parsed base schema (already-parsed data, not YAML text).
- `classes` — class name → manifest.
- `sources` — source list name → allowed values. Fixtures inline these; engines must
  not read files.
- `file.path` — vault-relative path (forward slashes).
- `file.frontmatter` — parsed frontmatter as JSON, or `null` for no frontmatter.
- `expect` — the violations the engine must produce.

## Comparison semantics

- **Order-insensitive**: `expect` and the engine's output are compared as multisets.
- **Subset match per violation**: each expected violation lists only the keys it
  asserts (`rule` always; usually `field`; optionally `found` / `expected`). An actual
  violation matches if every asserted key is strictly equal. Extra keys on the actual
  violation (`message`, `fix`, ...) are never compared.
- **Exact count**: every expected violation must match a distinct actual violation and
  no unmatched actual violations may remain. `"expect": []` asserts a clean note.

## Rules for fixture authors

- Keep every case minimal: only the config keys, classes, and sources the case needs.
- One behaviour per case; encode the behaviour in `name`.
- Frontmatter values must be JSON-representable (dates are strings).
- Never reference real vault content — invent neutral class/field names.
