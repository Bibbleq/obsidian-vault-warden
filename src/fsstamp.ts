/**
 * Filesystem creation-stamp support: the inverse of the CREATED-MISSING fix.
 *
 * CREATED-MISSING reads the file's creation time and writes it into
 * frontmatter. This module goes the other way — it takes frontmatter `created`
 * as the source of truth and pushes it onto the file's on-disk creation stamp,
 * so the vault sorts by authored date in Obsidian's file list, File Explorer,
 * and anything else that reads the filesystem.
 *
 * Platform reality: Node's `fs.utimes` sets modified/accessed times only —
 * there is no cross-platform API for the creation stamp. On Windows it is a
 * `SetFileTime` call, reached here by shelling out to PowerShell (batched into
 * a single process for a whole folder). On Linux birthtime is not settable at
 * all, and on macOS it needs Xcode's `SetFile`, so both are reported
 * unsupported rather than half-working.
 *
 * Kept out of src/engine/ (it touches Node built-ins and is plugin-only, not
 * part of the shared batch contract) and free of any "obsidian" import, so the
 * pure planning half stays unit-testable headlessly. Node modules are required
 * lazily so the plugin still loads on mobile, where `require` is absent.
 */

/** `YYYY-MM-DD` with an optional time and optional zone suffix. */
const STAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$/;

/** One file's desired creation stamp. */
export interface StampTarget {
  /** Absolute filesystem path. */
  path: string;
  /** Target creation time as epoch millis. */
  ms: number;
}

export interface StampResult {
  /** How many files were successfully restamped. */
  ok: number;
  /** Absolute paths that could not be restamped. */
  failed: string[];
  /** Populated when the whole batch failed (spawn error, bad output). */
  error?: string;
}

/** A parsed frontmatter `created` value. */
export interface ParsedStamp {
  /** Epoch millis. Zone-less values are read as local wall-clock time. */
  ms: number;
  /** True when the value carried no time component (a bare `YYYY-MM-DD`). */
  dateOnly: boolean;
}

/** What to do about one file's creation stamp. */
export interface StampPlan {
  /** The creation stamp the file should end up with, as epoch millis. */
  targetMs: number;
  /** True when the current stamp already satisfies `created` (leave it alone). */
  inSync: boolean;
}

/** Lazily resolve a Node built-in; null on mobile (no `require`) or on failure. */
function nodeModule<T>(id: string): T | null {
  if (typeof require !== "function") return null;
  try {
    return require(id) as T;
  } catch {
    return null;
  }
}

/** Whether this platform can set a file's creation stamp, and why not if it can't. */
export function creationStampSupport(): { supported: boolean; reason: string } {
  if (typeof process === "undefined" || typeof process.platform !== "string") {
    return { supported: false, reason: "no filesystem access on mobile" };
  }
  if (process.platform === "win32") return { supported: true, reason: "" };
  if (process.platform === "darwin") {
    return {
      supported: false,
      reason: "macOS has no scriptable creation-stamp API (it needs Xcode's SetFile)",
    };
  }
  return {
    supported: false,
    reason: `${process.platform} does not support setting a file's creation time`,
  };
}

/**
 * Parse a frontmatter `created` value into epoch millis.
 *
 * A zone-less value is local wall-clock (a note "created 2026-06-29T09:00"
 * means 09:00 where the author was, which is what the filesystem stamp should
 * show). An explicit `Z`/offset is honoured as an absolute instant. Calendar
 * validity is checked by round-tripping, so `2026-13-40` is rejected rather
 * than silently rolling over — unlike the engine's shape-only DATE-FORMAT
 * check, a bad stamp here would write a wrong date to disk.
 */
export function parseStamp(value: unknown): ParsedStamp | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return isNaN(ms) ? null : { ms, dateOnly: false };
  }
  if (typeof value !== "string") return null;
  const match = STAMP_RE.exec(value.trim());
  if (!match) return null;

  const [, y, mo, d, h, mi, s, frac, zone] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = h === undefined ? 0 : Number(h);
  const minute = mi === undefined ? 0 : Number(mi);
  const second = s === undefined ? 0 : Number(s);
  const millis = frac === undefined ? 0 : Number(frac.slice(0, 3).padEnd(3, "0"));
  const dateOnly = h === undefined;

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  if (zone !== undefined) {
    // Absolute instant — let the platform parser handle the offset, after
    // normalising "+0100" to "+01:00" and a space separator to "T".
    const normalisedZone = /^[Zz]$/.test(zone) ? "Z" : zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
    const iso =
      `${y}-${mo}-${d}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` +
      `:${String(second).padStart(2, "0")}.${String(millis).padStart(3, "0")}${normalisedZone}`;
    const ms = Date.parse(iso);
    return isNaN(ms) ? null : { ms, dateOnly: false };
  }

  const local = new Date(year, month - 1, day, hour, minute, second, millis);
  // Round-trip guard: JS rolls 2026-02-30 over to March, which would stamp the
  // wrong date on disk.
  if (
    local.getFullYear() !== year ||
    local.getMonth() !== month - 1 ||
    local.getDate() !== day
  ) {
    return null;
  }
  return { ms: local.getTime(), dateOnly };
}

/** Local `YYYY-MM-DD` for an epoch-millis instant. */
function localDayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The calendar date of `dateMs` combined with the time-of-day of `timeMs`. */
function withDateOf(dateMs: number, timeMs: number): number {
  const date = new Date(dateMs);
  const time = new Date(timeMs);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    time.getHours(),
    time.getMinutes(),
    time.getSeconds(),
    time.getMilliseconds()
  ).getTime();
}

/**
 * Decide the creation stamp a file should carry. Returns null when `created`
 * is absent or unparseable (nothing to sync from — CREATED-MISSING and
 * DATE-FORMAT own those cases).
 *
 * Comparison happens at the precision the author actually wrote:
 *
 * - A bare `YYYY-MM-DD` only claims a day, so a stamp already landing on that
 *   day is left completely alone. When it doesn't, the day is corrected while
 *   the existing time-of-day is preserved — that keeps notes created on the
 *   same day in their original relative order instead of collapsing them all
 *   to midnight.
 * - A value with a time is matched to the minute, since that is the precision
 *   the plugin writes `created` at; anything coarser would fight itself.
 */
export function planCreationStamp(createdValue: unknown, currentMs: number | null): StampPlan | null {
  const parsed = parseStamp(createdValue);
  if (!parsed) return null;
  if (currentMs === null || !Number.isFinite(currentMs)) {
    return { targetMs: parsed.ms, inSync: false };
  }
  if (parsed.dateOnly) {
    if (localDayKey(currentMs) === localDayKey(parsed.ms)) {
      return { targetMs: currentMs, inSync: true };
    }
    return { targetMs: withDateOf(parsed.ms, currentMs), inSync: false };
  }
  return { targetMs: parsed.ms, inSync: Math.abs(currentMs - parsed.ms) < 60_000 };
}

/** The file's current creation stamp as epoch millis; null if unreadable. */
export function readCreationTimeMs(absPath: string): number | null {
  const fs = nodeModule<typeof import("fs")>("fs");
  if (!fs) return null;
  try {
    const ms = fs.statSync(absPath).birthtimeMs;
    // Filesystems without birthtime report 0; treat that as "unknown" rather
    // than as 1970 (which would look like drift on every single note).
    return typeof ms === "number" && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Build the PowerShell program that restamps every target.
 *
 * The payload rides in as single-line JSON inside a single-quoted here-string:
 * JSON.stringify escapes newlines, so no line of the payload can start with
 * the `'@` terminator, and single-quoting stops PowerShell interpolating `$`
 * or backticks out of a filename. Timestamps cross as epoch millis to dodge
 * date-format and timezone parsing on the far side.
 */
export function buildStampScript(targets: StampTarget[]): string {
  const payload = JSON.stringify(targets.map((t) => ({ p: t.path, t: Math.round(t.ms) })));
  return [
    "$ErrorActionPreference = 'Stop'",
    "$items = @'",
    payload,
    "'@ | ConvertFrom-Json",
    "$ok = 0",
    "$failed = @()",
    "foreach ($i in $items) {",
    "  try {",
    "    $when = [datetimeoffset]::FromUnixTimeMilliseconds([long]$i.t).LocalDateTime",
    "    (Get-Item -LiteralPath $i.p -Force).CreationTime = $when",
    "    $ok++",
    "  } catch {",
    "    $failed += [string]$i.p",
    "  }",
    "}",
    "[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ ok = $ok; failed = @($failed) }))",
  ].join("\n");
}

/**
 * Restamp every target in one PowerShell process (spawning per file would cost
 * hundreds of milliseconds each on a folder sweep). Never throws — failures
 * come back in the result so callers can report them.
 */
export async function setCreationTimes(targets: StampTarget[]): Promise<StampResult> {
  if (targets.length === 0) return { ok: 0, failed: [] };

  const support = creationStampSupport();
  if (!support.supported) {
    return { ok: 0, failed: targets.map((t) => t.path), error: support.reason };
  }
  const cp = nodeModule<typeof import("child_process")>("child_process");
  if (!cp) {
    return { ok: 0, failed: targets.map((t) => t.path), error: "no child_process access" };
  }

  const script = buildStampScript(targets);
  return await new Promise<StampResult>((resolve) => {
    const allFailed = (error: string): StampResult => ({
      ok: 0,
      failed: targets.map((t) => t.path),
      error,
    });
    try {
      const child = cp.execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
        { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          const text = String(stdout ?? "").trim();
          if (text === "") {
            resolve(allFailed(err ? String(err.message ?? err) : "PowerShell returned nothing"));
            return;
          }
          try {
            const parsed = JSON.parse(text) as { ok?: number; failed?: unknown };
            const failed = Array.isArray(parsed.failed) ? parsed.failed.map(String) : [];
            resolve({ ok: Number(parsed.ok ?? 0), failed });
          } catch {
            resolve(allFailed(`unreadable PowerShell output: ${text.slice(0, 200)}`));
          }
        }
      );
      // The program arrives on stdin (-Command -), so nothing has to survive
      // command-line quoting.
      child.stdin?.end(script);
    } catch (e) {
      resolve(allFailed(String(e)));
    }
  });
}
