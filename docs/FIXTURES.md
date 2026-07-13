# Conformance fixture contract

The files under `test/fixtures/` are the shared conformance suite for every engine that
implements Vault Warden's rule semantics — this plugin's TypeScript engine and any
external batch validator. They are plain JSON and engine-agnostic: no YAML, no
Obsidian types, no implementation details.

Fixtures model the **post-load** data (the equivalent of the loaded schema set), so
engines don't read files: `select:<Source>` types appear already resolved into
`values`, and the input mirrors `ValidationInput` in `src/engine/types.ts`.

## File format

Each `*.json` file holds an array of cases:

```json
[
  {
    "name": "required class field absent",
    "base": {
      "version": 2,
      "fields": {},
      "tags": { "max_depth": 2, "retired": [] },
      "date_name_suffixes": ["_date"],
      "presence_only": ["created"]
    },
    "manifests": {
      "Recipe": {
        "name": "Recipe",
        "version": 1,
        "fields": {
          "status": { "name": "status", "type": "select", "required": true,
                       "values": ["Draft", "Published"] }
        }
      }
    },
    "class_locations": [],
    "exceptions": [],
    "file": { "path": "Recipes/Flapjack.md", "frontmatter": { "class": "Recipe" } },
    "expect": [
      { "rule": "CLASS-FIELD-MISSING", "field": "status" }
    ]
  }
]
```

Defaults when a key is omitted: `manifests` `{}`, `class_locations` `[]`,
`exceptions` `[]`; `base` is always required (use minimal empty blocks as above).
`file.frontmatter` may be `null`.

## Comparison semantics

- **Order-insensitive**: `expect` and the engine's output are compared as multisets.
- **Subset match per violation**: each expected violation lists only the keys it
  asserts (`rule` always; usually `field`; `found` / `expected` / `mechanical` /
  `suppressed` / `suggested_fix` only where the case is specifically about them).
  An actual violation matches when every asserted key is deeply equal.
- **Exact count**: every expected violation must match a distinct actual violation
  and no unmatched actual violations may remain. `"expect": []` asserts a clean note
  (including notes fully skipped by exceptions).
- Suppressed violations are still reported (with `"suppressed": true`), so a case
  exercising suppression must expect them.

## Rules for fixture authors

- Keep every case minimal: only the blocks the case needs.
- One behaviour per case; encode the behaviour in `name`.
- Frontmatter values must be JSON-representable (dates are strings).
- Don't assert `found` for non-string offending values (engines may stringify
  differently), and don't assert casing-suggestion strings beyond the documented
  Pascal fallback.
- Never reference real vault content — invent neutral class/field names.
