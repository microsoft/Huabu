/**
 * Read tool — return the contents of a single file under the workspace.
 *
 * File-level primitive (pi/Claude-Code style). Path is resolved against
 * the workspace root via the shared sandbox, so it can address any file
 * the agent has access to:
 *   - "<canvasId>/canvas.json"
 *   - "<canvasId>/nodes/<nodeId>.md"
 *   - sources, artifacts, memory, etc.
 *
 * Output is a JSON envelope with the same truncation budget as pi:
 * 2000 lines / 50 KB, whichever fires first; `nextOffset` lets the
 * agent page through long files.
 *
 * Frontmatter convenience: if the file starts with a YAML frontmatter
 * block ("---" fences), the parsed object is attached as `frontmatter`
 * so the LLM doesn't have to parse YAML itself (which it does badly).
 * The raw `content` field is unchanged — the file is reproduced
 * verbatim, including the fences. `frontmatter` is purely additive.
 *
 * Note vs `inspect_nodes`: read owns everything that lives in the
 * node markdown frontmatter (label, type, src, summary, keywords, ...).
 * Position / size / parent / style live in `canvas.json` and are owned
 * by `inspect_nodes` — see that handler for the boundary.
 */

import { readFileSync, statSync } from 'node:fs';

import { normalizeRel, safeResolve } from './fs-sandbox.js';
import { parseFrontmatter } from '../../../storage/frontmatter.js';

import type { readParamsSchema } from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';

// ─── Argument types ─────────────────────────────────────────────────────────

export type ReadArgs = Static<typeof readParamsSchema>;

// ─── Tunables (mirror pi-coding-agent) ──────────────────────────────────────

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

// ─── Implementation ─────────────────────────────────────────────────────────

export async function handleRead(args: ReadArgs): Promise<string> {
  const { path: requested, offset, limit } = args;

  if (typeof requested !== 'string' || requested.length === 0) {
    return JSON.stringify({ error: 'path is required' });
  }
  const rel = normalizeRel(requested);

  let abs: string;
  try {
    abs = safeResolve(rel);
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }

  // Stat first so we can give a better error than ENOENT spam.
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return JSON.stringify({ error: `Path not found: ${rel}` });
  }
  if (stat.isDirectory()) {
    return JSON.stringify({
      error: `"${rel}" is a directory. Use the ls tool to list directory contents.`,
    });
  }
  if (!stat.isFile()) {
    return JSON.stringify({ error: `Not a regular file: ${rel}` });
  }

  // Read as UTF-8. Binary detection here is intentionally light:
  // anything with a NUL byte in the first 1 KB we treat as binary
  // and refuse, which catches images / archives / compiled blobs
  // without needing a mime database.
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch (e) {
    return JSON.stringify({
      error: `Failed to read file: ${(e as Error).message}`,
    });
  }
  const head = buf.subarray(0, Math.min(1024, buf.length));
  if (head.includes(0)) {
    return JSON.stringify({
      error: `"${rel}" appears to be a binary file. The read tool only handles text. Image / pdf / video nodes store their bytes under <canvasId>/artifacts/ \u2014 use the canvas UI to view them; the agent only sees their src URL via the node markdown frontmatter.`,
    });
  }

  const text = buf.toString('utf8');

  // Parse frontmatter from the whole file (not the slice) so the structured
  // metadata is surfaced even when the agent pages through the body. The
  // raw fence block is still present in `content` when the slice covers
  // the file head \u2014 we don't strip it, so the file remains reproduced
  // verbatim. Empty `meta` (no fences, or unparseable YAML) means "not a
  // frontmatter file" and we omit the field entirely.
  let frontmatter: Record<string, unknown> | undefined;
  if (text.startsWith('---')) {
    const parsed = parseFrontmatter(text);
    if (parsed.meta && Object.keys(parsed.meta).length > 0) {
      frontmatter = parsed.meta;
    }
  }

  const allLines = text.split('\n');
  const totalLines = allLines.length;

  // Convert pi's 1-indexed offset into a 0-indexed slice start.
  const startLine = offset && offset > 0 ? offset - 1 : 0;
  if (startLine >= totalLines) {
    return JSON.stringify({
      error: `Offset ${offset} is beyond end of file (${totalLines} lines total).`,
    });
  }

  // Step 1: honour the user-supplied `limit` (pi semantics — soft cap
  // measured in lines), capping at the hard line ceiling so a runaway
  // limit cannot blow the context budget.
  const userLimit =
    limit && limit > 0 ? Math.min(limit, DEFAULT_MAX_LINES) : DEFAULT_MAX_LINES;
  let endLineExclusive = Math.min(startLine + userLimit, totalLines);

  // Step 2: enforce the byte ceiling. Walk the slice line-by-line and
  // stop as soon as adding the next line would push us past the cap.
  // Never cut a line in half.
  let bytesUsed = 0;
  let firstLineExceedsLimit = false;
  let byteCutLine: number | null = null;
  for (let i = startLine; i < endLineExclusive; i++) {
    const lineBytes = Buffer.byteLength(allLines[i] ?? '', 'utf8');
    // +1 for the '\n' separator (except for the last line).
    const cost = lineBytes + (i < endLineExclusive - 1 ? 1 : 0);
    if (bytesUsed + cost > DEFAULT_MAX_BYTES) {
      if (i === startLine) {
        firstLineExceedsLimit = true;
      }
      byteCutLine = i;
      break;
    }
    bytesUsed += cost;
  }
  if (firstLineExceedsLimit) {
    return JSON.stringify({
      error: `Line ${startLine + 1} alone exceeds the ${
        DEFAULT_MAX_BYTES / 1024
      } KB output limit. Try a narrower window with grep, or use a tighter offset/limit.`,
    });
  }
  if (byteCutLine !== null) {
    endLineExclusive = byteCutLine;
  }

  const sliceLines = allLines.slice(startLine, endLineExclusive);
  const content = sliceLines.join('\n');
  const truncated = endLineExclusive < totalLines;
  const nextOffset = truncated ? endLineExclusive + 1 : undefined;

  return JSON.stringify({
    path: rel,
    startLine: startLine + 1,
    endLine: endLineExclusive,
    totalLines,
    truncated,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    ...(frontmatter !== undefined ? { frontmatter } : {}),
    content,
  });
}
