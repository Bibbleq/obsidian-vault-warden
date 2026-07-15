/**
 * Pure fix-application module: turns a `Violation.suggested_fix` into an
 * in-place mutation of a frontmatter object.
 *
 * This is called from inside `app.fileManager.processFrontMatter`, which
 * hands the adapter the live frontmatter object to mutate directly (Obsidian
 * writes it back to disk after the callback returns). Nothing here may
 * import "obsidian" or Node built-ins — it's a plain function over plain
 * data so it stays headless under vitest, matching the rest of src/engine.
 *
 * Callers use the boolean/count return values as a no-op guard: if applying
 * every fix for a note changed nothing, skip the disk write entirely.
 */

import type { SuggestedFix, Violation } from "./types";
import { valuesEqual } from "./shared";

/**
 * Apply one suggested fix to `fm`, mutating it in place. Returns true only
 * if `fm` actually changed as a result.
 *
 * `found` is the violation's `found` value (not `fix.found`) — for
 * `set_field` it identifies which element of an array-valued field to
 * replace (the DATE-FORMAT-inside-a-list case: the suggested fix carries
 * the corrected single item, not the whole list, so clobbering the whole
 * field would lose the other entries).
 *
 * Defensive throughout: malformed fm/fix (missing field, wrong types, an
 * unrecognised op) never throws — it just returns false.
 */
export function applyFixToFrontmatter(
  fm: Record<string, unknown>,
  fix: SuggestedFix,
  found?: string | null
): boolean {
  if (!fm || typeof fm !== "object") return false;
  if (!fix || typeof fix !== "object") return false;

  const field = fix.field;
  if (typeof field !== "string" || field.length === 0) return false;

  switch (fix.op) {
    case "set_field": {
      const current = fm[field];
      if (Array.isArray(current) && typeof found === "string") {
        const matchIndexes: number[] = [];
        for (let i = 0; i < current.length; i++) {
          if (current[i] === found) matchIndexes.push(i);
        }
        if (matchIndexes.length > 0) {
          const next = current.slice();
          for (const i of matchIndexes) next[i] = fix.value;
          if (valuesEqual(next, current)) return false;
          fm[field] = next;
          return true;
        }
        // No element of the array matched `found` — fall through to a
        // plain assignment below.
      }
      if (valuesEqual(fm[field], fix.value)) return false;
      fm[field] = fix.value;
      return true;
    }

    case "remove": {
      if (!Object.prototype.hasOwnProperty.call(fm, field)) return false;
      delete fm[field];
      return true;
    }

    case "replace_tag": {
      const tagFound = fix.found;
      if (typeof tagFound !== "string") return false;
      const current = fm[field];
      if (Array.isArray(current)) {
        let changed = false;
        const next = current.map((item) => {
          if (item === tagFound) {
            changed = true;
            return fix.value;
          }
          return item;
        });
        if (!changed) return false;
        fm[field] = next;
        return true;
      }
      if (typeof current === "string" && current === tagFound) {
        fm[field] = fix.value;
        return true;
      }
      return false;
    }

    case "remove_tag": {
      const tagFound = fix.found;
      if (typeof tagFound !== "string") return false;
      const current = fm[field];
      if (Array.isArray(current)) {
        const next = current.filter((item) => item !== tagFound);
        if (next.length === current.length) return false;
        fm[field] = next;
        return true;
      }
      if (typeof current === "string" && current === tagFound) {
        delete fm[field];
        return true;
      }
      return false;
    }

    case "set_list": {
      const current = fm[field];
      if (valuesEqual(current, fix.value)) return false;
      fm[field] = fix.value;
      return true;
    }

    case "wrap_in_code":
    default:
      // Body-content ops (and anything unrecognised) are out of scope for
      // frontmatter fix application.
      return false;
  }
}

/**
 * Apply every applicable violation's `suggested_fix` to `fm`, in order.
 * Skips violations with no fix, non-mechanical violations, and suppressed
 * violations. Returns the number of violations that actually changed `fm`.
 *
 * Fixes are applied sequentially against the same `fm` object, so an
 * earlier fix's mutation is visible to a later fix on the same field
 * (e.g. a `replace_tag` followed by a `remove_tag` on the same tags array
 * compose correctly, since each call re-reads `fm[field]` fresh).
 */
export function applyAllFixes(fm: Record<string, unknown>, violations: Violation[]): number {
  if (!fm || typeof fm !== "object") return 0;
  if (!Array.isArray(violations)) return 0;

  let changedCount = 0;
  for (const violation of violations) {
    if (!violation || typeof violation !== "object") continue;
    if (violation.suppressed) continue;
    if (!violation.mechanical) continue;
    const fix = violation.suggested_fix;
    if (!fix) continue;
    if (applyFixToFrontmatter(fm, fix, violation.found)) {
      changedCount += 1;
    }
  }
  return changedCount;
}
