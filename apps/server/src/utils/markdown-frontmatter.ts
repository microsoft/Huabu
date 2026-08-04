/**
 * YAML-frontmatter helpers for node markdown files.
 *
 *   ---
 *   key: value
 *   list:
 *     - one
 *     - two
 *   ---
 *   <markdown body>
 *
 * Backed by the `yaml` library so nested objects, arrays, and proper
 * scalar typing all round-trip cleanly. External agents can read the
 * frontmatter without a second JSON-decode pass — the keys are native
 * YAML fields, not stringified blobs.
 */

import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

/** Serialise a record to a YAML frontmatter block (including the `---` fences). */
export function toFrontmatter(meta: Record<string, unknown>): string {
  // `yaml.stringify` always ends with a newline; strip it so callers
  // control the body separator.
  const body = yamlStringify(meta, {
    // Keep numbers/strings unambiguous on round-trip without forcing
    // every key into quotes.
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
    lineWidth: 0, // never wrap long strings
  }).replace(/\n$/, '');
  return `---\n${body}\n---`;
}

/**
 * Parse YAML frontmatter from a string. Returns an empty `meta` and the
 * raw input as `content` when no frontmatter block is found.
 */
export function parseFrontmatter(
  raw: string,
  options?: { strict?: boolean },
): {
  meta: Record<string, unknown>;
  content: string;
} {
  if (!raw.startsWith('---')) {
    return { meta: {}, content: raw };
  }

  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx === -1) {
    return { meta: {}, content: raw };
  }

  const yamlBlock = raw.slice(4, endIdx); // skip leading "---\n"
  // Normalise CR / CRLF → LF before handing to the YAML parser. The
  // `yaml` package treats `\r` as part of the surrounding scalar (so
  // a value like `toolExecution: parallel` written on Windows comes
  // back as the literal string `"parallel\r"` and trips downstream
  // enum-style validation). Note that `endIdx` points at the `\n` of
  // the closing `\n---` marker, so a CRLF-authored file leaves an
  // orphan `\r` at the tail of `yamlBlock` — match both `\r\n` and
  // bare `\r` so the last line is normalised too. Keeps every
  // frontmatter consumer — node files, agent / skill loaders —
  // line-ending agnostic regardless of where the file was authored.
  let meta: Record<string, unknown> = {};
  try {
    const parsed = yamlParse(yamlBlock.replace(/\r\n?/g, '\n'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  } catch (error) {
    if (options?.strict) throw error;
    meta = {};
  }

  let contentStart = endIdx + 4; // skip "\n---"
  if (raw.slice(contentStart, contentStart + 2) === '\r\n') {
    contentStart += 2;
  } else if (raw[contentStart] === '\n') {
    contentStart += 1;
  }

  return { meta, content: raw.slice(contentStart) };
}
