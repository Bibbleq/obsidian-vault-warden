/**
 * Core types for the Vault Warden rule engine.
 *
 * IMPORTANT: nothing in src/engine/ may import from "obsidian". The engine is a pure
 * function over plain data so it runs headless under vitest and stays contract-
 * compatible with external validators consuming the same fixture suite.
 */

/** Fix tier for a rule, declared per rule in base.yaml. */
export type FixTier = "auto" | "confirm" | "none";

/** Stable rule identifiers. */
export const RULE_IDS = [
  "CLASS-FIELD-MISSING",
  "CLASS-FIELD-TYPE",
  "DATE-FORMAT",
  "TAG-CASE",
  "TAG-RETIRED",
  "FM-AREA-INVALID",
  "CLASS-UNDECLARED",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

/** Per-rule configuration as parsed from base.yaml's `rules:` map. */
export interface RuleConfig {
  fix: FixTier;
  /** DATE-FORMAT: accepted patterns using YYYY MM DD HH mm ss tokens. */
  formats?: string[];
  /** TAG-CASE: case style; only "pascal" is currently supported. */
  style?: string;
  /** TAG-RETIRED: exact tag -> replacement ("" or null = remove). */
  map?: Record<string, string | null>;
  /** FM-AREA-INVALID: frontmatter key to check. */
  field?: string;
  /** FM-AREA-INVALID: source list name (resolved via metadata_sources). */
  source?: string;
}

/** Parsed base.yaml. */
export interface BaseSchema {
  version?: number;
  metadata_sources?: string;
  class_key?: string; // default "class"
  ignore_key?: string; // default "validator_ignore"
  frontmatter_title?: string;
  class_locations?: Record<string, string>;
  creation_stamp?: Record<string, string>;
  rules?: Partial<Record<RuleId, RuleConfig>>;
  title_sync?: {
    strip?: string;
    replacement?: string;
    ignore?: string[];
  };
}

/** A single field declaration in a class manifest. */
export interface FieldSpec {
  /** "date" | "select:<Source>" | "list" | "wikilink" | "text" */
  type?: string;
  required?: boolean;
}

/** Parsed class manifest. */
export interface ClassManifest {
  class: string;
  fields?: Record<string, FieldSpec>;
}

/**
 * Everything the engine needs to validate one note. The Obsidian adapter builds this
 * from the vault; the test runner builds it from a JSON fixture.
 */
export interface ValidationInput {
  /** Parsed base.yaml. */
  config: BaseSchema;
  /** Class name -> manifest, for all loaded class manifests. */
  classes: Record<string, ClassManifest>;
  /** Source list name -> allowed values (pre-resolved line-list notes). */
  sources: Record<string, string[]>;
  /** The note under validation. */
  file: {
    /** Vault-relative path, e.g. "Projects/Recipes/Flapjack.md". */
    path: string;
    /** Parsed frontmatter as plain data (JSON-representable). */
    frontmatter: Record<string, unknown> | null;
  };
}

/** One rule violation. */
export interface Violation {
  rule: RuleId;
  /** Frontmatter key, or the offending tag for tag rules. */
  field?: string;
  /** Stringified offending value. */
  found?: string;
  /** Human-readable expectation. */
  expected?: string;
  /** Fix tier copied from the rule's config. */
  fix: FixTier;
  /** One-line human-readable description. */
  message: string;
}

/**
 * Signature of the engine entry point. Deterministic and side-effect free.
 * Violation order is not part of the contract; fixture comparison is
 * order-insensitive.
 */
export type Validate = (input: ValidationInput) => Violation[];
