import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFixToFrontmatter } from "../src/engine/fixops";
import type { SuggestedFix, Violation } from "../src/engine/types";

describe("applyFixToFrontmatter", () => {
  describe("set_field", () => {
    it("plainly sets a scalar field", () => {
      const fm: Record<string, unknown> = { area: "Wrong" };
      const fix: SuggestedFix = { op: "set_field", field: "area", value: "IT Pro" };

      const changed = applyFixToFrontmatter(fm, fix);

      expect(changed).toBe(true);
      expect(fm.area).toBe("IT Pro");
    });

    it("is a no-op when the value is already the same", () => {
      const fm: Record<string, unknown> = { area: "IT Pro" };
      const fix: SuggestedFix = { op: "set_field", field: "area", value: "IT Pro" };

      const changed = applyFixToFrontmatter(fm, fix);

      expect(changed).toBe(false);
      expect(fm.area).toBe("IT Pro");
    });

    it("replaces one bad date inside a list, preserving the other entries", () => {
      const fm: Record<string, unknown> = {
        dates: ["2026-01-01", "13/07/2026", "2026-03-01"],
      };
      const fix: SuggestedFix = {
        op: "set_field",
        field: "dates",
        value: "2026-07-13",
      };

      const changed = applyFixToFrontmatter(fm, fix, "13/07/2026");

      expect(changed).toBe(true);
      expect(fm.dates).toEqual(["2026-01-01", "2026-07-13", "2026-03-01"]);
    });

    it("falls through to a plain set when `found` matches no element of the list", () => {
      const fm: Record<string, unknown> = { dates: ["2026-01-01", "2026-03-01"] };
      const fix: SuggestedFix = {
        op: "set_field",
        field: "dates",
        value: "2026-07-13",
      };

      const changed = applyFixToFrontmatter(fm, fix, "not-in-the-list");

      expect(changed).toBe(true);
      expect(fm.dates).toBe("2026-07-13");
    });
  });

  describe("replace_tag", () => {
    it("replaces only matching entries in an array, preserving order", () => {
      const fm: Record<string, unknown> = {
        tags: ["Microsoft/Copilot", "old-tag", "3DPrinting/Klipper", "old-tag"],
      };
      const fix: SuggestedFix = {
        op: "replace_tag",
        field: "tags",
        found: "old-tag",
        value: "New/Tag",
      };

      const changed = applyFixToFrontmatter(fm, fix);

      expect(changed).toBe(true);
      expect(fm.tags).toEqual([
        "Microsoft/Copilot",
        "New/Tag",
        "3DPrinting/Klipper",
        "New/Tag",
      ]);
    });

    it("replaces a bare string tag", () => {
      const fm: Record<string, unknown> = { tags: "old-tag" };
      const fix: SuggestedFix = {
        op: "replace_tag",
        field: "tags",
        found: "old-tag",
        value: "New/Tag",
      };

      const changed = applyFixToFrontmatter(fm, fix);

      expect(changed).toBe(true);
      expect(fm.tags).toBe("New/Tag");
    });

    it("returns false and leaves fm untouched when there is no match", () => {
      const fm: Record<string, unknown> = { tags: ["Microsoft/Copilot"] };
      const fix: SuggestedFix = {
        op: "replace_tag",
        field: "tags",
        found: "old-tag",
        value: "New/Tag",
      };

      const changed = applyFixToFrontmatter(fm, fix);

      expect(changed).toBe(false);
      expect(fm.tags).toEqual(["Microsoft/Copilot"]);
    });
  });

  describe("remove_tag", () => {
    it("removes matching entries from an array", () => {
      const fm: Record<string, unknown> = {
        tags: ["Microsoft/Copilot", "retired-tag", "3DPrinting/Klipper"],
      };
      const fix: SuggestedFix = { op: "remove_tag", field: "tags", found: "retired-tag" };

      const changed = applyFixToFrontmatter(fm, fix);

      expect(changed).toBe(true);
      expect(fm.tags).toEqual(["Microsoft/Copilot", "3DPrinting/Klipper"]);
    });

    it("deletes the key entirely for a matching bare string", () => {
      const fm: Record<string, unknown> = { tags: "retired-tag" };
      const fix: SuggestedFix = { op: "remove_tag", field: "tags", found: "retired-tag" };

      const changed = applyFixToFrontmatter(fm, fix);

      expect(changed).toBe(true);
      expect("tags" in fm).toBe(false);
    });

    it("returns false when there is no match", () => {
      const fm: Record<string, unknown> = { tags: ["Microsoft/Copilot"] };
      const fix: SuggestedFix = { op: "remove_tag", field: "tags", found: "retired-tag" };

      const changed = applyFixToFrontmatter(fm, fix);

      expect(changed).toBe(false);
      expect(fm.tags).toEqual(["Microsoft/Copilot"]);
    });
  });

  describe("set_list", () => {
    it("replaces the whole list", () => {
      const fm: Record<string, unknown> = { tags: ["A", "B"] };
      const fix: SuggestedFix = { op: "set_list", field: "tags", value: ["A", "B", "C"] };

      const changed = applyFixToFrontmatter(fm, fix);

      expect(changed).toBe(true);
      expect(fm.tags).toEqual(["A", "B", "C"]);
    });

    it("is a no-op when the new list is deep-equal to the current one", () => {
      const fm: Record<string, unknown> = { tags: ["A", "B"] };
      const fix: SuggestedFix = { op: "set_list", field: "tags", value: ["A", "B"] };

      const changed = applyFixToFrontmatter(fm, fix);

      expect(changed).toBe(false);
      expect(fm.tags).toEqual(["A", "B"]);
    });
  });

  it("returns false for an unknown/unsupported op", () => {
    const fm: Record<string, unknown> = { body: "some text" };
    const fix = { op: "wrap_in_code", field: "body", value: "```\nsome text\n```" } as SuggestedFix;

    const changed = applyFixToFrontmatter(fm, fix);

    expect(changed).toBe(false);
    expect(fm.body).toBe("some text");
  });

  it("never throws on malformed input", () => {
    expect(() => applyFixToFrontmatter({}, { op: "set_field", field: "" } as SuggestedFix)).not.toThrow();
    expect(
      applyFixToFrontmatter({}, { op: "set_field", field: "" } as SuggestedFix)
    ).toBe(false);
    expect(
      applyFixToFrontmatter({ tags: 42 } as Record<string, unknown>, {
        op: "remove_tag",
        field: "tags",
        found: "x",
      })
    ).toBe(false);
    expect(
      applyFixToFrontmatter({}, { op: "replace_tag", field: "tags" } as SuggestedFix)
    ).toBe(false);
  });
});

describe("applyAllFixes", () => {
  function makeViolation(overrides: Partial<Violation>): Violation {
    return {
      rule: "TAG-RETIRED",
      field: null,
      found: null,
      expected: null,
      mechanical: true,
      suggested_fix: null,
      suppressed: false,
      ...overrides,
    };
  }

  it("applies a mixed batch: replace_tag + remove_tag on the same array, plus a set_field", () => {
    const fm: Record<string, unknown> = {
      tags: ["Microsoft/Copilot", "old-tag", "retired-tag"],
      area: "Wrong",
    };

    const violations: Violation[] = [
      makeViolation({
        rule: "TAG-CASE",
        field: "tags",
        found: "old-tag",
        suggested_fix: { op: "replace_tag", field: "tags", found: "old-tag", value: "New/Tag" },
      }),
      makeViolation({
        rule: "TAG-RETIRED",
        field: "tags",
        found: "retired-tag",
        suggested_fix: { op: "remove_tag", field: "tags", found: "retired-tag" },
      }),
      makeViolation({
        rule: "FM-AREA-INVALID",
        field: "area",
        found: "Wrong",
        suggested_fix: { op: "set_field", field: "area", value: "IT Pro" },
      }),
    ];

    const count = applyAllFixes(fm, violations);

    expect(count).toBe(3);
    expect(fm.tags).toEqual(["Microsoft/Copilot", "New/Tag"]);
    expect(fm.area).toBe("IT Pro");
  });

  it("skips suppressed, non-mechanical, and null-fix violations, returning only the changed count", () => {
    const fm: Record<string, unknown> = { area: "Wrong", origin: "Unknown" };

    const violations: Violation[] = [
      // Suppressed: has a fix, but must be skipped.
      makeViolation({
        field: "area",
        suppressed: true,
        suggested_fix: { op: "set_field", field: "area", value: "Should Not Apply" },
      }),
      // Non-mechanical: no suggested_fix is trustworthy even if present.
      makeViolation({
        field: "origin",
        mechanical: false,
        suggested_fix: { op: "set_field", field: "origin", value: "Should Not Apply" },
      }),
      // Mechanical but no fix at all.
      makeViolation({
        field: "notetype",
        mechanical: true,
        suggested_fix: null,
      }),
      // The only one that should actually land.
      makeViolation({
        field: "area",
        found: "Wrong",
        suggested_fix: { op: "set_field", field: "area", value: "IT Pro" },
      }),
    ];

    const count = applyAllFixes(fm, violations);

    expect(count).toBe(1);
    expect(fm.area).toBe("IT Pro");
    expect(fm.origin).toBe("Unknown");
  });

  it("returns 0 for an empty violation list", () => {
    const fm: Record<string, unknown> = { area: "IT Pro" };

    const count = applyAllFixes(fm, []);

    expect(count).toBe(0);
    expect(fm.area).toBe("IT Pro");
  });
});
