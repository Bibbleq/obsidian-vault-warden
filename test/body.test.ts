import { describe, expect, it } from "vitest";
import { isBodyEmpty, renderScaffold, setFirstH1, splitFrontmatter } from "../src/body";

const FM = "---\nclass: Recipe\n---\n";

describe("splitFrontmatter", () => {
  it("splits a frontmatter block from the body", () => {
    const { frontmatter, body } = splitFrontmatter(FM + "# Title\ntext");
    expect(frontmatter).toBe(FM);
    expect(body).toBe("# Title\ntext");
  });
  it("no frontmatter -> whole content is body", () => {
    expect(splitFrontmatter("# Title").frontmatter).toBe("");
    expect(splitFrontmatter("# Title").body).toBe("# Title");
  });
  it("unterminated frontmatter treated as body", () => {
    expect(splitFrontmatter("---\nkey: 1\n# T").frontmatter).toBe("");
  });
});

describe("isBodyEmpty", () => {
  it("frontmatter-only note is empty", () => {
    expect(isBodyEmpty(FM)).toBe(true);
    expect(isBodyEmpty(FM + "\n  \n")).toBe(true);
  });
  it("any body content is not empty", () => {
    expect(isBodyEmpty(FM + "# X")).toBe(false);
    expect(isBodyEmpty("plain text")).toBe(false);
  });
  it("empty string is empty", () => {
    expect(isBodyEmpty("")).toBe(true);
  });
});

describe("renderScaffold", () => {
  it("strips template frontmatter and substitutes tokens", () => {
    const template = FM + "# {{title}}\n\nCreated {{date}}\n\n## Notes\n";
    expect(renderScaffold(template, "My Note", "2026-07-13")).toBe(
      "# My Note\n\nCreated 2026-07-13\n\n## Notes\n"
    );
  });
  it("substitutes repeated tokens", () => {
    expect(renderScaffold("{{title}} / {{title}}", "A", "d")).toBe("A / A");
  });
  it("trims leading blank lines left by the frontmatter strip", () => {
    expect(renderScaffold(FM + "\n\n# {{title}}", "A", "d")).toBe("# A");
  });
});

describe("setFirstH1", () => {
  it("replaces the first H1", () => {
    expect(setFirstH1(FM + "# Old\ntext", "New")).toBe(FM + "# New\ntext");
  });
  it("inserts after frontmatter when no H1 exists", () => {
    expect(setFirstH1(FM + "text", "New")).toBe(FM + "\n# New\n\ntext");
  });
  it("ignores headings inside code fences", () => {
    const content = FM + "```\n# not a heading\n```\n# Real\n";
    expect(setFirstH1(content, "New")).toBe(FM + "```\n# not a heading\n```\n# New\n");
  });
  it("no-ops when the H1 already matches", () => {
    const content = FM + "# Same\n";
    expect(setFirstH1(content, "Same")).toBe(content);
  });
});
