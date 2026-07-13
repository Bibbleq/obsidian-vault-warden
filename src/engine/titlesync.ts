/**
 * Pure filename <-> H1 title-sync analysis module.
 *
 * Plugin-only feature: keeps a note's first level-1 heading, its filename,
 * and (optionally) one frontmatter property all in agreement. The H1 is
 * always the source of truth; the filename and the frontmatter title
 * property are both projections of it.
 *
 * Clean-room implementation from a written spec only — no code or design
 * from any third-party "sync heading/filename" plugin was consulted.
 *
 * IMPORTANT: nothing here may import from "obsidian" or Node built-ins. This
 * is a plain function over plain data so it runs headless under vitest, and
 * never throws on malformed input (matches the rest of src/engine).
 */

import type { SuggestedFix, TitleSyncConfig, Violation } from "./types";

/** Everything `analyzeTitle` needs to judge one note. */
export interface TitleInput {
  /** Vault-relative path, posix separators. */
  path: string;
  /** Current filename without extension. */
  basename: string;
  /** First level-1 heading text; null when the note has no H1. */
  h1: string | null;
  frontmatter: Record<string, unknown> | null;
  config: TitleSyncConfig;
}

/** Collapse any run of whitespace to a single ASCII space. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

/** Strip all whitespace, used only for the "differ by whitespace only" guard. */
function stripAllWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

/** `config.remap` as an ordered list of [key, value] string pairs, tolerating malformed input. */
function safeRemapEntries(remap: unknown): [string, string][] {
  if (!remap || typeof remap !== "object") return [];
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(remap as Record<string, unknown>)) {
    if (typeof key === "string" && key.length > 0 && typeof value === "string") {
      entries.push([key, value]);
    }
  }
  return entries;
}

/** `config.strip` as a Set of single characters, tolerating malformed input. */
function safeStripSet(strip: unknown): Set<string> {
  if (typeof strip !== "string" || strip.length === 0) return new Set();
  return new Set(Array.from(strip));
}

/**
 * The lossy projection H1 -> filename:
 *   1. apply every `config.remap` entry (occurrence -> value, in order)
 *   2. remove every character in `config.strip`, replacing with `config.replacement`
 *   3. collapse whitespace runs to a single space
 *   4. trim
 *   5. strip trailing "." characters (Windows can't end a filename in a dot), then trim again
 *
 * Defensive: a null/undefined/wrong-typed config or config member is treated
 * as empty (no remap, no strip, no replacement) rather than thrown on.
 */
export function sanitiseTitle(title: string, config: TitleSyncConfig): string {
  if (typeof title !== "string") return "";

  let result = title;

  for (const [key, value] of safeRemapEntries(config?.remap)) {
    result = result.split(key).join(value);
  }

  const stripSet = safeStripSet(config?.strip);
  const replacement = typeof config?.replacement === "string" ? config.replacement : "";
  if (stripSet.size > 0) {
    let out = "";
    for (const ch of result) {
      out += stripSet.has(ch) ? replacement : ch;
    }
    result = out;
  }

  result = collapseWhitespace(result).trim();
  result = result.replace(/\.+$/, "");
  result = result.trim();

  return result;
}

/**
 * True when any regex in `config.ignore` matches `path`. Patterns are
 * compiled defensively: an invalid pattern is skipped (never thrown), and a
 * non-array/malformed `config.ignore` is treated as an empty list.
 */
export function isIgnoredPath(path: string, config: TitleSyncConfig): boolean {
  if (typeof path !== "string") return false;
  const patterns = Array.isArray(config?.ignore) ? config.ignore : [];

  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    try {
      const re = new RegExp(pattern);
      if (re.test(path)) return true;
    } catch {
      // Invalid pattern - skip it, never throw.
    }
  }
  return false;
}

function setH1Fix(value: string): SuggestedFix {
  return { op: "set_h1", field: "h1", value };
}

/**
 * Analyze one note's title-sync state. Decision ladder, first match wins for
 * the H1/filename legs (2-5); the TITLE-PROPERTY leg (6) is independent and
 * can co-occur with any of 4/5 (or fire on its own), except when case 3
 * (H1-DEGENERATE) already fired.
 *
 * Never throws on malformed input; an ignored path always returns [].
 */
export function analyzeTitle(input: TitleInput): Violation[] {
  if (!input || typeof input !== "object") return [];

  const path = input.path;
  const basename = typeof input.basename === "string" ? input.basename : "";
  const h1 = typeof input.h1 === "string" ? input.h1 : null;
  const frontmatter =
    input.frontmatter && typeof input.frontmatter === "object" && !Array.isArray(input.frontmatter)
      ? (input.frontmatter as Record<string, unknown>)
      : null;
  const config = input.config;

  // 1. Ignored paths are fully exempt.
  if (isIgnoredPath(path, config)) return [];

  const violations: Violation[] = [];
  let degenerate = false;

  if (h1 === null) {
    // 2. No H1 at all.
    violations.push({
      rule: "H1-MISSING",
      field: "h1",
      found: null,
      expected: basename,
      mechanical: true,
      suggested_fix: setH1Fix(basename),
      suppressed: false,
    });
  } else if (sanitiseTitle(h1, config) === "") {
    // 3. The H1 projects to nothing (whitespace/punctuation-only).
    degenerate = true;
    violations.push({
      rule: "H1-DEGENERATE",
      field: "h1",
      found: h1,
      expected: basename,
      mechanical: true,
      suggested_fix: setH1Fix(basename),
      suppressed: false,
    });
  } else {
    const normalized = collapseWhitespace(h1).trim();
    if (normalized !== h1 && sanitiseTitle(normalized, config) === basename) {
      // 4. Only cosmetically off (raw whitespace), the normalized form already matches.
      violations.push({
        rule: "H1-WHITESPACE",
        field: "h1",
        found: h1,
        expected: normalized,
        mechanical: true,
        suggested_fix: setH1Fix(normalized),
        suppressed: false,
      });
    } else {
      // 5. Filename should follow the H1's projection.
      const candidate = sanitiseTitle(h1, config);
      if (candidate !== basename) {
        const emptyCandidate = candidate === ""; // belt-and-braces; case 3 already covers real degeneracy
        const whitespaceOnlyDiff = stripAllWhitespace(candidate) === stripAllWhitespace(basename);
        if (!emptyCandidate && !whitespaceOnlyDiff) {
          violations.push({
            rule: "FILENAME-SYNC",
            field: "filename",
            found: basename,
            expected: candidate,
            mechanical: true,
            suggested_fix: { op: "rename_file", field: "filename", value: candidate },
            suppressed: false,
          });
        }
      }
    }
  }

  // 6. Independent leg: keep a frontmatter property equal to the H1.
  const titleField = config?.frontmatter_title;
  if (typeof titleField === "string" && titleField.length > 0 && h1 !== null && !degenerate) {
    const currentValue = frontmatter ? frontmatter[titleField] : undefined;
    const isAbsent = currentValue === undefined || currentValue === null;
    const comparisonValue = isAbsent ? "" : String(currentValue);
    if (comparisonValue !== h1) {
      violations.push({
        rule: "TITLE-PROPERTY",
        field: titleField,
        found: isAbsent ? null : String(currentValue),
        expected: h1,
        mechanical: true,
        suggested_fix: { op: "set_field", field: titleField, value: h1 },
        suppressed: false,
      });
    }
  }

  return violations;
}
