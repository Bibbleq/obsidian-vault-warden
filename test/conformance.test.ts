import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validate } from "../src/engine/validate";
import type { ValidationInput } from "../src/engine/types";
import { compareViolations, type Loose } from "./helpers/compare";

/**
 * Loads every test/fixtures/*.json file and runs each case through the engine's
 * `validate` entry point, asserting the actual violations match the fixture's
 * `expect` array per the comparison semantics in docs/FIXTURES.md (order-insensitive,
 * subset-match per violation, exact count).
 *
 * Fixtures are plain JSON and deliberately minimal: a case may omit `config`,
 * `classes`, or `sources` entirely when it doesn't need them. Those default to
 * `{}` here, matching ValidationInput's shape.
 */

interface FixtureCase {
  name: string;
  config?: ValidationInput["config"];
  classes?: ValidationInput["classes"];
  sources?: ValidationInput["sources"];
  file: ValidationInput["file"];
  expect: Loose[];
}

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const fixtureFiles = readdirSync(fixturesDir)
  .filter((name) => name.endsWith(".json"))
  .sort();

function formatFailureMessage(
  fixtureFile: string,
  caseName: string,
  expected: Loose[],
  actual: Loose[],
  unmatchedExpected: Loose[],
  unmatchedActual: Loose[]
): string {
  return [
    `Fixture case failed: ${fixtureFile} > ${caseName}`,
    `expected: ${JSON.stringify(expected)}`,
    `actual:   ${JSON.stringify(actual)}`,
    `unmatched expected: ${JSON.stringify(unmatchedExpected)}`,
    `unmatched actual:   ${JSON.stringify(unmatchedActual)}`,
  ].join("\n");
}

for (const fixtureFile of fixtureFiles) {
  const raw = readFileSync(join(fixturesDir, fixtureFile), "utf-8");
  const cases: FixtureCase[] = JSON.parse(raw);

  describe(fixtureFile, () => {
    for (const testCase of cases) {
      it(testCase.name, () => {
        const input: ValidationInput = {
          config: testCase.config ?? {},
          classes: testCase.classes ?? {},
          sources: testCase.sources ?? {},
          file: testCase.file,
        };

        const actual = validate(input) as unknown as Loose[];
        const result = compareViolations(testCase.expect, actual);

        expect(
          result.pass,
          formatFailureMessage(
            fixtureFile,
            testCase.name,
            testCase.expect,
            actual,
            result.unmatchedExpected,
            result.unmatchedActual
          )
        ).toBe(true);
      });
    }
  });
}
