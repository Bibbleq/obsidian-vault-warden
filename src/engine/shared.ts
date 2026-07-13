/**
 * Small pure helpers shared across the rule checks in validate.ts and dates.ts.
 *
 * Ported from the Bibble-style Python validator (`rules.py` / `class_locations.py`
 * / `exceptions.py`). Everything here is defensive by design: malformed or
 * missing input (null frontmatter, absent fields, wrong-typed values) is
 * tolerated rather than thrown on, per the engine's contract.
 */

import type { ClassLocation, ExceptionRule } from "./types";

/** Frontmatter as the engine sees it: parsed YAML/JSON data, or null when a note has none. */
export type Frontmatter = Record<string, unknown> | null | undefined;

/** Read a frontmatter key, tolerating null/non-object frontmatter. */
export function fmGet(frontmatter: Frontmatter, key: string): unknown {
  if (!frontmatter || typeof frontmatter !== "object") return undefined;
  return (frontmatter as Record<string, unknown>)[key];
}

/**
 * Port of `_is_empty`: null/undefined, whitespace-only string, empty array,
 * or empty plain object (but not an empty Date or other object type).
 */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/** True for plain objects (YAML mappings), false for arrays/Date/null/primitives. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** True when `value` is an array or a plain object — used by list/text field checks. */
export function isDictOrList(value: unknown): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

/** Port of `_as_list`: null/undefined -> [], array -> itself, anything else -> [value]. */
export function asList(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

/**
 * Port of `_shown`: strings pass through as-is; non-strings are JSON-stringified
 * (the Python reference uses `repr()`, but per the porting brief fixtures don't
 * assert `found` values beyond strings, so JSON is the TS-idiomatic choice).
 */
export function shown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Port of Python `==` for tag-duplicate detection: primitives compare with
 * strict equality, non-primitives (arrays/objects) compare by JSON shape.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const aIsPrimitive = a === null || (typeof a !== "object" && typeof a !== "function");
  const bIsPrimitive = b === null || (typeof b !== "object" && typeof b !== "function");
  if (aIsPrimitive || bIsPrimitive) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Port of `pascal_case_tag`: strip all leading '#' runs, split on '/', then
 * within each segment split on runs of -_/space and capitalize each chunk's
 * first character. Also serves as the no-index degenerate case of
 * `suggest_tag_casing` (the Python version's vault-wide casing memory is a
 * batch-only feature; the write-time subset always falls back to this).
 */
export function pascalCaseTag(tag: string): string {
  const segments = tag.replace(/^#+/, "").split("/");
  const fixed: string[] = [];
  for (const segment of segments) {
    const chunks = segment.split(/[-_ ]+/).filter((c) => c.length > 0);
    fixed.push(chunks.map((c) => c[0].toUpperCase() + c.slice(1)).join(""));
  }
  return fixed.filter((part) => part.length > 0).join("/");
}

/**
 * Port of `derive_area`: the longest valid area whose '/'-segments are a
 * prefix of the note's own folder segments. Root-level notes (no folder) or
 * folders matching no configured area return null.
 */
export function deriveArea(notePath: string, validAreas: string[]): string | null {
  const idx = notePath.lastIndexOf("/");
  const folder = idx >= 0 ? notePath.slice(0, idx) : "";
  if (!folder) return null;
  const folderSegments = folder.split("/");
  let best: string | null = null;
  let bestLen = 0;
  for (const area of validAreas) {
    const areaSegments = area.split("/");
    const n = areaSegments.length;
    if (n <= folderSegments.length && n > bestLen) {
      let match = true;
      for (let i = 0; i < n; i++) {
        if (folderSegments[i] !== areaSegments[i]) {
          match = false;
          break;
        }
      }
      if (match) {
        best = area;
        bestLen = n;
      }
    }
  }
  return best;
}

/** Escape one character for inclusion in a generated RegExp source string. */
function escapeRegExpChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Translate an fnmatch-style glob (`*`, `?`, `[seq]`/`[!seq]`) into an
 * anchored, case-sensitive RegExp — a small port of Python's
 * `fnmatch.translate`. Never throws: an unterminated `[` is treated as a
 * literal bracket, matching Python's lenient fallback behaviour.
 */
export function fnmatchToRegExp(pattern: string): RegExp {
  let i = 0;
  const n = pattern.length;
  let res = "";
  while (i < n) {
    const c = pattern[i];
    i += 1;
    if (c === "*") {
      res += ".*";
    } else if (c === "?") {
      res += ".";
    } else if (c === "[") {
      let j = i;
      if (j < n && (pattern[j] === "!" || pattern[j] === "]")) j += 1;
      while (j < n && pattern[j] !== "]") j += 1;
      if (j >= n) {
        res += "\\[";
      } else {
        let stuff = pattern.slice(i, j).replace(/\\/g, "\\\\");
        i = j + 1;
        if (stuff.startsWith("!")) {
          stuff = "^" + stuff.slice(1);
        } else if (stuff.startsWith("^")) {
          stuff = "\\" + stuff;
        }
        res += `[${stuff}]`;
      }
    } else {
      res += escapeRegExpChar(c);
    }
  }
  return new RegExp(`^${res}$`);
}

/** Does this exceptions.yaml entry match `path` — exact path or fnmatch pattern? */
export function exceptionMatches(path: string, entry: ExceptionRule): boolean {
  if (entry.path !== undefined && entry.path !== null) return path === entry.path;
  if (entry.pattern !== undefined && entry.pattern !== null) {
    try {
      return fnmatchToRegExp(entry.pattern).test(path);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Port of `class_for_path`: the class of the longest configured prefix that
 * `path` starts with (plain `startsWith`, no globbing). Ties keep whichever
 * entry was encountered first.
 */
export function classForPath(path: string, locations: ClassLocation[]): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const loc of locations) {
    if (path.startsWith(loc.prefix) && loc.prefix.length > bestLen) {
      best = loc.class;
      bestLen = loc.prefix.length;
    }
  }
  return best;
}

/** Port of `prefixes_for_class`: every configured prefix mapped to `className`. */
export function prefixesForClass(className: string, locations: ClassLocation[]): string[] {
  return locations.filter((loc) => loc.class === className).map((loc) => loc.prefix);
}
