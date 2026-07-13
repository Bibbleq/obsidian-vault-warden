/**
 * Multiset, subset-match comparator for conformance fixture violations.
 *
 * Semantics (see docs/FIXTURES.md "Comparison semantics"):
 * - Order-insensitive: expected/actual are compared as multisets.
 * - Subset match per violation: an expected violation only lists the keys it
 *   asserts (e.g. `rule`, `field`, sometimes `expected`/`found`/`mechanical`/
 *   `suppressed`/`suggested_fix`). An actual violation matches it if every
 *   asserted key is deeply equal (not just `===`) — `suggested_fix` is an
 *   object (and its `value` can itself be an array, e.g. a deduped tags
 *   list), so structural equality is required, not reference equality.
 *   Extra keys on the actual violation are never compared.
 * - Exact count: every expected violation must consume a distinct actual
 *   violation, and no actual violation may be left over. Duplicate identical
 *   expected violations require duplicate actual violations, and vice versa.
 *
 * Implemented as maximum bipartite matching (Kuhn's algorithm) rather than a
 * greedy left-to-right scan, so cases where an expectation could match more
 * than one actual violation are resolved correctly regardless of input order.
 */

export type Loose = Record<string, unknown>;

export interface CompareResult {
  pass: boolean;
  /** Expected violations that could not be matched to a distinct actual violation. */
  unmatchedExpected: Loose[];
  /** Actual violations that no expected violation claimed. */
  unmatchedActual: Loose[];
}

/** Structural equality for JSON-shaped values (primitives, arrays, plain objects). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
}

function isSubsetMatch(expected: Loose, actual: Loose): boolean {
  return Object.entries(expected).every(([key, value]) => deepEqual(actual[key], value));
}

export function compareViolations(expected: Loose[], actual: Loose[]): CompareResult {
  const n = expected.length;
  const m = actual.length;

  // adjacency[i] = indexes into `actual` that expected[i] is allowed to match
  const adjacency: number[][] = expected.map((exp) =>
    actual.map((_, j) => j).filter((j) => isSubsetMatch(exp, actual[j]))
  );

  // matchOfActual[j] = index into `expected` currently assigned to actual[j], or null
  const matchOfActual: Array<number | null> = new Array(m).fill(null);

  function tryAssign(i: number, visited: boolean[]): boolean {
    for (const j of adjacency[i]) {
      if (visited[j]) continue;
      visited[j] = true;
      const incumbent = matchOfActual[j];
      if (incumbent === null || tryAssign(incumbent, visited)) {
        matchOfActual[j] = i;
        return true;
      }
    }
    return false;
  }

  for (let i = 0; i < n; i++) {
    tryAssign(i, new Array(m).fill(false));
  }

  const expectedMatched: boolean[] = new Array(n).fill(false);
  for (const i of matchOfActual) {
    if (i !== null) expectedMatched[i] = true;
  }

  const unmatchedExpected = expected.filter((_, i) => !expectedMatched[i]);
  const unmatchedActual = actual.filter((_, j) => matchOfActual[j] === null);

  return {
    pass: unmatchedExpected.length === 0 && unmatchedActual.length === 0,
    unmatchedExpected,
    unmatchedActual,
  };
}
