/**
 * Core types for the Vault Warden rule engine.
 *
 * This contract mirrors the Bibble-style Python validator's post-load data
 * model (SchemaSet / Manifest / FieldSpec / Violation) so that both engines
 * can run the same conformance fixtures with identical results. The Python
 * engine is the reference implementation; where behaviour is ambiguous, match
 * it.
 *
 * IMPORTANT: nothing in src/engine/ may import from "obsidian". The engine is
 * a pure function over plain data so it runs headless under vitest.
 */

/** Stable rule identifiers — the write-time subset Warden implements. */
export const RULE_IDS = [
  "FM-AREA-MISSING",
  "FM-AREA-INVALID",
  "FM-NOTETYPE-MISSING",
  "FM-NOTETYPE-INVALID",
  "FM-ORIGIN-MISSING",
  "FM-ORIGIN-INVALID",
  "TAG-FORMAT",
  "TAG-CASE",
  "TAG-DEPTH",
  "TAG-RETIRED",
  "TAG-DUPLICATE",
  "DATE-FORMAT",
  "CREATED-MISSING",
  "CLASS-UNKNOWN",
  "CLASS-FIELD-MISSING",
  "CLASS-FIELD-TYPE",
  "CLASS-FIELD-VALUE",
  "CLASS-EXPECTED",
  "CLASS-MISFILED",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

/** Field type grammar (after `select:<Source>` / `multi:<Source>` resolution). */
export type FieldType =
  | "date"
  | "datetime"
  | "select"
  | "multi"
  | "list"
  | "wikilink"
  | "text"
  | "number"
  | "url";

/**
 * One field declaration, post-load: `select:<Source>` / `multi:<Source>`
 * types have already been split into `type` + `source`, with the source
 * note's line-list resolved into `values` (missing source note -> empty
 * `values`, which disables membership checking — fail open).
 */
export interface FieldSpec {
  name: string;
  type: FieldType;
  required?: boolean;
  /** Not required when this other frontmatter field is present (non-empty). */
  required_unless?: string | null;
  /** Required exactly when another field equals a value. */
  required_when?: { field: string; equals: string } | null;
  /** Closed value set; null/undefined/empty = open. */
  values?: string[] | null;
  /** Metadata Sources note the values came from (informational). */
  source?: string | null;
}

export interface TagRules {
  max_depth: number;
  retired: string[];
}

/** Parsed vault-wide schema (Vault.yaml), post-load. */
export interface BaseSchema {
  version: number;
  /** Base fields checked on every note: area / notetype / origin. */
  fields: Record<string, FieldSpec>;
  tags: TagRules;
  /** Field-name suffixes that get DATE-FORMAT checks even without a class. */
  date_name_suffixes: string[];
  /** Date fields exempt from DATE-FORMAT (presence handled elsewhere). */
  presence_only: string[];
}

/** One STATUS-STALE trigger. Parsed but unused by the write-time subset. */
export interface LifecycleRule {
  date_field: string;
  when_status: string[];
  suggest: string;
  age_days?: number | null;
}

/** Parsed class manifest, post-load. */
export interface Manifest {
  name: string;
  version: number;
  fields: Record<string, FieldSpec>;
  lifecycle?: LifecycleRule[];
}

/** One folder-prefix -> class mapping (class_locations.yaml). */
export interface ClassLocation {
  /** Vault-relative path prefix, usually with trailing "/". Longest match wins. */
  prefix: string;
  class: string;
}

/** One exceptions.yaml entry. Exactly one of path/pattern is set. */
export interface ExceptionRule {
  /** Exact vault-relative path match. */
  path?: string | null;
  /** fnmatch-style glob (case-sensitive; `*`, `?`, `[seq]`). */
  pattern?: string | null;
  /** null/absent = full skip (no violations at all); else suppress these rules. */
  rules?: string[] | null;
  reason?: string | null;
}

/**
 * Everything the engine needs to validate one note. The Obsidian adapter
 * builds this from the vault; the fixture runners build it from JSON.
 */
export interface ValidationInput {
  base: BaseSchema;
  /** Class name -> manifest. */
  manifests: Record<string, Manifest>;
  class_locations?: ClassLocation[];
  exceptions?: ExceptionRule[];
  file: {
    /** Vault-relative path, posix separators. */
    path: string;
    /** Parsed frontmatter as plain data; null when the note has none. */
    frontmatter: Record<string, unknown> | null;
  };
}

/** A concrete fix operation, matching the Python engine's suggested_fix dicts. */
export interface SuggestedFix {
  op: "set_field" | "replace_tag" | "remove_tag" | "set_list" | "wrap_in_code";
  field: string;
  found?: string;
  value?: unknown;
  hint?: string;
}

/**
 * One rule violation. Field names and semantics match the Python engine's
 * Violation dataclass (minus `path`, which is implicit — one note per call).
 */
export interface Violation {
  rule: RuleId;
  field?: string | null;
  /** Stringified offending value; null when the problem is absence. */
  found?: string | null;
  /** Human-readable expectation. */
  expected?: string | null;
  /** True when a deterministic fix exists (carried in suggested_fix). */
  mechanical: boolean;
  suggested_fix?: SuggestedFix | null;
  /** True when suppressed by validator_ignore or a rule-scoped exception. */
  suppressed: boolean;
}

/**
 * Engine entry point. Deterministic and side-effect free; never throws on
 * malformed input. A note fully skipped by exceptions returns [].
 * Violation order is not part of the contract (fixtures compare as multisets).
 */
export type Validate = (input: ValidationInput) => Violation[];
