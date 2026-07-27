import { describe, expect, it } from "vitest";
import {
  buildStampScript,
  parseStamp,
  planCreationStamp,
} from "../src/fsstamp";

/** Local epoch millis, so expectations don't depend on the runner's timezone. */
function local(
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
  ms = 0
): number {
  return new Date(y, mo - 1, d, h, mi, s, ms).getTime();
}

describe("parseStamp", () => {
  it("reads a bare date as local midnight and flags it date-only", () => {
    expect(parseStamp("2026-06-29")).toEqual({ ms: local(2026, 6, 29), dateOnly: true });
  });

  it("reads a zone-less datetime as local wall-clock", () => {
    expect(parseStamp("2026-06-29T09:15")).toEqual({
      ms: local(2026, 6, 29, 9, 15),
      dateOnly: false,
    });
    expect(parseStamp("2026-06-29T09:15:30")).toEqual({
      ms: local(2026, 6, 29, 9, 15, 30),
      dateOnly: false,
    });
  });

  it("accepts the space separator and surrounding whitespace", () => {
    expect(parseStamp("  2026-06-29 09:15  ")?.ms).toBe(local(2026, 6, 29, 9, 15));
  });

  it("honours an explicit zone as an absolute instant", () => {
    expect(parseStamp("2026-06-29T09:15:00Z")?.ms).toBe(Date.UTC(2026, 5, 29, 9, 15));
    expect(parseStamp("2026-06-29T09:15:00+01:00")?.ms).toBe(Date.UTC(2026, 5, 29, 8, 15));
    // Offsets without the colon are still ISO-adjacent enough to appear in vaults.
    expect(parseStamp("2026-06-29T09:15:00+0100")?.ms).toBe(Date.UTC(2026, 5, 29, 8, 15));
  });

  it("takes a Date instance as-is", () => {
    const d = new Date(2026, 5, 29, 9, 15);
    expect(parseStamp(d)).toEqual({ ms: d.getTime(), dateOnly: false });
  });

  it("rejects impossible calendar dates rather than rolling them over", () => {
    // DATE-FORMAT only checks shape, but a bad stamp here would write a wrong
    // date to disk, so this parser validates.
    expect(parseStamp("2026-02-30")).toBeNull();
    expect(parseStamp("2026-13-01")).toBeNull();
    expect(parseStamp("2026-06-29T25:00")).toBeNull();
  });

  it("rejects non-date values", () => {
    for (const value of ["", "not a date", "29/06/2026", null, undefined, 42, {}, []]) {
      expect(parseStamp(value)).toBeNull();
    }
  });
});

describe("planCreationStamp", () => {
  it("returns null when created is absent or unusable", () => {
    expect(planCreationStamp(undefined, local(2026, 7, 14))).toBeNull();
    expect(planCreationStamp("nonsense", local(2026, 7, 14))).toBeNull();
  });

  it("targets the parsed value when the current stamp is unreadable", () => {
    expect(planCreationStamp("2026-06-29T09:00", null)).toEqual({
      targetMs: local(2026, 6, 29, 9, 0),
      inSync: false,
    });
  });

  it("matches a timed created value to the minute", () => {
    const created = "2026-06-29T09:00";
    // 30s of slop is the same minute — the plugin writes `created` at minute
    // precision, so anything finer would fight itself.
    expect(planCreationStamp(created, local(2026, 6, 29, 9, 0, 30))!.inSync).toBe(true);
    expect(planCreationStamp(created, local(2026, 6, 29, 9, 2))!.inSync).toBe(false);
    expect(planCreationStamp(created, local(2026, 6, 29, 9, 2))!.targetMs).toBe(
      local(2026, 6, 29, 9, 0)
    );
  });

  it("leaves a date-only match completely alone", () => {
    const plan = planCreationStamp("2026-06-29", local(2026, 6, 29, 16, 42, 7));
    expect(plan).toEqual({ targetMs: local(2026, 6, 29, 16, 42, 7), inSync: true });
  });

  it("corrects a date-only mismatch while preserving the time of day", () => {
    // Same-day notes keep their relative order instead of collapsing to midnight.
    const plan = planCreationStamp("2026-06-29", local(2026, 7, 14, 16, 42, 7));
    expect(plan).toEqual({ targetMs: local(2026, 6, 29, 16, 42, 7), inSync: false });
  });
});

describe("buildStampScript", () => {
  it("emits a single-line payload so the here-string cannot be broken out of", () => {
    const script = buildStampScript([
      { path: "C:/Vault/Note.md", ms: local(2026, 6, 29, 9, 0) },
    ]);
    const payloadLine = script.split("\n")[2];
    expect(payloadLine.startsWith("[")).toBe(true);
    expect(JSON.parse(payloadLine)).toEqual([
      { p: "C:/Vault/Note.md", t: local(2026, 6, 29, 9, 0) },
    ]);
  });

  it("keeps quote- and dollar-bearing filenames inert", () => {
    const nasty = `C:/Vault/it's $PROFILE \`x\`\n'@\nGet-Item.md`;
    const script = buildStampScript([{ path: nasty, ms: 0 }]);
    const lines = script.split("\n");
    const payloadLine = lines[2];
    // The whole payload stays on one line, so no line of it can start with the
    // here-string terminator.
    expect(JSON.parse(payloadLine)).toEqual([{ p: nasty, t: 0 }]);
    // Exactly one line opens with the terminator, and it's the real one.
    const terminators = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.startsWith("'@"));
    expect(terminators).toEqual([{ line: "'@ | ConvertFrom-Json", index: 3 }]);
  });

  it("rounds fractional millis (PowerShell casts the payload to [long])", () => {
    const script = buildStampScript([{ path: "a.md", ms: 1234.6 }]);
    expect(JSON.parse(script.split("\n")[2])[0].t).toBe(1235);
  });
});
