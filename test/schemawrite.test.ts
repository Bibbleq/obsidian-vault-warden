import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import {
  appendToSeq,
  deletePath,
  removeFromSeq,
  renameKey,
  setPath,
} from "../src/schemawrite";

/**
 * Realistic fixture mimicking a hand-written vault schema manifest: a
 * multi-line header comment, a mix of block and flow map styles, an inline
 * trailing comment on a flow map field, and a comment attached to a seq key.
 */
const FIXTURE = `# Header comment explaining the file — v2 (2026-07-10, rule review)
#   - detailed rationale line
manifest_version: 2
class: MCCUGEvent
fields:
  event_date: {type: date, required: true}
  status:
    type: select
    required: true
    values: [Planning, Confirmed]
  series: {type: wikilink, required: true}        # File link -> UserGroup note
locations:
  - prefix: IT Pro/User Groups/MCCUG
    class: MCCUGEvent
  - prefix: Hobbies/Parts Storage
    class: StoragePart
tags:
  max_depth: 2
  # retired tags from the taxonomy note
  retired:
    - OldTag
`;

const HEADER_LINE_1 = "# Header comment explaining the file — v2 (2026-07-10, rule review)";
const HEADER_LINE_2 = "#   - detailed rationale line";
const INLINE_COMMENT = "# File link -> UserGroup note";
const RETIRED_COMMENT = "# retired tags from the taxonomy note";

/** Asserts all three well-known fixture comments are still present verbatim. */
function expectFixtureCommentsPreserved(output: string) {
  expect(output).toContain(HEADER_LINE_1);
  expect(output).toContain(HEADER_LINE_2);
  expect(output).toContain(INLINE_COMMENT);
  expect(output).toContain(RETIRED_COMMENT);
}

/** Parses `text` and fails the test with a useful message if it's not valid YAML. */
function assertRoundTripsCleanly(text: string): unknown {
  const doc = parseDocument(text);
  expect(doc.errors, `expected clean parse, got: ${doc.errors.map((e) => e.message).join("; ")}`).toHaveLength(0);
  return doc.toJS();
}

describe("setPath", () => {
  it("sets a scalar deep in the tree", () => {
    const out = setPath(FIXTURE, ["tags", "max_depth"], 3);

    const parsed = assertRoundTripsCleanly(out) as any;
    expect(parsed.tags.max_depth).toBe(3);
    expectFixtureCommentsPreserved(out);
  });

  it("creates a new nested map that didn't exist before", () => {
    const out = setPath(FIXTURE, ["title_sync", "strip"], ["Draft:", "TODO:"]);

    const parsed = assertRoundTripsCleanly(out) as any;
    expect(parsed.title_sync).toEqual({ strip: ["Draft:", "TODO:"] });
    expectFixtureCommentsPreserved(out);
  });

  it("works on empty text, creating the map from scratch", () => {
    const out = setPath("", ["a", "b"], 1);

    const parsed = assertRoundTripsCleanly(out) as any;
    expect(parsed).toEqual({ a: { b: 1 } });
  });

  it("works on whitespace-only text", () => {
    const out = setPath("   \n\n  ", ["a", "b"], 1);

    const parsed = assertRoundTripsCleanly(out) as any;
    expect(parsed).toEqual({ a: { b: 1 } });
  });

  it("replaces a flow-map field spec wholesale", () => {
    const out = setPath(FIXTURE, ["fields", "event_date"], { type: "date", required: false });

    const parsed = assertRoundTripsCleanly(out) as any;
    expect(parsed.fields.event_date).toEqual({ type: "date", required: false });
    // The other flow map (series) and its inline comment are untouched.
    expect(parsed.fields.series).toEqual({ type: "wikilink", required: true });
    expectFixtureCommentsPreserved(out);
  });
});

describe("deletePath", () => {
  it("deletes an existing node", () => {
    const out = deletePath(FIXTURE, ["tags", "retired"]);

    const parsed = assertRoundTripsCleanly(out) as any;
    expect(parsed.tags).toEqual({ max_depth: 2 });
    expect(out).toContain(HEADER_LINE_1);
    expect(out).toContain(HEADER_LINE_2);
    expect(out).toContain(INLINE_COMMENT);
  });

  it("is a no-op when an intermediate segment is missing", () => {
    const out = deletePath(FIXTURE, ["nope", "nothing"]);
    expect(out).toBe(FIXTURE);
  });

  it("is a no-op when the leaf key is missing", () => {
    const out = deletePath(FIXTURE, ["tags", "nonexistent"]);
    expect(out).toBe(FIXTURE);
  });

  it("is a no-op when the whole top-level key is missing", () => {
    const out = deletePath(FIXTURE, ["nonexistent"]);
    expect(out).toBe(FIXTURE);
  });
});

describe("appendToSeq", () => {
  it("appends to an existing sequence", () => {
    const out = appendToSeq(FIXTURE, ["fields", "status", "values"], "Cancelled");

    const parsed = assertRoundTripsCleanly(out) as any;
    expect(parsed.fields.status.values).toEqual(["Planning", "Confirmed", "Cancelled"]);
    expectFixtureCommentsPreserved(out);
  });

  it("appends to the retired tags list, keeping the comment above it", () => {
    const out = appendToSeq(FIXTURE, ["tags", "retired"], "AnotherOldTag");

    const parsed = assertRoundTripsCleanly(out) as any;
    expect(parsed.tags.retired).toEqual(["OldTag", "AnotherOldTag"]);
    expectFixtureCommentsPreserved(out);
  });

  it("creates the sequence (and intermediate maps) if absent", () => {
    const out = appendToSeq(FIXTURE, ["title_sync", "ignore"], "^_");

    const parsed = assertRoundTripsCleanly(out) as any;
    expect(parsed.title_sync).toEqual({ ignore: ["^_"] });
    expectFixtureCommentsPreserved(out);
  });
});

describe("removeFromSeq", () => {
  it("removes a matching scalar entry", () => {
    const out = removeFromSeq(FIXTURE, ["tags", "retired"], "OldTag");

    const parsed = assertRoundTripsCleanly(out) as any;
    expect(parsed.tags.retired).toEqual([]);
    expect(out).toContain(RETIRED_COMMENT);
    expectFixtureCommentsPreserved(out);
  });

  it("removes a matching map entry by deep equality", () => {
    const out = removeFromSeq(FIXTURE, ["locations"], {
      prefix: "IT Pro/User Groups/MCCUG",
      class: "MCCUGEvent",
    });

    const parsed = assertRoundTripsCleanly(out) as any;
    expect(parsed.locations).toEqual([{ prefix: "Hobbies/Parts Storage", class: "StoragePart" }]);
    expectFixtureCommentsPreserved(out);
  });

  it("is a no-op (byte-identical) when the path is missing", () => {
    const out = removeFromSeq(FIXTURE, ["nope", "nothing"], "x");
    expect(out).toBe(FIXTURE);
  });

  it("is a no-op (byte-identical) when the value doesn't match anything in the sequence", () => {
    const out = removeFromSeq(FIXTURE, ["tags", "retired"], "NotInTheList");
    expect(out).toBe(FIXTURE);
  });

  it("is a no-op when the path resolves to something that isn't a sequence", () => {
    const out = removeFromSeq(FIXTURE, ["tags"], "OldTag");
    expect(out).toBe(FIXTURE);
  });
});

describe("renameKey", () => {
  it("renames a key, preserving its inline comment and the map's key order", () => {
    const out = renameKey(FIXTURE, ["fields"], "series", "series_link");

    const parsed = assertRoundTripsCleanly(out) as any;
    expect(parsed.fields.series_link).toEqual({ type: "wikilink", required: true });
    expect(parsed.fields.series).toBeUndefined();
    expect(out).toContain(INLINE_COMMENT);

    // Key order in `fields` is unchanged: event_date, status, series_link.
    const doc = parseDocument(out);
    const fieldsMap = doc.getIn(["fields"], true) as any;
    const keys = fieldsMap.items.map((p: any) => String(p.key.value ?? p.key));
    expect(keys).toEqual(["event_date", "status", "series_link"]);

    expectFixtureCommentsPreserved(out);
  });

  it("renames a top-level key preserving the comment above the map it lives in", () => {
    const out = renameKey(FIXTURE, [], "tags", "taxonomy");

    const parsed = assertRoundTripsCleanly(out) as any;
    expect(parsed.taxonomy).toEqual({ max_depth: 2, retired: ["OldTag"] });
    expect(parsed.tags).toBeUndefined();
    expectFixtureCommentsPreserved(out);
  });

  it("is a no-op when the old key doesn't exist", () => {
    const out = renameKey(FIXTURE, ["fields"], "nonexistent", "whatever");
    expect(out).toBe(FIXTURE);
  });

  it("is a no-op when the path doesn't resolve to a map", () => {
    const out = renameKey(FIXTURE, ["tags", "retired"], "0", "x");
    expect(out).toBe(FIXTURE);
  });
});

describe("malformed input", () => {
  const MALFORMED = "a: [1, 2\nb: {c: }: }: bad";

  it("setPath returns the input unchanged", () => {
    expect(setPath(MALFORMED, ["a"], 1)).toBe(MALFORMED);
  });

  it("deletePath returns the input unchanged", () => {
    expect(deletePath(MALFORMED, ["a"])).toBe(MALFORMED);
  });

  it("appendToSeq returns the input unchanged", () => {
    expect(appendToSeq(MALFORMED, ["a"], 1)).toBe(MALFORMED);
  });

  it("removeFromSeq returns the input unchanged", () => {
    expect(removeFromSeq(MALFORMED, ["a"], 1)).toBe(MALFORMED);
  });

  it("renameKey returns the input unchanged", () => {
    expect(renameKey(MALFORMED, [], "a", "z")).toBe(MALFORMED);
  });
});

describe("round-trip safety", () => {
  it("every mutation's output re-parses without errors", () => {
    const outputs = [
      setPath(FIXTURE, ["tags", "max_depth"], 3),
      setPath(FIXTURE, ["title_sync", "strip"], ["Draft:"]),
      setPath("", ["a", "b"], 1),
      setPath(FIXTURE, ["fields", "event_date"], { type: "date", required: false }),
      deletePath(FIXTURE, ["tags", "retired"]),
      appendToSeq(FIXTURE, ["fields", "status", "values"], "Cancelled"),
      appendToSeq(FIXTURE, ["title_sync", "ignore"], "^_"),
      removeFromSeq(FIXTURE, ["tags", "retired"], "OldTag"),
      removeFromSeq(FIXTURE, ["locations"], {
        prefix: "IT Pro/User Groups/MCCUG",
        class: "MCCUGEvent",
      }),
      renameKey(FIXTURE, ["fields"], "series", "series_link"),
    ];

    for (const out of outputs) {
      const doc = parseDocument(out);
      expect(doc.errors).toHaveLength(0);
    }
  });
});
