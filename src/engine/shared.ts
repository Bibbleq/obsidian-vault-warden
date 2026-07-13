/**
 * Small pure helpers shared across the rule checks in validate.ts.
 *
 * Everything here is defensive by design: malformed or missing input (null
 * frontmatter, absent config keys, wrong-typed values) is treated leniently
 * rather than thrown on, per the engine's contract.
 */

import type { BaseSchema, FixTier, RuleConfig, RuleId } from "./types";

/** Frontmatter as the engine sees it: parsed YAML/JSON data, or null when a note has none. */
export type Frontmatter = Record<string, unknown> | null;

/**
 * A value counts as "missing" when the key is absent (undefined), null, an
 * empty/whitespace-only string, or an empty array.
 */
export function isMissing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Best-effort stringification of an offending value for the `found` field. */
export function stringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Read a frontmatter key, tolerating a null/non-object frontmatter. */
export function getField(frontmatter: Frontmatter, key: string): unknown {
  if (!frontmatter || typeof frontmatter !== "object") return undefined;
  return (frontmatter as Record<string, unknown>)[key];
}

/** `config.class_key`, defaulting to "class". */
export function getClassKey(config: BaseSchema): string {
  return config.class_key || "class";
}

/** `config.ignore_key`, defaulting to "validator_ignore". */
export function getIgnoreKey(config: BaseSchema): string {
  return config.ignore_key || "validator_ignore";
}

/**
 * The set of rule IDs this note opts out of, read from
 * frontmatter[ignore_key]. Accepts a bare string or an array of strings;
 * non-string array entries are ignored. Null/missing frontmatter or an
 * unusable value yields an empty set.
 */
export function getIgnoredRules(frontmatter: Frontmatter, ignoreKey: string): Set<string> {
  const raw = getField(frontmatter, ignoreKey);
  if (typeof raw === "string") return new Set([raw]);
  if (Array.isArray(raw)) {
    return new Set(raw.filter((v): v is string => typeof v === "string"));
  }
  return new Set();
}

/**
 * Frontmatter tags, normalised: accepts a bare string or an array, drops
 * non-string entries, and strips a single leading "#" from each tag.
 */
export function getTags(frontmatter: Frontmatter): string[] {
  const raw = getField(frontmatter, "tags");
  let list: unknown[];
  if (typeof raw === "string") list = [raw];
  else if (Array.isArray(raw)) list = raw;
  else return [];
  return list
    .filter((t): t is string => typeof t === "string")
    .map((t) => (t.startsWith("#") ? t.slice(1) : t));
}

/**
 * The note's class name, if frontmatter[class_key] is a non-missing string.
 * Non-string class values (numbers, arrays, objects) resolve to no class,
 * since they can never match a manifest key.
 */
export function resolveClassName(frontmatter: Frontmatter, classKey: string): string | undefined {
  const value = getField(frontmatter, classKey);
  if (typeof value !== "string" || isMissing(value)) return undefined;
  return value;
}

/**
 * The class mapped by `class_locations` for this note's path, using
 * deepest-folder-wins matching. A note matches a folder when its path
 * starts with `folder + "/"`; an empty-string folder never matches.
 */
export function findClassLocation(
  path: string,
  classLocations: Record<string, string> | undefined
): string | undefined {
  if (!classLocations) return undefined;
  let bestFolder: string | undefined;
  let bestClass: string | undefined;
  for (const [folder, className] of Object.entries(classLocations)) {
    if (folder === "") continue;
    const prefix = `${folder}/`;
    if (path.startsWith(prefix) && (bestFolder === undefined || folder.length > bestFolder.length)) {
      bestFolder = folder;
      bestClass = className;
    }
  }
  return bestClass;
}

/** Look up a rule's config by ID; undefined means the rule never runs. */
export function getRuleConfig(config: BaseSchema, id: RuleId): RuleConfig | undefined {
  return config.rules?.[id];
}

/** The fix tier for a rule config, defaulting to "none" if malformed/absent. */
export function fixTier(ruleConfig: RuleConfig | undefined): FixTier {
  return ruleConfig?.fix ?? "none";
}
