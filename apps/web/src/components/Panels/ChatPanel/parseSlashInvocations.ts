// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Parse leading `/<id>` slash-command tokens from a chat-input message.
 *
 * Used by ChatPanel at submit time to split a raw textarea value into
 * (cleaned message text, invoked skill ids) before calling
 * `startStream`. The parser is deliberately conservative:
 *
 *  - Only **leading** tokens count. `/x /y hello /z` → invoked `[x, y]`,
 *    message `hello /z`. A `/` that appears mid-sentence is treated as
 *    literal text so users can still type things like file paths or
 *    URLs without false matches.
 *  - Only ids that appear in `knownIds` are treated as invocations.
 *    Unknown `/foo` tokens are left in the message untouched, matching
 *    the typeahead UX (no menu → no recognition).
 *  - Duplicate ids collapse to one entry, preserving first-seen order.
 *
 * Matching is exact and case-sensitive — skill ids are filesystem
 * directory names on the server, and case mismatch would silently
 * misroute.
 */
export interface ParsedSlashInvocations {
  /** Skill ids the user explicitly invoked (deduped, in first-seen order). */
  invokedSkills: string[];
  /** Message text with the recognised leading tokens stripped. */
  message: string;
}

/**
 * One identifier token: leading `/`, then [A-Za-z0-9._-]+ (matches the
 * id grammar enforced by the skill loader: directory-name compatible).
 * The trailing `\s+` or end-of-string anchors prevent `/foo/bar` from
 * being read as command `foo`.
 */
const SLASH_TOKEN = /^\/([A-Za-z0-9._-]+)(\s+|$)/;

export function parseSlashInvocations(
  raw: string,
  knownIds: ReadonlySet<string>,
): ParsedSlashInvocations {
  const invokedSkills: string[] = [];
  let rest = raw.trimStart();

  // Consume one token per loop iteration. Stop as soon as the next
  // token either doesn't match the slash grammar or isn't in
  // `knownIds` — unrecognised text falls through to the message body
  // verbatim (with any surrounding whitespace preserved-ish; we only
  // strip the leading whitespace we just consumed).
  while (true) {
    const m = SLASH_TOKEN.exec(rest);
    // `m[1]` is the capture group; it is guaranteed by the regex
    // shape whenever `m` is non-null. Narrow defensively rather than
    // assert so the lint rule on non-null assertions stays clean.
    const id = m?.[1];
    if (!m || !id) break;
    if (!knownIds.has(id)) break;
    if (!invokedSkills.includes(id)) invokedSkills.push(id);
    rest = rest.slice(m[0].length);
  }

  return { invokedSkills, message: rest };
}
