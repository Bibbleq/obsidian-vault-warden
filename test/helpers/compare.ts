/**
 * Multiset, subset-match comparator for conformance fixture violations.
 *
 * Semantics (see docs/FIXTURES.md "Comparison semantics"):
 * - Order-insensitive: expected/actual are compared as multisets.
 * - Subset match per violation: an expected violation only lists the keys it
 *   asserts (e.g. `rule`, `field`, sometimes `expected`/`found`). An actual
 *   violation matches it if every asserted key is strictly equal (`===`).
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

function isSubsetMatch(expected: Loose, actual: Loose): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
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
