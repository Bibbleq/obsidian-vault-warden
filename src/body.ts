/**
 * Minimal note-body manipulation for the title-sync fixes. Pure string
 * functions (kept out of src/engine/ because they're plugin-side helpers,
 * not part of the shared rule contract).
 */

const FENCE_RE = /^\s*(```|~~~)/;
const H1_RE = /^#\s/;

/** Split note content into its frontmatter block (including delimiters and the
 * trailing newline; "" when absent) and the body. */
export function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return { frontmatter: "", body: content };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      const boundary = lines.slice(0, i + 1).join("\n") + "\n";
      return { frontmatter: boundary, body: lines.slice(i + 1).join("\n") };
    }
  }
  return { frontmatter: "", body: content };
}

/** True when the note has no body content (frontmatter excluded). */
export function isBodyEmpty(content: string): boolean {
  return splitFrontmatter(content).body.trim() === "";
}

/**
 * Render a body scaffold from a template file's content: the template's own
 * frontmatter is discarded (frontmatter comes from the class manifest), and
 * the deliberately tiny token set is substituted — {{title}} and {{date}}
 * only, no logic.
 */
export function renderScaffold(templateContent: string, title: string, date: string): string {
  const body = splitFrontmatter(templateContent).body;
  return body
    .replace(/\{\{title\}\}/g, title)
    .replace(/\{\{date\}\}/g, date)
    .replace(/^\n+/, "");
}

/**
 * Replace the first level-1 heading's text with `title`, or insert
 * `# title` after the frontmatter block when the note has no H1.
 * Lines inside code fences are ignored. Returns the new content
 * (identical string when nothing changed).
 */
export function setFirstH1(content: string, title: string): string {
  if (title.trim() === "") return content;
  const lines = content.split("\n");

  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        bodyStart = i + 1;
        break;
      }
    }
  }

  let inFence = false;
  for (let i = bodyStart; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (H1_RE.test(lines[i])) {
      const replaced = `# ${title}`;
      if (lines[i] === replaced) return content;
      lines[i] = replaced;
      return lines.join("\n");
    }
  }

  // No H1 anywhere: insert one at the top of the body.
  const insertion = bodyStart > 0 ? ["", `# ${title}`, ""] : [`# ${title}`, ""];
  lines.splice(bodyStart, 0, ...insertion);
  return lines.join("\n");
}
