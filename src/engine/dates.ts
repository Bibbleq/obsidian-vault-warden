/**
 * Date-format pattern matching for the DATE-FORMAT rule.
 *
 * Patterns are built from the tokens YYYY, MM, DD, HH, mm, ss; every other
 * character in a pattern is a literal. Matching is done with a generated,
 * lookbehind-free regex (digit-count only) followed by numeric range checks,
 * so we never attempt full calendar validation (e.g. leap years).
 */

/** Recognised pattern tokens, longest/most-specific first so tokenizing is greedy. */
const TOKENS = ["YYYY", "MM", "DD", "HH", "mm", "ss"] as const;
type Token = (typeof TOKENS)[number];

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;

function escapeLiteral(ch: string): string {
  return REGEX_SPECIAL.test(ch) ? `\\${ch}` : ch;
}

interface CompiledPattern {
  regex: RegExp;
  tokens: Token[];
}

/** Turn a pattern like "YYYY-MM-DD" into a regex plus the ordered list of tokens it captures. */
function compilePattern(pattern: string): CompiledPattern {
  let source = "";
  const tokens: Token[] = [];
  let i = 0;
  while (i < pattern.length) {
    const remaining = pattern.slice(i);
    const token = TOKENS.find((t) => remaining.startsWith(t));
    if (token) {
      const digits = token.length === 4 ? 4 : 2;
      source += `(\\d{${digits}})`;
      tokens.push(token);
      i += token.length;
    } else {
      source += escapeLiteral(pattern[i]);
      i += 1;
    }
  }
  return { regex: new RegExp(`^${source}$`), tokens };
}

function tokenInRange(token: Token, value: number): boolean {
  switch (token) {
    case "MM":
      return value >= 1 && value <= 12;
    case "DD":
      return value >= 1 && value <= 31;
    case "HH":
      return value >= 0 && value <= 23;
    case "mm":
    case "ss":
      return value >= 0 && value <= 59;
    case "YYYY":
      return true;
    default:
      return false;
  }
}

/** Does `value` match `pattern` (structurally and within each token's numeric range)? */
function matchesPattern(value: string, pattern: string): boolean {
  const { regex, tokens } = compilePattern(pattern);
  const match = regex.exec(value);
  if (!match) return false;
  for (let i = 0; i < tokens.length; i += 1) {
    const captured = match[i + 1];
    const num = parseInt(captured, 10);
    if (!tokenInRange(tokens[i], num)) return false;
  }
  return true;
}

/** Does `value` satisfy at least one of the configured date `formats`? */
export function matchesAnyFormat(value: string, formats: string[]): boolean {
  return formats.some((format) => matchesPattern(value, format));
}
