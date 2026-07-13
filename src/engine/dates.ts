/**
 * Date-value semantics for DATE-FORMAT, ported from the Python reference's
 * `is_iso_date_value` / `suggest_iso_fix` / `_date_fields_to_check`.
 *
 * No calendar validation is performed (a string like `2026-13-40` still
 * matches) — the Python engine doesn't validate calendar correctness either,
 * it only checks shape.
 */

import type { BaseSchema, Manifest } from "./types";
import type { Frontmatter } from "./shared";

/** `YYYY-MM-DD` optionally followed by `T`/`t` `HH:mm[:ss[.f]][Z|±hh:mm[:mm]]`. */
export const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}([Tt]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** The classic Linter "space instead of T" shape: `YYYY-MM-DD HH:mm[:ss]`. */
export const SPACE_DATETIME_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(:\d{2})?)$/;

/**
 * True for a JS `Date` instance (parity with Python accepting YAML-parsed
 * date/datetime objects) or a string matching `ISO_DATE_RE` after trimming.
 */
export function isIsoDateValue(value: unknown): boolean {
  if (value instanceof Date) return true;
  if (typeof value === "string") return ISO_DATE_RE.test(value.trim());
  return false;
}

/**
 * Port of `parse_date_value`: best-effort date extraction for staleness
 * comparisons. Accepts a JS Date or an ISO date/datetime string; returns the
 * DATE part as UTC-midnight epoch millis, or null for anything unusable
 * (staleness rules quietly skip when they can't parse a comparable date).
 */
export function parseDateValueMs(value: unknown): number | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!ISO_DATE_RE.test(text)) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Date.UTC(year, month - 1, day);
}

/** Deterministic fix for the "space instead of T" shape; null when inapplicable. */
export function suggestIsoFix(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = SPACE_DATETIME_RE.exec(value.trim());
  if (!match) return null;
  return `${match[1]}T${match[2]}`;
}

/**
 * Port of `_date_fields_to_check`: every frontmatter key ending with a
 * configured date-name suffix (except `presence_only` names), plus manifest
 * fields typed `date`/`datetime` that are present in frontmatter. Returned
 * sorted, matching the Python engine's `sorted(...)` iteration order.
 */
export function dateFieldsToCheck(
  frontmatter: Frontmatter,
  base: BaseSchema,
  manifest: Manifest | undefined
): string[] {
  const fields = new Set<string>();
  const fmKeys = frontmatter && typeof frontmatter === "object" ? Object.keys(frontmatter) : [];
  const presenceOnly = base.presence_only ?? [];
  const suffixes = base.date_name_suffixes ?? [];
  for (const name of fmKeys) {
    if (presenceOnly.includes(name)) continue;
    if (suffixes.some((suffix) => name.endsWith(suffix))) fields.add(name);
  }
  if (manifest) {
    for (const [name, spec] of Object.entries(manifest.fields ?? {})) {
      const isDateType = spec.type === "date" || spec.type === "datetime";
      const isPresent =
        frontmatter !== null &&
        frontmatter !== undefined &&
        typeof frontmatter === "object" &&
        Object.prototype.hasOwnProperty.call(frontmatter, name);
      if (isDateType && isPresent) fields.add(name);
    }
  }
  return Array.from(fields).sort();
}
