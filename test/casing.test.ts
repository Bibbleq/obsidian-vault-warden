import { describe, expect, it } from "vitest";
import { validate } from "../src/engine/validate";
import type { ValidationInput } from "../src/engine/types";

const BASE = {
  version: 2,
  fields: {},
  tags: { max_depth: 2, retired: [] },
  date_name_suffixes: [],
  presence_only: [],
};

function run(tags: unknown, casings?: Record<string, string>): ValidationInput {
  return {
    base: BASE,
    manifests: {},
    file: { path: "Note.md", frontmatter: { tags, created: "2026-07-14" } },
    segment_casings: casings,
  };
}

describe("established-casing tag suggestions", () => {
  it("falls back to PascalCase with no casing map (parity default)", () => {
    const v = validate(run(["llm"])).find((x) => x.rule === "TAG-CASE");
    expect(v?.suggested_fix?.value).toBe("Llm");
  });

  it("adopts the vault's established segment casing when supplied", () => {
    const v = validate(run(["llm"], { llm: "LLM" })).find((x) => x.rule === "TAG-CASE");
    expect(v?.suggested_fix?.value).toBe("LLM");
  });

  it("applies established casing per segment, PascalCase for unknown segments", () => {
    const v = validate(run(["microsoft/llm"], { llm: "LLM" })).find(
      (x) => x.rule === "TAG-CASE"
    );
    expect(v?.suggested_fix?.value).toBe("Microsoft/LLM");
  });

  it("uses established casing in TAG-FORMAT fixes too", () => {
    const v = validate(run(["copilot studio"], { "copilot studio": "CopilotStudio" }));
    // A malformed (spaced) tag → TAG-FORMAT; the fix adopts the mapped casing.
    const fmt = v.find((x) => x.rule === "TAG-FORMAT");
    expect(fmt?.suggested_fix?.value).toBe("CopilotStudio");
  });
});
