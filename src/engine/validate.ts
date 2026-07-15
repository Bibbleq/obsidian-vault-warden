/**
 * Vault Warden's pure rule engine — the write-time subset of the Bibble-style
 * Python validator (`rules.py`). `validate` is the single entry point: given a
 * base schema, class manifests, optional class-location/exception config, and
 * one note's path + frontmatter, it returns every violation. It never throws
 * and never mutates its input, so it runs identically headless (vitest
 * fixtures) and inside the Obsidian adapter.
 *
 * Deliberately NOT implemented here (need whole-vault context or a clock):
 * FM-PARSE, STATUS-STALE, FILENAME-COLLISION, LINK-BROKEN, INBOX-STALE,
 * AREA-FOLDER-MISMATCH, BODY-TAG, VOICE-MISSING, TAG-SPARSE, TAG-TWIN.
 */

import type {
  BaseSchema,
  ClassLocation,
  ExceptionRule,
  FieldSpec,
  Manifest,
  RuleId,
  SuggestedFix,
  Validate,
  ValidationInput,
  Violation,
} from "./types";
import { dateFieldsToCheck, isIsoDateValue, parseDateValueMs, suggestIsoFix } from "./dates";
import {
  asList,
  classForPath,
  deriveArea,
  exceptionMatches,
  fmGet,
  type Frontmatter,
  isDictOrList,
  isEmpty,
  prefixesForClass,
  shown,
  suggestTagCasing,
  valuesEqual,
} from "./shared";

const TAG_OK_RE = /^[A-Za-z0-9]+(\/[A-Za-z0-9]+)*$/;
const WIKILINK_RE = /^\[\[.+\]\]$/;

/** Build a Violation with the shared defaults (`mechanical`/`suppressed` false, no fix). */
function violation(partial: {
  rule: RuleId;
  field?: string | null;
  found?: string | null;
  expected?: string | null;
  mechanical?: boolean;
  suggested_fix?: SuggestedFix | null;
}): Violation {
  return {
    rule: partial.rule,
    field: partial.field ?? null,
    found: partial.found ?? null,
    expected: partial.expected ?? null,
    mechanical: partial.mechanical ?? false,
    suggested_fix: partial.suggested_fix ?? null,
    suppressed: false,
  };
}

/** name -> [missing rule, invalid rule]; only these three base fields have rule pairs. */
const BASE_FIELD_RULES: Record<string, [RuleId, RuleId]> = {
  area: ["FM-AREA-MISSING", "FM-AREA-INVALID"],
  notetype: ["FM-NOTETYPE-MISSING", "FM-NOTETYPE-INVALID"],
  origin: ["FM-ORIGIN-MISSING", "FM-ORIGIN-INVALID"],
};

/** Port of `_check_base_fields`: FM-AREA/-NOTETYPE/-ORIGIN -MISSING/-INVALID. */
function checkBaseFields(path: string, frontmatter: Frontmatter, base: BaseSchema): Violation[] {
  const violations: Violation[] = [];
  for (const name of Object.keys(BASE_FIELD_RULES)) {
    const [missingRule, invalidRule] = BASE_FIELD_RULES[name];
    const spec: FieldSpec | undefined = base.fields?.[name];
    if (!spec) continue;
    const value = fmGet(frontmatter, name);
    if (isEmpty(value)) {
      // required_unless: e.g. notetype is optional once `class` types the note.
      if (spec.required_unless && !isEmpty(fmGet(frontmatter, spec.required_unless))) {
        continue;
      }
      const derived = name === "area" ? deriveArea(path, spec.values ?? []) : null;
      const hasValues = !!spec.values && spec.values.length > 0;
      violations.push(
        violation({
          rule: missingRule,
          field: name,
          found: null,
          expected: hasValues ? `one of ${spec.source || "schema"} values` : "a value",
          mechanical: !!derived,
          suggested_fix: derived ? { op: "set_field", field: name, value: derived } : null,
        })
      );
      continue;
    }
    const allowed = spec.values ?? [];
    if (allowed.length === 0) continue;
    // A class-managed note (required_unless field present) is typed by its
    // class, so a stray base-field value is removed, not coerced.
    const classManaged =
      !!spec.required_unless && !isEmpty(fmGet(frontmatter, spec.required_unless));
    const items = spec.type === "multi" ? asList(value) : [value];
    for (const item of items) {
      if (allowed.includes(String(item))) continue;
      if (classManaged) {
        violations.push(
          violation({
            rule: invalidRule,
            field: name,
            found: shown(item),
            expected: `class-managed note: remove stray ${name}`,
            mechanical: true,
            suggested_fix: { op: "remove", field: name },
          })
        );
      } else if (name === "notetype") {
        // Governed facet: tolerate-and-flag, not a hard invalid.
        violations.push(...checkNotetypeValue(String(item), allowed, base.notetype_retired ?? []));
      } else {
        violations.push(
          violation({
            rule: invalidRule,
            field: name,
            found: shown(item),
            expected: `one of: ${allowed.join(", ")}`,
          })
        );
      }
    }
  }
  return violations;
}

/**
 * Notetype governance for a value not exactly in the canonical list (mirrors
 * `_check_notetype_value`). Order: casing fix → retired → tolerate-and-flag.
 * Only reached for non-class notes (class-managed strays are removed above).
 */
function checkNotetypeValue(value: string, allowed: string[], retired: string[]): Violation[] {
  const canon = allowed.find((a) => a.toLowerCase() === value.toLowerCase());
  if (canon !== undefined) {
    return [
      violation({
        rule: "NOTETYPE-CASE",
        field: "notetype",
        found: value,
        expected: canon,
        mechanical: true,
        suggested_fix: { op: "set_field", field: "notetype", value: canon },
      }),
    ];
  }
  if (retired.includes(value)) {
    return [
      violation({
        rule: "NOTETYPE-RETIRED",
        field: "notetype",
        found: value,
        expected: "retired notetype - migrate to a current type (see Note Types Directory)",
      }),
    ];
  }
  return [
    violation({
      rule: "NOTETYPE-UNLISTED",
      field: "notetype",
      found: value,
      expected: "not in Note Types.md - promote it or canonicalise into an existing type",
    }),
  ];
}

/**
 * Port of `_split_tag_entries`: Obsidian's tag index treats a comma-joined
 * string ("A,B") as multiple tags, so tag rules must see the same tags the
 * app does. String entries split on commas (trimmed, empties dropped);
 * non-strings pass through.
 */
function splitTagEntries(rawList: unknown[]): { entries: unknown[]; hadComma: boolean } {
  const entries: unknown[] = [];
  let hadComma = false;
  for (const entry of rawList) {
    if (typeof entry === "string" && entry.includes(",")) {
      hadComma = true;
      for (const part of entry.split(",")) {
        const trimmed = part.trim();
        if (trimmed !== "") entries.push(trimmed);
      }
    } else {
      entries.push(entry);
    }
  }
  return { entries, hadComma };
}

/** Port of `_check_tags`: TAG-FORMAT, TAG-CASE, TAG-DEPTH, TAG-RETIRED. */
function checkTags(
  frontmatter: Frontmatter,
  base: BaseSchema,
  casings?: Record<string, string> | null
): Violation[] {
  const violations: Violation[] = [];
  const rules = base.tags ?? { max_depth: 2, retired: [] };
  const retiredLower = new Set((rules.retired ?? []).map((t) => t.replace(/^#+/, "").toLowerCase()));

  const rawList = asList(fmGet(frontmatter, "tags"));
  const { entries, hadComma } = splitTagEntries(rawList);
  if (hadComma) {
    violations.push(
      violation({
        rule: "TAG-FORMAT",
        field: "tags",
        found: JSON.stringify(rawList),
        expected: "one tag per entry (split comma-separated tags)",
        mechanical: true,
        suggested_fix: { op: "set_list", field: "tags", value: entries },
      })
    );
  }

  for (const rawTag of entries) {
    if (rawTag === null || rawTag === undefined) continue;
    if (typeof rawTag !== "string") {
      violations.push(
        violation({ rule: "TAG-FORMAT", field: "tags", found: shown(rawTag), expected: "a string tag" })
      );
      continue;
    }
    const tag = rawTag.trim();
    if (!tag) continue;
    const normalized = tag.replace(/^#+/, "");

    if (!TAG_OK_RE.test(tag)) {
      const fix = suggestTagCasing(tag, casings);
      violations.push(
        violation({
          rule: "TAG-FORMAT",
          field: "tags",
          found: tag,
          expected: "PascalCase alphanumeric segments joined by /",
          mechanical: !!fix,
          suggested_fix: fix ? { op: "replace_tag", field: "tags", found: tag, value: fix } : null,
        })
      );
    } else if (tag.split("/").some((seg) => /^[a-z]/.test(seg))) {
      const fix = suggestTagCasing(tag, casings);
      violations.push(
        violation({
          rule: "TAG-CASE",
          field: "tags",
          found: tag,
          expected: `established casing: ${fix}`,
          mechanical: true,
          suggested_fix: { op: "replace_tag", field: "tags", found: tag, value: fix },
        })
      );
    }

    if (normalized.split("/").length > (rules.max_depth ?? 2)) {
      violations.push(
        violation({
          rule: "TAG-DEPTH",
          field: "tags",
          found: tag,
          expected: `at most ${rules.max_depth} levels`,
        })
      );
    }

    if (retiredLower.has(normalized.toLowerCase())) {
      violations.push(
        violation({
          rule: "TAG-RETIRED",
          field: "tags",
          found: tag,
          expected: "tag is retired; remove it (see Tag Taxonomy)",
          mechanical: true,
          suggested_fix: { op: "remove_tag", field: "tags", found: tag },
        })
      );
    }
  }
  return violations;
}

/** Port of `_check_tag_duplicates`: one TAG-DUPLICATE violation per note. */
function checkTagDuplicates(frontmatter: Frontmatter): Violation[] {
  // Duplicates are judged on the comma-normalized entries (the tags Obsidian
  // sees), so this fix composes with checkTags's comma-split fix rather than
  // undoing it.
  const { entries: tags } = splitTagEntries(asList(fmGet(frontmatter, "tags")));
  if (tags.length === 0) return [];
  const seen: unknown[] = [];
  const deduped: unknown[] = [];
  let hasDuplicate = false;
  for (const tag of tags) {
    if (seen.some((s) => valuesEqual(s, tag))) {
      hasDuplicate = true;
      continue;
    }
    seen.push(tag);
    deduped.push(tag);
  }
  if (!hasDuplicate) return [];
  return [
    violation({
      rule: "TAG-DUPLICATE",
      field: "tags",
      found: JSON.stringify(tags),
      expected: "no duplicate tag entries",
      mechanical: true,
      suggested_fix: { op: "set_list", field: "tags", value: deduped },
    }),
  ];
}

/** Port of `_check_dates`: DATE-FORMAT over suffix-matched and manifest date fields. */
function checkDates(frontmatter: Frontmatter, base: BaseSchema, manifest: Manifest | undefined): Violation[] {
  const violations: Violation[] = [];
  for (const name of dateFieldsToCheck(frontmatter, base, manifest)) {
    const value = fmGet(frontmatter, name);
    if (isEmpty(value)) continue;
    for (const item of asList(value)) {
      if (isEmpty(item) || isIsoDateValue(item)) continue;
      const fix = suggestIsoFix(item);
      violations.push(
        violation({
          rule: "DATE-FORMAT",
          field: name,
          found: shown(item),
          expected: "ISO date (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)",
          mechanical: !!fix,
          suggested_fix: fix ? { op: "set_field", field: name, value: fix } : null,
        })
      );
    }
  }
  return violations;
}

/** Port of `_check_timestamps`: CREATED-MISSING fires for every note with no `created`. */
function checkTimestamps(frontmatter: Frontmatter): Violation[] {
  if (isEmpty(fmGet(frontmatter, "created"))) {
    return [
      violation({
        rule: "CREATED-MISSING",
        field: "created",
        found: null,
        expected: "Linter-managed timestamp present",
      }),
    ];
  }
  return [];
}

/** Port of `_check_field_value`: type + closed-value checks for one present manifest field. */
function checkFieldValue(spec: FieldSpec, value: unknown): Violation[] {
  const violations: Violation[] = [];
  const t = spec.type;

  if (t === "date" || t === "datetime") {
    return []; // handled by DATE-FORMAT
  }

  if (t === "number") {
    for (const item of asList(value)) {
      if (typeof item !== "number") {
        violations.push(
          violation({ rule: "CLASS-FIELD-TYPE", field: spec.name, found: shown(item), expected: "a number" })
        );
      }
    }
  } else if (t === "url") {
    for (const item of asList(value)) {
      if (typeof item !== "string" || !(item.startsWith("http://") || item.startsWith("https://"))) {
        violations.push(
          violation({ rule: "CLASS-FIELD-TYPE", field: spec.name, found: shown(item), expected: "an http(s) URL" })
        );
      }
    }
  } else if (t === "wikilink") {
    for (const item of asList(value)) {
      if (typeof item !== "string" || !WIKILINK_RE.test(item.trim())) {
        violations.push(
          violation({ rule: "CLASS-FIELD-TYPE", field: spec.name, found: shown(item), expected: "a [[wikilink]]" })
        );
      }
    }
  } else if (t === "list") {
    for (const item of asList(value)) {
      if (isDictOrList(item)) {
        violations.push(
          violation({ rule: "CLASS-FIELD-TYPE", field: spec.name, found: shown(item), expected: "a scalar list item" })
        );
      }
    }
  } else if (t === "select") {
    if (Array.isArray(value)) {
      violations.push(
        violation({
          rule: "CLASS-FIELD-TYPE",
          field: spec.name,
          found: shown(value),
          expected: "a single value, not a list",
        })
      );
    } else if (spec.values && spec.values.length > 0 && !spec.values.includes(String(value))) {
      violations.push(
        violation({
          rule: "CLASS-FIELD-VALUE",
          field: spec.name,
          found: shown(value),
          expected: `one of: ${spec.values.join(", ")}`,
        })
      );
    }
  } else if (t === "multi") {
    if (spec.values && spec.values.length > 0) {
      for (const item of asList(value)) {
        if (!spec.values.includes(String(item))) {
          violations.push(
            violation({
              rule: "CLASS-FIELD-VALUE",
              field: spec.name,
              found: shown(item),
              expected: `one of: ${spec.values.join(", ")}`,
            })
          );
        }
      }
    }
  } else if (t === "text") {
    if (isDictOrList(value)) {
      violations.push(
        violation({ rule: "CLASS-FIELD-TYPE", field: spec.name, found: shown(value), expected: "a text value" })
      );
    }
  }
  return violations;
}

/** Port of `_check_class`: CLASS-UNKNOWN, CLASS-FIELD-MISSING, and (via checkFieldValue) -TYPE/-VALUE. */
function checkClass(frontmatter: Frontmatter, manifests: Record<string, Manifest>): Violation[] {
  const classValue = fmGet(frontmatter, "class");
  if (isEmpty(classValue)) return [];
  const className = String(asList(classValue)[0]);
  const manifest = manifests[className];
  if (!manifest) {
    const names = Object.keys(manifests).sort();
    return [
      violation({
        rule: "CLASS-UNKNOWN",
        field: "class",
        found: className,
        expected: `a class with a manifest (${names.length > 0 ? names.join(", ") : "none loaded"})`,
      }),
    ];
  }

  const violations: Violation[] = [];
  for (const [name, spec] of Object.entries(manifest.fields ?? {})) {
    const value = fmGet(frontmatter, name);
    if (isEmpty(value)) {
      if (spec.required) {
        violations.push(
          violation({
            rule: "CLASS-FIELD-MISSING",
            field: name,
            found: null,
            expected: `required ${spec.type} field for class ${className}`,
          })
        );
      } else if (spec.required_when) {
        const { field: condField, equals: condValue } = spec.required_when;
        const actual = fmGet(frontmatter, condField);
        if (!isEmpty(actual) && String(actual) === condValue) {
          violations.push(
            violation({
              rule: "CLASS-FIELD-MISSING",
              field: name,
              found: null,
              expected: `required ${spec.type} field when ${condField} is ${condValue} (class ${className})`,
            })
          );
        }
      }
      continue;
    }
    violations.push(...checkFieldValue(spec, value));
  }
  return violations;
}

/** Port of `_check_class_location`: CLASS-EXPECTED (no class) / CLASS-MISFILED (wrong folder). */
function checkClassLocation(
  path: string,
  frontmatter: Frontmatter,
  classLocations: ClassLocation[]
): Violation[] {
  if (!classLocations || classLocations.length === 0) return [];
  const classValue = fmGet(frontmatter, "class");
  if (isEmpty(classValue)) {
    const expected = classForPath(path, classLocations);
    if (expected === null) return [];
    return [
      violation({
        rule: "CLASS-EXPECTED",
        field: "class",
        found: null,
        expected,
        mechanical: true,
        suggested_fix: { op: "set_field", field: "class", value: expected },
      }),
    ];
  }
  const className = String(asList(classValue)[0]);
  const prefixes = prefixesForClass(className, classLocations);
  if (prefixes.length === 0) return []; // class not in the map at all
  if (prefixes.some((p) => path.startsWith(p))) return [];
  return [
    violation({
      rule: "CLASS-MISFILED",
      field: "class",
      found: className,
      expected: `under one of: ${[...prefixes].sort().join(", ")}`,
    }),
  ];
}

const MS_PER_DAY = 86_400_000;

/**
 * Port of `_check_status_stale`: a lifecycle rule's date field has passed (or
 * is more than age_days old) while status is still in when_status — suggest
 * the next status. Only runs when the caller injects `today` (YYYY-MM-DD).
 */
function checkStatusStale(
  frontmatter: Frontmatter,
  manifest: Manifest | undefined,
  today: string | null | undefined
): Violation[] {
  if (!manifest || !today || !manifest.lifecycle || manifest.lifecycle.length === 0) return [];
  const todayMs = parseDateValueMs(today);
  if (todayMs === null) return [];
  const status = fmGet(frontmatter, "status");
  if (isEmpty(status)) return [];
  const statusStr = String(status);

  const violations: Violation[] = [];
  for (const rule of manifest.lifecycle) {
    if (!rule.when_status.includes(statusStr)) continue;
    const dateValue = fmGet(frontmatter, rule.date_field);
    if (isEmpty(dateValue)) continue;
    const parsedMs = parseDateValueMs(dateValue);
    if (parsedMs === null) continue;
    if (rule.age_days !== null && rule.age_days !== undefined) {
      // Age semantics: the date is expected to be in the past; stale means
      // it's been MORE than age_days ago (transient states).
      if (Math.round((todayMs - parsedMs) / MS_PER_DAY) <= rule.age_days) continue;
    } else if (parsedMs > todayMs) {
      continue;
    }
    violations.push(
      violation({
        rule: "STATUS-STALE",
        field: "status",
        found: statusStr,
        expected: rule.suggest,
        mechanical: true,
        suggested_fix: { op: "set_field", field: "status", value: rule.suggest },
      })
    );
  }
  return violations;
}

/** Port of `_apply_suppressions`: `validator_ignore` frontmatter marks matching violations suppressed. */
function applyIgnoreSuppression(frontmatter: Frontmatter, violations: Violation[]): void {
  const ignored = new Set(asList(fmGet(frontmatter, "validator_ignore")).map((r) => String(r).trim().toUpperCase()));
  if (ignored.size === 0) return;
  for (const v of violations) {
    if (ignored.has(v.rule)) v.suppressed = true;
  }
}

/**
 * Apply validator_ignore + exception suppression to externally-produced
 * violations (e.g. the plugin's title-sync rules) with the same semantics the
 * engine uses internally. Returns [] when a full-skip exception matches.
 */
export function applySuppressions(
  frontmatter: Frontmatter,
  path: string,
  exceptions: ExceptionRule[] | undefined,
  violations: Violation[]
): Violation[] {
  const matched = (exceptions ?? []).filter((e) => exceptionMatches(path, e));
  if (matched.some((e) => e.rules === null || e.rules === undefined)) return [];
  applyIgnoreSuppression(frontmatter, violations);
  const byException = new Set<string>();
  for (const e of matched) {
    if (e.rules) for (const ruleId of e.rules) byException.add(ruleId);
  }
  for (const v of violations) {
    if (byException.has(v.rule)) v.suppressed = true;
  }
  return violations;
}

/**
 * Validate one note against the loaded schema/manifests/class-locations/
 * exceptions. Deterministic and side-effect free; never throws, even on
 * malformed or missing input. A note fully skipped by an exceptions.yaml
 * entry with no `rules:` returns [].
 */
export const validate: Validate = (input: ValidationInput): Violation[] => {
  try {
    const path = input?.file?.path ?? "";
    const frontmatter: Frontmatter = input?.file?.frontmatter ?? null;
    const base = input?.base;
    if (!base) return [];
    const manifests = input?.manifests ?? {};
    const classLocations = input?.class_locations ?? [];
    const exceptions = input?.exceptions ?? [];

    // Exceptions: full-skip entries (no `rules:`) short-circuit everything.
    const matched = exceptions.filter((e) => exceptionMatches(path, e));
    if (matched.some((e) => e.rules === null || e.rules === undefined)) {
      return [];
    }
    const suppressedByException = new Set<string>();
    for (const e of matched) {
      if (e.rules) {
        for (const ruleId of e.rules) suppressedByException.add(ruleId);
      }
    }

    // Resolve the note's manifest (if any) once, for date-field checking.
    const classValue = fmGet(frontmatter, "class");
    let manifest: Manifest | undefined;
    if (!isEmpty(classValue)) {
      manifest = manifests[String(asList(classValue)[0])];
    }

    const violations: Violation[] = [];
    violations.push(...checkBaseFields(path, frontmatter, base));
    violations.push(...checkTags(frontmatter, base, input?.segment_casings));
    violations.push(...checkTagDuplicates(frontmatter));
    violations.push(...checkDates(frontmatter, base, manifest));
    violations.push(...checkTimestamps(frontmatter));
    violations.push(...checkClass(frontmatter, manifests));
    violations.push(...checkClassLocation(path, frontmatter, classLocations));
    violations.push(...checkStatusStale(frontmatter, manifest, input?.today));

    applyIgnoreSuppression(frontmatter, violations);
    for (const v of violations) {
      if (suppressedByException.has(v.rule)) v.suppressed = true;
    }
    return violations;
  } catch {
    return [];
  }
};
