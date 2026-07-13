import { describe, expect, it } from "vitest";
import { compareViolations } from "./helpers/compare";

describe("compareViolations", () => {
  it("matches when actual violations are in a different order than expected", () => {
    const expected = [{ rule: "A" }, { rule: "B" }];
    const actual = [{ rule: "B" }, { rule: "A" }];

    const result = compareViolations(expected, actual);

    expect(result.pass).toBe(true);
    expect(result.unmatchedExpected).toEqual([]);
    expect(result.unmatchedActual).toEqual([]);
  });

  it("fails when an expected violation has no matching actual violation", () => {
    const expected = [{ rule: "A" }, { rule: "B" }];
    const actual = [{ rule: "A" }];

    const result = compareViolations(expected, actual);

    expect(result.pass).toBe(false);
    expect(result.unmatchedExpected).toEqual([{ rule: "B" }]);
    expect(result.unmatchedActual).toEqual([]);
  });

  it("fails when there is an extra actual violation with no expectation", () => {
    const expected = [{ rule: "A" }];
    const actual = [{ rule: "A" }, { rule: "B" }];

    const result = compareViolations(expected, actual);

    expect(result.pass).toBe(false);
    expect(result.unmatchedExpected).toEqual([]);
    expect(result.unmatchedActual).toEqual([{ rule: "B" }]);
  });

  it("matches on a subset of keys, ignoring extra keys on the actual violation", () => {
    const expected = [{ rule: "A", field: "x" }];
    const actual = [
      { rule: "A", field: "x", found: "1", fix: "none", message: "irrelevant" },
    ];

    const result = compareViolations(expected, actual);

    expect(result.pass).toBe(true);
  });

  it("fails a subset match when an asserted key differs", () => {
    const expected = [{ rule: "A", field: "x" }];
    const actual = [{ rule: "A", field: "y" }];

    const result = compareViolations(expected, actual);

    expect(result.pass).toBe(false);
    expect(result.unmatchedExpected).toEqual([{ rule: "A", field: "x" }]);
    expect(result.unmatchedActual).toEqual([{ rule: "A", field: "y" }]);
  });

  it("requires a duplicate expectation for each duplicate actual violation", () => {
    const expected = [{ rule: "A" }];
    const actual = [{ rule: "A" }, { rule: "A" }];

    const result = compareViolations(expected, actual);

    expect(result.pass).toBe(false);
    expect(result.unmatchedActual).toEqual([{ rule: "A" }]);
  });

  it("passes when duplicate identical violations are matched by duplicate expectations", () => {
    const expected = [{ rule: "A" }, { rule: "A" }];
    const actual = [{ rule: "A" }, { rule: "A" }];

    const result = compareViolations(expected, actual);

    expect(result.pass).toBe(true);
    expect(result.unmatchedExpected).toEqual([]);
    expect(result.unmatchedActual).toEqual([]);
  });

  it("treats an empty expectation list as asserting a clean note", () => {
    const result = compareViolations([], []);

    expect(result.pass).toBe(true);
  });

  it("resolves ambiguous overlapping matches via augmenting paths, not first-come order", () => {
    // expected[0] can match either actual[0] or actual[1]; expected[1] can only
    // match actual[0]. A naive greedy left-to-right scan that assigns
    // expected[0] to actual[0] first would incorrectly leave expected[1]
    // unmatched. Maximum bipartite matching must instead bump expected[0]
    // over to actual[1], freeing actual[0] for expected[1].
    const expected = [{ rule: "A" }, { rule: "A", field: "x" }];
    const actual = [{ rule: "A", field: "x" }, { rule: "A" }];

    const result = compareViolations(expected, actual);

    expect(result.pass).toBe(true);
    expect(result.unmatchedExpected).toEqual([]);
    expect(result.unmatchedActual).toEqual([]);
  });
});
