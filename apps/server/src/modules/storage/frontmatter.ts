/**
 * Lightweight YAML-frontmatter helpers for node markdown files.
 *
 * The format is the same as the legacy knowledge module:
 *
 *   ---
 *   key: "value"
 *   other: 123
 *   ---
 *   <markdown body>
 *
 * Only flat key/value pairs are supported. Strings are JSON-quoted on
 * write so embedded special characters survive round trips.
 */

/** Serialise a flat record to a YAML frontmatter string. */
export function toFrontmatter(meta: Record<string, unknown>): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || value === undefined) {
      lines.push(`${key}: null`);
    } else if (typeof value === 'string') {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * Parse YAML frontmatter from a string. Returns the raw input as `content`
 * with an empty `meta` when no frontmatter block is found.
 */
export function parseFrontmatter(raw: string): {
  meta: Record<string, string | null>;
  content: string;
} {
  const meta: Record<string, string | null> = {};

  if (!raw.startsWith('---')) {
    return { meta, content: raw };
  }

  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx === -1) {
    return { meta, content: raw };
  }

  const yamlBlock = raw.slice(4, endIdx); // skip leading "---\n"
  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: string | null = line.slice(colonIdx + 1).trim();
    if (value === 'null') {
      value = null;
    } else if (value && value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value ? value.slice(1, -1) : '';
      }
    } else if (value && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }

  let contentStart = endIdx + 4; // skip "\n---"
  if (raw.slice(contentStart, contentStart + 2) === '\r\n') {
    contentStart += 2;
  } else if (raw[contentStart] === '\n') {
    contentStart += 1;
  }

  return { meta, content: raw.slice(contentStart) };
}
