import { describe, expect, it } from "vitest";
import { analyzeTitle, isIgnoredPath, sanitiseTitle } from "../src/engine/titlesync";
import type { TitleInput } from "../src/engine/titlesync";
import type { TitleSyncConfig } from "../src/engine/types";

/** Default title_sync config, matching the shape a real Vault.yaml would produce. */
function makeConfig(overrides: Partial<TitleSyncConfig> = {}): TitleSyncConfig {
  return {
    strip: "\\/:*?\"<>|#^[]",
    replacement: "",
    remap: { "’": "'", "–": "-", "…": "..." },
    ignore: ["(^|/)[_.]"],
    frontmatter_title: "",
    add_old_alias: true,
    ...overrides,
  };
}

function makeInput(overrides: Partial<TitleInput> = {}): TitleInput {
  return {
    path: "Notes/Real.md",
    basename: "Real",
    h1: "Real",
    frontmatter: null,
    config: makeConfig(),
    ...overrides,
  };
}

describe("sanitiseTitle", () => {
  it("removes every character in the strip set", () => {
    const config = makeConfig();
    expect(sanitiseTitle('A\\/:*?"<>|#^[]B', config)).toBe("AB");
  });

  it("applies remap before stripping (a remapped char can land in the strip set)", () => {
    const config = makeConfig({ remap: { x: ":" }, strip: ":", replacement: "" });
    expect(sanitiseTitle("x", config)).toBe("");
    expect(sanitiseTitle("Axb", config)).toBe("Ab");
  });

  it("supports a multi-character remap value (ellipsis -> three dots)", () => {
    const config = makeConfig();
    expect(sanitiseTitle("Wait… what", config)).toBe("Wait... what");
  });

  it("collapses whitespace runs to a single space and trims", () => {
    const config = makeConfig();
    expect(sanitiseTitle("  A    B  ", config)).toBe("A B");
  });

  it("strips trailing dots (Windows can't end a filename in a dot), then trims again", () => {
    const config = makeConfig();
    expect(sanitiseTitle("My Title...", config)).toBe("My Title");
    expect(sanitiseTitle("Note . ", config)).toBe("Note");
  });

  it("replacement '' removes stripped chars; replacement '-' substitutes them", () => {
    const removeConfig = makeConfig({ strip: ":", replacement: "" });
    const dashConfig = makeConfig({ strip: ":", replacement: "-" });
    expect(sanitiseTitle("A:B", removeConfig)).toBe("AB");
    expect(sanitiseTitle("A:B", dashConfig)).toBe("A-B");
  });

  it("never throws on malformed title or config input", () => {
    const config = makeConfig();
    expect(() => sanitiseTitle(null as unknown as string, config)).not.toThrow();
    expect(sanitiseTitle(null as unknown as string, config)).toBe("");
    expect(sanitiseTitle(undefined as unknown as string, config)).toBe("");

    expect(() => sanitiseTitle("Some Title", {} as TitleSyncConfig)).not.toThrow();
    expect(sanitiseTitle("Some Title", {} as TitleSyncConfig)).toBe("Some Title");
    expect(() => sanitiseTitle("Some Title", null as unknown as TitleSyncConfig)).not.toThrow();
    expect(sanitiseTitle("Some Title", null as unknown as TitleSyncConfig)).toBe("Some Title");
  });
});

describe("isIgnoredPath", () => {
  it("ignores paths under an underscore-prefixed folder", () => {
    const config = makeConfig();
    expect(isIgnoredPath("_vault/Templates/X.md", config)).toBe(true);
  });

  it("ignores a dot/underscore-prefixed filename anywhere in the path", () => {
    const config = makeConfig();
    expect(isIgnoredPath("Notes/_draft.md", config)).toBe(true);
  });

  it("does not ignore an ordinary path", () => {
    const config = makeConfig();
    expect(isIgnoredPath("Notes/Real.md", config)).toBe(false);
  });

  it("skips an invalid regex pattern without throwing, still matching valid ones", () => {
    const config = makeConfig({ ignore: ["(unterminated[", "(^|/)[_.]"] });
    expect(() => isIgnoredPath("_vault/Templates/X.md", config)).not.toThrow();
    expect(isIgnoredPath("_vault/Templates/X.md", config)).toBe(true);
    expect(isIgnoredPath("Notes/Real.md", config)).toBe(false);
  });

  it("never throws on malformed config", () => {
    expect(() => isIgnoredPath("Notes/Real.md", {} as TitleSyncConfig)).not.toThrow();
    expect(isIgnoredPath("Notes/Real.md", {} as TitleSyncConfig)).toBe(false);
    expect(isIgnoredPath("Notes/Real.md", null as unknown as TitleSyncConfig)).toBe(false);
  });
});

describe("analyzeTitle", () => {
  it("returns [] for an ignored path, even with no H1 at all", () => {
    const input = makeInput({ path: "_vault/Templates/X.md", basename: "X", h1: null });
    expect(analyzeTitle(input)).toEqual([]);
  });

  it("H1-MISSING when the note has no H1", () => {
    const input = makeInput({ basename: "My Note", h1: null });
    const violations = analyzeTitle(input);
    expect(violations).toEqual([
      {
        rule: "H1-MISSING",
        field: "h1",
        found: null,
        expected: "My Note",
        mechanical: true,
        suggested_fix: { op: "set_h1", field: "h1", value: "My Note" },
        suppressed: false,
      },
    ]);
  });

  it("H1-DEGENERATE when the H1 is entirely made of strip-set characters", () => {
    const input = makeInput({ basename: "My Note", h1: "###" });
    const violations = analyzeTitle(input);
    expect(violations).toEqual([
      {
        rule: "H1-DEGENERATE",
        field: "h1",
        found: "###",
        expected: "My Note",
        mechanical: true,
        suggested_fix: { op: "set_h1", field: "h1", value: "My Note" },
        suppressed: false,
      },
    ]);
  });

  it("H1-DEGENERATE when the H1 is whitespace-only", () => {
    const input = makeInput({ basename: "My Note", h1: "   " });
    const violations = analyzeTitle(input);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: "H1-DEGENERATE", found: "   ", expected: "My Note" });
  });

  it("is clean when the H1's sanitised projection equals the filename, even with strip characters", () => {
    const input = makeInput({ basename: "Warden Design Spec", h1: "Warden: Design Spec?" });
    expect(analyzeTitle(input)).toEqual([]);
  });

  it("H1-WHITESPACE repairs a leading/trailing-space-only H1 without renaming", () => {
    const input = makeInput({ basename: "My Note", h1: "  My Note  " });
    const violations = analyzeTitle(input);
    expect(violations).toEqual([
      {
        rule: "H1-WHITESPACE",
        field: "h1",
        found: "  My Note  ",
        expected: "My Note",
        mechanical: true,
        suggested_fix: { op: "set_h1", field: "h1", value: "My Note" },
        suppressed: false,
      },
    ]);
  });

  it("H1-WHITESPACE repairs a doubled internal space without triggering a rename", () => {
    const input = makeInput({ basename: "My Note", h1: "My  Note" });
    const violations = analyzeTitle(input);
    expect(violations).toEqual([
      {
        rule: "H1-WHITESPACE",
        field: "h1",
        found: "My  Note",
        expected: "My Note",
        mechanical: true,
        suggested_fix: { op: "set_h1", field: "h1", value: "My Note" },
        suppressed: false,
      },
    ]);
  });

  it("FILENAME-SYNC when the H1 has genuinely changed", () => {
    const input = makeInput({ basename: "Old Title", h1: "New Title" });
    const violations = analyzeTitle(input);
    expect(violations).toEqual([
      {
        rule: "FILENAME-SYNC",
        field: "filename",
        found: "Old Title",
        expected: "New Title",
        mechanical: true,
        suggested_fix: { op: "rename_file", field: "filename", value: "New Title" },
        suppressed: false,
      },
    ]);
  });

  it("FILENAME-SYNC when the H1's projection (after stripping) differs from the filename", () => {
    const input = makeInput({ basename: "Old Name", h1: "Design: Notes?" });
    const violations = analyzeTitle(input);
    expect(violations).toEqual([
      {
        rule: "FILENAME-SYNC",
        field: "filename",
        found: "Old Name",
        expected: "Design Notes",
        mechanical: true,
        suggested_fix: { op: "rename_file", field: "filename", value: "Design Notes" },
        suppressed: false,
      },
    ]);
  });

  it("never renames when the candidate and basename differ only by whitespace", () => {
    const input = makeInput({ basename: "My Note", h1: "MyNote" });
    expect(analyzeTitle(input)).toEqual([]);
  });

  it("ignores the whole note (config.ignore) before ever inspecting the H1/filename relationship", () => {
    const input = makeInput({ path: "Notes/_draft.md", basename: "Old Name", h1: "Totally Different" });
    expect(analyzeTitle(input)).toEqual([]);
  });

  describe("TITLE-PROPERTY", () => {
    it("fires alone when the filename is already in sync but the frontmatter title differs", () => {
      const input = makeInput({
        basename: "Design Notes",
        h1: "Design Notes",
        frontmatter: { title: "Old Title" },
        config: makeConfig({ frontmatter_title: "title" }),
      });
      const violations = analyzeTitle(input);
      expect(violations).toEqual([
        {
          rule: "TITLE-PROPERTY",
          field: "title",
          found: "Old Title",
          expected: "Design Notes",
          mechanical: true,
          suggested_fix: { op: "set_field", field: "title", value: "Design Notes" },
          suppressed: false,
        },
      ]);
    });

    it("uses the raw H1 (strip characters kept) as found/expected, even when the filename is clean", () => {
      const input = makeInput({
        basename: "Design Notes",
        h1: "Design: Notes",
        frontmatter: { title: "Something Else" },
        config: makeConfig({ frontmatter_title: "title" }),
      });
      const violations = analyzeTitle(input);
      // The filename side is clean (sanitiseTitle("Design: Notes") === "Design Notes"),
      // so only TITLE-PROPERTY should fire, and it must carry the *raw* H1.
      expect(violations).toEqual([
        {
          rule: "TITLE-PROPERTY",
          field: "title",
          found: "Something Else",
          expected: "Design: Notes",
          mechanical: true,
          suggested_fix: { op: "set_field", field: "title", value: "Design: Notes" },
          suppressed: false,
        },
      ]);
    });

    it("does not fire when the frontmatter title already equals the raw H1", () => {
      const input = makeInput({
        basename: "Design Notes",
        h1: "Design Notes",
        frontmatter: { title: "Design Notes" },
        config: makeConfig({ frontmatter_title: "title" }),
      });
      expect(analyzeTitle(input)).toEqual([]);
    });

    it("never fires when frontmatter_title is empty (disabled), regardless of mismatch", () => {
      const input = makeInput({
        basename: "Design Notes",
        h1: "Design Notes",
        frontmatter: { title: "Something Totally Different" },
        config: makeConfig({ frontmatter_title: "" }),
      });
      expect(analyzeTitle(input)).toEqual([]);
    });

    it("fires alongside FILENAME-SYNC when both the filename and the title property are out of sync", () => {
      const input = makeInput({
        basename: "Old Title",
        h1: "New Title",
        frontmatter: { title: "Something" },
        config: makeConfig({ frontmatter_title: "title" }),
      });
      const violations = analyzeTitle(input);
      const rules = violations.map((v) => v.rule).sort();
      expect(rules).toEqual(["FILENAME-SYNC", "TITLE-PROPERTY"]);
    });

    it("treats an absent/null frontmatter as found: null when the property is missing", () => {
      const input = makeInput({
        basename: "Design Notes",
        h1: "Design Notes",
        frontmatter: null,
        config: makeConfig({ frontmatter_title: "title" }),
      });
      const violations = analyzeTitle(input);
      expect(violations).toEqual([
        {
          rule: "TITLE-PROPERTY",
          field: "title",
          found: null,
          expected: "Design Notes",
          mechanical: true,
          suggested_fix: { op: "set_field", field: "title", value: "Design Notes" },
          suppressed: false,
        },
      ]);
    });

    it("does not fire when H1-DEGENERATE already fired, even if the frontmatter title differs", () => {
      const input = makeInput({
        basename: "Whatever",
        h1: "###",
        frontmatter: { title: "Something Different" },
        config: makeConfig({ frontmatter_title: "title" }),
      });
      const violations = analyzeTitle(input);
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe("H1-DEGENERATE");
    });
  });

  it("skips an invalid ignore regex without throwing, and still evaluates the note", () => {
    const input = makeInput({
      basename: "Old Title",
      h1: "New Title",
      config: makeConfig({ ignore: ["(unterminated["] }),
    });
    expect(() => analyzeTitle(input)).not.toThrow();
    const violations = analyzeTitle(input);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("FILENAME-SYNC");
  });

  it("never throws on a malformed config (missing members)", () => {
    const input = makeInput({
      basename: "My Note",
      h1: "My Note",
      config: {} as TitleSyncConfig,
    });
    expect(() => analyzeTitle(input)).not.toThrow();
    expect(analyzeTitle(input)).toEqual([]);
  });
});
