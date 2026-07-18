/**
 * Pure parsing/rendering for CHANGELOG.md — no `vscode` import, so it unit-tests
 * in isolation. Mirrors this project's other pure-parser modules (partsSidecar.ts,
 * editOps.ts): the vscode-dependent I/O (reading the file, showing the panel)
 * lives in whatsNew.ts.
 */

export interface ChangelogEntry {
  readonly version: string;
  readonly date: string;
  /** Raw markdown body between this entry's `## [x.y.z] - date` heading and the next. */
  readonly bodyMarkdown: string;
}

const ENTRY_HEADING = /^## \[([^\]]+)\] - (.+)$/gm;
/** A Keep-a-Changelog reference-link definition, e.g. `[1.0.3]: https://.../compare/...`. */
const REFERENCE_LINK_LINE = /^\[[^\]]+\]:.*$/m;

/**
 * Parses a Keep-a-Changelog-style document into entries, newest first (matching
 * file order). The trailing reference-link block is stripped before splitting,
 * since it isn't part of any entry's body.
 */
export function parseChangelog(text: string): ChangelogEntry[] {
  const refLinkStart = text.search(REFERENCE_LINK_LINE);
  const body = refLinkStart >= 0 ? text.slice(0, refLinkStart) : text;

  const headings: { version: string; date: string; index: number; headingEnd: number }[] = [];
  for (const match of body.matchAll(ENTRY_HEADING)) {
    headings.push({
      version: match[1].trim(),
      date: match[2].trim(),
      index: match.index ?? 0,
      headingEnd: (match.index ?? 0) + match[0].length,
    });
  }

  return headings.map((h, i) => {
    const end = i + 1 < headings.length ? headings[i + 1].index : body.length;
    return { version: h.version, date: h.date, bodyMarkdown: body.slice(h.headingEnd, end).trim() };
  });
}

/** Numeric `x.y.z` comparison (no semver dependency — this project's versions are always plain numeric triples). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** Entries strictly newer than `lastVersion`, preserving the newest-first input order. */
export function entriesSince(entries: readonly ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
  return entries.filter((e) => compareVersions(e.version, lastVersion) > 0);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Renders inline `` `code` `` spans within an already-escaped line. */
function renderInline(escapedLine: string): string {
  return escapedLine.replace(/`([^`]+)`/g, "<code>$1</code>");
}

/**
 * Renders one entry's body to HTML. Restricted to exactly what this project's
 * CHANGELOG.md format uses: `###` subheadings, `- ` bullet lists, and inline
 * `` `code` `` spans — not a general markdown renderer.
 */
export function renderEntryHtml(entry: ChangelogEntry): string {
  const lines = entry.bodyMarkdown.split("\n");
  const parts: string[] = [];
  let inList = false;
  /** Text accumulated for the `<li>` currently being built, so a wrapped bullet line merges into it. */
  let pendingLi: string | null = null;

  const flushLi = () => {
    if (pendingLi !== null) {
      parts.push(`<li>${pendingLi}</li>`);
      pendingLi = null;
    }
  };
  const closeList = () => {
    flushLi();
    if (inList) {
      parts.push("</ul>");
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") continue;

    const heading = /^###\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      parts.push(`<h4>${renderInline(escapeHtml(heading[1]))}</h4>`);
      continue;
    }

    const bullet = /^-\s+(.*)$/.exec(line);
    if (bullet) {
      flushLi();
      if (!inList) {
        parts.push("<ul>");
        inList = true;
      }
      pendingLi = renderInline(escapeHtml(bullet[1]));
      continue;
    }

    if (pendingLi !== null) {
      // Continuation of a wrapped bullet line.
      pendingLi += ` ${renderInline(escapeHtml(line))}`;
      continue;
    }

    closeList();
    parts.push(`<p>${renderInline(escapeHtml(line))}</p>`);
  }
  closeList();

  return `<h3>${escapeHtml(entry.version)} <span class="wn-date">${escapeHtml(entry.date)}</span></h3>${parts.join("\n")}`;
}
