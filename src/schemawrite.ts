/**
 * Comment-preserving YAML mutation module.
 *
 * The vault's schema manifests (`_vault/Classes/*.yaml` and friends) are
 * hand-written and full of comments explaining *why* a rule exists. Loading
 * them with `JSON.parse`-style YAML parsing and re-serializing would throw
 * every comment and much of the original formatting away. This module uses
 * the `yaml` package's CST-backed `Document` API instead, which keeps a
 * live link between the parsed tree and the original source text, so edits
 * touch only the node(s) that actually changed.
 *
 * Every export here is a pure text -> text transform: parse, mutate the
 * `Document`, re-stringify. Nothing here imports "obsidian" or any Node
 * built-in, so this module stays headless and can be unit tested directly
 * under vitest (see test/schemawrite.test.ts) without any Obsidian shims.
 *
 * Defensive throughout: malformed YAML input, or a path that doesn't
 * resolve the way the caller hoped, never throws. Callers are expected to
 * validate/parse-check files themselves (e.g. surfacing YAML syntax errors
 * to the user) before handing text to these functions; here, "can't apply
 * this edit" just means "return the input unchanged."
 *
 * Known limitation (inherent to the `yaml` library, not fixable from
 * here): flow-collection spacing is normalized on any document that goes
 * through a `Document` round-trip, even for `{a: 1}`/`[a, b]` spans that
 * were never touched by the edit. `{type: date, required: true}` becomes
 * `{ type: date, required: true }` (padded) after *any* setIn/deleteIn/etc.
 * call on the document, purely because `yaml`'s stringifier re-renders
 * flow collections from scratch rather than preserving their original
 * source spacing. Block-style structure, key order, and every comment
 * (header comments, inline trailing comments, comments-before-a-key) are
 * preserved exactly.
 */

import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { Document, Pair, Scalar } from "yaml";

type Path = (string | number)[];

/** Parses `text`, returning `null` if the parse failed or produced errors. */
function tryParse(text: string): Document.Parsed | null {
  try {
    const doc = parseDocument(text);
    if (doc.errors && doc.errors.length > 0) return null;
    return doc;
  } catch {
    return null;
  }
}

/** Stringifies `doc`, returning `fallback` if stringification fails for any reason. */
function tryStringify(doc: Document.Parsed, fallback: string): string {
  try {
    return String(doc);
  } catch {
    return fallback;
  }
}

function keyString(key: unknown): string {
  if (isScalar(key)) return String((key as Scalar).value);
  return String(key);
}

/** Deep structural equality over plain JSON-shaped values (objects/arrays/scalars). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object") return false;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bObj, k) && deepEqual(aObj[k], bObj[k]));
}

/** Converts a (possibly still-a-Node) seq item to a plain JS value for comparison. */
function toComparable(item: unknown): unknown {
  if (item && typeof (item as { toJSON?: unknown }).toJSON === "function") {
    return (item as { toJSON: () => unknown }).toJSON();
  }
  return item;
}

/**
 * Set a value at a path, creating intermediate maps as needed.
 *
 * Values are handed to `doc.createNode` before being written in, so plain
 * objects/arrays become proper YAML maps/sequences (block-style, matching
 * how the rest of the document is written) rather than raw JS values that
 * only happen to stringify correctly.
 *
 * If an existing node blocks part of the path (e.g. `path` continues past
 * a scalar that already has a value), the edit is treated as a conflict,
 * not something to force through by clobbering the existing node's
 * comments/data — the input is returned unchanged.
 */
export function setPath(text: string, path: Path, value: unknown): string {
  const doc = tryParse(text);
  if (!doc) return text;

  try {
    const node = doc.createNode(value);
    if (path.length === 0) {
      doc.contents = node as Document.Parsed["contents"];
    } else {
      doc.setIn(path, node);
    }
    return tryStringify(doc, text);
  } catch {
    return text;
  }
}

/**
 * Delete the node at a path. No-op (returns `text` unchanged) if the path
 * doesn't fully resolve to an existing node — including when an
 * intermediate segment is missing or isn't a collection, which the
 * underlying library would otherwise throw on.
 */
export function deletePath(text: string, path: Path): string {
  const doc = tryParse(text);
  if (!doc) return text;

  try {
    if (!doc.hasIn(path)) return text;
    const deleted = doc.deleteIn(path);
    if (!deleted) return text;
    return tryStringify(doc, text);
  } catch {
    return text;
  }
}

/**
 * Append a value to the sequence at path, creating the sequence (and any
 * missing intermediate maps) if absent. If the node at `path` exists but
 * isn't a sequence, it is replaced with a fresh single-item sequence
 * containing `value` (this case isn't expected to occur against
 * well-formed schema manifests, but is handled without throwing).
 */
export function appendToSeq(text: string, path: Path, value: unknown): string {
  const doc = tryParse(text);
  if (!doc) return text;

  try {
    const existing = path.length === 0 ? doc.contents : doc.getIn(path, true);
    if (isSeq(existing)) {
      existing.add(doc.createNode(value));
    } else {
      doc.setIn(path, doc.createNode([value]));
    }
    return tryStringify(doc, text);
  } catch {
    return text;
  }
}

/**
 * Remove all entries strictly/deep-equal to `value` from the sequence at
 * path. No-op if the path is absent or doesn't resolve to a sequence, and
 * no-op (returns `text` unchanged, not just an equivalent re-stringify) if
 * nothing in the sequence actually matches `value` — so a "no match"
 * result never introduces incidental formatting churn elsewhere in the
 * file.
 */
export function removeFromSeq(text: string, path: Path, value: unknown): string {
  const doc = tryParse(text);
  if (!doc) return text;

  try {
    if (!doc.hasIn(path)) return text;
    const seq = doc.getIn(path, true);
    if (!isSeq(seq)) return text;

    const kept = seq.items.filter((item) => !deepEqual(toComparable(item), value));
    if (kept.length === seq.items.length) return text;

    seq.items = kept;
    return tryStringify(doc, text);
  } catch {
    return text;
  }
}

/**
 * Rename a map key at path, preserving its value and any comments attached
 * to the pair, and keeping the pair's position in the map's key order.
 *
 * Operates on the map's `items` array directly: finds the `Pair` whose key
 * stringifies to `oldKey` and updates it in place (mutating the existing
 * `Scalar`'s `.value` when the key is a plain scalar, which is the safest
 * way to preserve any comment/anchor/style metadata attached to that exact
 * node) rather than removing and re-inserting the pair, which would risk
 * losing its position or comments.
 */
export function renameKey(text: string, path: Path, oldKey: string, newKey: string): string {
  const doc = tryParse(text);
  if (!doc) return text;

  try {
    const target = path.length === 0 ? doc.contents : doc.getIn(path, true);
    if (!isMap(target)) return text;

    const pair = (target.items as Pair[]).find((p) => keyString(p.key) === oldKey);
    if (!pair) return text;

    if (isScalar(pair.key)) {
      (pair.key as Scalar).value = newKey;
    } else {
      pair.key = doc.createNode(newKey);
    }

    return tryStringify(doc, text);
  } catch {
    return text;
  }
}
