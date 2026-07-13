/**
 * Vault Warden's pure rule engine.
 *
 * `validate` is the single entry point: given a parsed base schema, the
 * loaded class manifests, resolved source lists, and one note's path and
 * frontmatter, it returns every violation. It never throws and never
 * mutates its input, so it runs identically headless (fixtures/vitest) and
 * inside the Obsidian adapter.
 */

import type { ClassManifest, RuleConfig, RuleId, Validate, ValidationInput, Violation } from "./types";
import { matchesAnyFormat } from "./dates";
import {
  findClassLocation,
  fixTier,
  getClassKey,
  getField,
  getIgnoreKey,
  getIgnoredRules,
  getRuleConfig,
  getTags,
  isMissing,
  resolveClassName,
  stringify,
  type Frontmatter,
} from "./shared";

const PASCAL_SEGMENT_RE = /^[0-9]*[A-Z][A-Za-z0-9]*$/;
const WIKILINK_RE = /^\[\[.+\]\]$/;

/** CLASS-FIELD-MISSING: every required field of the note's class that is missing. */
function checkClassFieldMissing(
  manifest: ClassManifest,
  frontmatter: Frontmatter,
  ruleConfig: RuleConfig
): Violation[] {
  const violations: Violation[] = [];
  const fields = manifest.fields ?? {};
  for (const [key, spec] of Object.entries(fields)) {
    if (!spec.required) continue;
    if (!isMissing(getField(frontmatter, key))) continue;
    violations.push({
      rule: "CLASS-FIELD-MISSING",
      field: key,
      expected: spec.type,
      fix: fixTier(ruleConfig),
      message: `Required field "${key}" is missing${spec.type ? ` (expected ${spec.type})` : ""}.`,
    });
  }
  return violations;
}

function typeViolation(field: string, type: string, value: unknown, ruleConfig: RuleConfig): Violation {
  return {
    rule: "CLASS-FIELD-TYPE",
    field,
    found: stringify(value),
    expected: type,
    fix: fixTier(ruleConfig),
    message: `Field "${field}" does not match declared type "${type}".`,
  };
}

function isWikilink(value: string): boolean {
  return WIKILINK_RE.test(value.trim());
}

/**
 * CLASS-FIELD-TYPE and DATE-FORMAT, run together since both inspect the same
 * present/non-missing class fields. Either rule config may be undefined, in
 * which case that rule's checks are skipped entirely (but the other still
 * runs). `areaField` is the field name owned by FM-AREA-INVALID (if any); a
 * select:-typed field with that name never gets a membership violation here.
 */
function checkClassFieldTypeAndDate(
  manifest: ClassManifest,
  frontmatter: Frontmatter,
  sources: Record<string, string[]>,
  areaField: string | undefined,
  typeConfig: RuleConfig | undefined,
  dateConfig: RuleConfig | undefined
): Violation[] {
  const violations: Violation[] = [];
  const fields = manifest.fields ?? {};

  for (const [key, spec] of Object.entries(fields)) {
    const type = spec.type;
    if (!type) continue;
    const value = getField(frontmatter, key);
    if (isMissing(value)) continue;

    if (type === "date") {
      if (typeof value !== "string") {
        if (typeConfig) violations.push(typeViolation(key, "date", value, typeConfig));
        continue;
      }
      if (dateConfig) {
        const formats = dateConfig.formats;
        if (formats && formats.length > 0 && !matchesAnyFormat(value, formats)) {
          const expected = formats.join(" | ");
          violations.push({
            rule: "DATE-FORMAT",
            field: key,
            found: value,
            expected,
            fix: fixTier(dateConfig),
            message: `Field "${key}" value "${value}" does not match any accepted date format (${expected}).`,
          });
        }
      }
      continue;
    }

    if (!typeConfig) continue; // remaining type checks all belong to CLASS-FIELD-TYPE

    if (type === "text") {
      if (typeof value !== "string") violations.push(typeViolation(key, "text", value, typeConfig));
    } else if (type === "list") {
      if (!Array.isArray(value)) violations.push(typeViolation(key, "list", value, typeConfig));
    } else if (type === "wikilink") {
      if (typeof value !== "string" || !isWikilink(value)) {
        violations.push(typeViolation(key, "wikilink", value, typeConfig));
      }
    } else if (type.startsWith("select:")) {
      if (typeof value !== "string") {
        violations.push(typeViolation(key, type, value, typeConfig));
        continue;
      }
      if (key === areaField) continue; // owned by FM-AREA-INVALID
      const sourceName = type.slice("select:".length);
      const list = sources[sourceName];
      if (!list) continue; // source unresolved: fail open
      if (!list.includes(value.trim())) {
        const expected = `one of ${sourceName}`;
        violations.push({
          rule: "CLASS-FIELD-TYPE",
          field: key,
          found: value,
          expected,
          fix: fixTier(typeConfig),
          message: `Field "${key}" value "${value}" is not in source list "${sourceName}".`,
        });
      }
    }
    // Unknown/absent type strings are skipped (no type checking).
  }

  return violations;
}

/** TAG-CASE: every '/'-segment of every tag must satisfy the configured case style. */
function checkTagCase(frontmatter: Frontmatter, ruleConfig: RuleConfig): Violation[] {
  if (ruleConfig.style !== "pascal") return [];
  const violations: Violation[] = [];
  for (const tag of getTags(frontmatter)) {
    const segments = tag.split("/");
    const ok = segments.every((segment) => PASCAL_SEGMENT_RE.test(segment));
    if (!ok) {
      violations.push({
        rule: "TAG-CASE",
        field: tag,
        found: tag,
        fix: fixTier(ruleConfig),
        message: `Tag "${tag}" is not PascalCase.`,
      });
    }
  }
  return violations;
}

/** TAG-RETIRED: any tag that is an exact key in the configured retirement map. */
function checkTagRetired(frontmatter: Frontmatter, ruleConfig: RuleConfig): Violation[] {
  const map = ruleConfig.map;
  if (!map) return [];
  const violations: Violation[] = [];
  for (const tag of getTags(frontmatter)) {
    if (!Object.prototype.hasOwnProperty.call(map, tag)) continue;
    const replacement = map[tag];
    const expected = replacement ?? "";
    violations.push({
      rule: "TAG-RETIRED",
      field: tag,
      found: tag,
      expected,
      fix: fixTier(ruleConfig),
      message: replacement
        ? `Tag "${tag}" is retired; use "${replacement}" instead.`
        : `Tag "${tag}" is retired; remove it.`,
    });
  }
  return violations;
}

/** FM-AREA-INVALID: a configured base field that must appear in a configured source list. */
function checkAreaInvalid(
  frontmatter: Frontmatter,
  sources: Record<string, string[]>,
  ruleConfig: RuleConfig
): Violation[] {
  const field = ruleConfig.field;
  const sourceName = ruleConfig.source;
  if (!field || !sourceName) return [];

  const value = getField(frontmatter, field);
  if (isMissing(value)) return [];

  if (typeof value !== "string") {
    return [
      {
        rule: "FM-AREA-INVALID",
        field,
        found: stringify(value),
        expected: `one of ${sourceName}`,
        fix: fixTier(ruleConfig),
        message: `Field "${field}" must be a string found in "${sourceName}".`,
      },
    ];
  }

  const list = sources[sourceName];
  if (!list) return []; // source unresolved: fail open

  const trimmed = value.trim();
  if (list.includes(trimmed)) return [];

  return [
    {
      rule: "FM-AREA-INVALID",
      field,
      found: value,
      expected: `one of ${sourceName}`,
      fix: fixTier(ruleConfig),
      message: `Field "${field}" value "${value}" is not in source list "${sourceName}".`,
    },
  ];
}

/**
 * CLASS-UNDECLARED: the note lives under a `class_locations` folder (deepest
 * match wins) but has no non-missing class declared. Must work with null
 * frontmatter.
 */
function checkClassUndeclared(
  path: string,
  frontmatter: Frontmatter,
  classLocations: Record<string, string> | undefined,
  classKey: string,
  ruleConfig: RuleConfig
): Violation[] {
  const mappedClass = findClassLocation(path, classLocations);
  if (!mappedClass) return [];
  if (!isMissing(getField(frontmatter, classKey))) return [];
  return [
    {
      rule: "CLASS-UNDECLARED",
      field: classKey,
      expected: mappedClass,
      fix: fixTier(ruleConfig),
      message: `Note is under a folder mapped to class "${mappedClass}" but has no "${classKey}" declared.`,
    },
  ];
}

/**
 * Validate one note against the vault's rule configuration. Deterministic
 * and side-effect free; never throws, even on malformed/missing input.
 */
export const validate: Validate = (input: ValidationInput): Violation[] => {
  const config = input.config ?? {};
  const classes = input.classes ?? {};
  const sources = input.sources ?? {};
  const frontmatter: Frontmatter = input.file?.frontmatter ?? null;
  const path = input.file?.path ?? "";

  const classKey = getClassKey(config);
  const ignoreKey = getIgnoreKey(config);
  const ignored = getIgnoredRules(frontmatter, ignoreKey);

  const enabled = (id: RuleId): RuleConfig | undefined => {
    if (ignored.has(id)) return undefined;
    return getRuleConfig(config, id);
  };

  const violations: Violation[] = [];

  const areaCfg = enabled("FM-AREA-INVALID");
  if (areaCfg) {
    violations.push(...checkAreaInvalid(frontmatter, sources, areaCfg));
  }

  const tagCaseCfg = enabled("TAG-CASE");
  if (tagCaseCfg) {
    violations.push(...checkTagCase(frontmatter, tagCaseCfg));
  }

  const tagRetiredCfg = enabled("TAG-RETIRED");
  if (tagRetiredCfg) {
    violations.push(...checkTagRetired(frontmatter, tagRetiredCfg));
  }

  const undeclaredCfg = enabled("CLASS-UNDECLARED");
  if (undeclaredCfg) {
    violations.push(
      ...checkClassUndeclared(path, frontmatter, config.class_locations, classKey, undeclaredCfg)
    );
  }

  const className = resolveClassName(frontmatter, classKey);
  const manifest = className ? classes[className] : undefined;
  if (manifest) {
    const missingCfg = enabled("CLASS-FIELD-MISSING");
    if (missingCfg) {
      violations.push(...checkClassFieldMissing(manifest, frontmatter, missingCfg));
    }

    const typeCfg = enabled("CLASS-FIELD-TYPE");
    const dateCfg = enabled("DATE-FORMAT");
    if (typeCfg || dateCfg) {
      // The FM-AREA-INVALID field is "owned" by that rule for membership
      // checks regardless of whether it fires (or is ignored) on this note.
      const areaField = config.rules?.["FM-AREA-INVALID"]?.field;
      violations.push(...checkClassFieldTypeAndDate(manifest, frontmatter, sources, areaField, typeCfg, dateCfg));
    }
  }

  return violations;
};
