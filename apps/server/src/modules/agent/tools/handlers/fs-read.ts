/**
 * Read tool — return the contents of a single file under the current canvas.
 *
 * File-level primitive (pi/Claude-Code style). Path is resolved against
 * the **current canvas folder** via the shared sandbox, so it can
 * address any file the agent has access to within that canvas:
 *   - "space.json"
 *   - "nodes/<filename>.md"
 *   - artifacts, memory, etc.
 *
 * Output is a JSON envelope with the same truncation budget as pi:
 * 2000 lines / 50 KB, whichever fires first; `nextOffset` lets the
 * agent page through long files.
 *
 * Errors throw — pi-agent-core's executor catches and surfaces them
 * as `isError: true` tool results (see its `AgentTool.execute`
 * contract). Successful calls return the JSON envelope as a string.
 *
 * Frontmatter convenience: if the file starts with a YAML frontmatter
 * block ("---" fences), the parsed object is attached as `frontmatter`
 * so the LLM doesn't have to parse YAML itself (which it does badly).
 * The raw `content` field is unchanged — the file is reproduced
 * verbatim, including the fences. `frontmatter` is purely additive.
 *
 * Note vs `inspect_nodes`: read owns everything that lives in the
 * node markdown frontmatter (label, type, src, summary, keywords, ...).
 * Position / size / parent / style live in `space.json` and are owned
 * by `inspect_nodes` — see that handler for the boundary.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { nodeRevisionOf } from '@sediment/shared/canvas-engine';

import { normalizeRel, safeResolve } from './fs-sandbox.js';
import { readSkillFile, resolveSkillPath } from '../../../../prompt/index.js';
import { parseFrontmatter } from '../../../../utils/markdown-frontmatter.js';
import { IMAGE_MIME_MAP, isVisionImageMime } from '../../../../utils/mime.js';
import { getCanvasStore } from '../../../storage/index.js';
import { readCanvasMemory, readWorkspaceMemory } from '../../memory/index.js';

import type { readParamsSchema } from '../definitions.js';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Static } from '@earendil-works/pi-ai';

// ─── Argument types ─────────────────────────────────────────────────────────
//
// `canvasId` is injected by the executor from the request context;
// it is *not* part of the LLM-visible schema. It scopes every read
// to the current canvas folder.

export type ReadArgs = Static<typeof readParamsSchema> & { canvasId: string };

// ─── Tunables (mirror pi-coding-agent) ──────────────────────────────────────

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

/**
 * Hard cap on file size we are willing to load into memory. The output
 * envelope tops out at ~50 KB anyway (see `DEFAULT_MAX_BYTES`), so any
 * file larger than this is either binary noise (caught separately) or
 * a multi-MB log/dump that the agent should be using `grep` against
 * rather than loading whole. Keeps the event loop responsive.
 */
const MAX_READ_FILE_BYTES = 10 * 1024 * 1024;

/** Canvas-relative path of a node markdown sidecar. */
const NODE_FILE_RE = /^nodes\/[^/]+\.md$/;

/**
 * When the agent reads a node's markdown, record its current
 * authored-content rev into the run's read-set (keyed by node id from
 * frontmatter). `canvas_commands` later auto-injects this as `expectRev`
 * so a subsequent content write carries the rev the agent actually saw.
 * Computed via the SAME `readNode` + `nodeRevisionOf` path the executor's
 * CAS uses, so the tokens are guaranteed to match. Best-effort — any
 * failure just leaves the node out of the read-set (a later write then
 * needs the context seed or is rejected as never-read).
 */
function recordNodeRev(
  rel: string,
  canvasId: string,
  fileText: string,
  readSet: Map<string, string>,
): void {
  if (!NODE_FILE_RE.test(rel)) return;
  const rawId = parseFrontmatter(fileText).meta?.['id'];
  const nodeId = typeof rawId === 'string' && rawId ? rawId : undefined;
  if (!nodeId) return;
  try {
    const nc = getCanvasStore(canvasId).readNode(nodeId);
    if (!nc) return;
    readSet.set(
      nodeId,
      nodeRevisionOf({
        content: nc.content,
        src: typeof nc.src === 'string' ? nc.src : undefined,
      }),
    );
  } catch {
    /* best-effort: skip on any read/parse failure */
  }
}

// ─── Implementation ───────────────────────────────────────────────

export async function handleRead(
  args: ReadArgs,
  readSet?: Map<string, string>,
): Promise<string | AgentToolResult<undefined>> {
  const { path: requested, offset, limit } = args;

  if (typeof requested !== 'string' || requested.length === 0) {
    throw new Error('path is required');
  }
  const rel = normalizeRel(requested);

  // Skill file paths resolve through the merged system+user view (see
  // `src/prompt/skills/loader.ts`). `readSkillFile` returns content
  // directly so the agent sees the merged SKILL.md when both layers
  // carry the id; reference files (`skills/<id>/references/*.md`)
  // fall through to `resolveSkillPath`, which returns the on-disk
  // path under whichever source actually owns that file.
  //
  // `readSkillFile` / `resolveSkillPath` throw `SkillPathEscapeError`
  // on `..` traversal — we let it propagate so pi-agent-core surfaces
  // it as a security-relevant tool error distinct from "Path not found".
  //
  // Intentionally do not special-case the bare `skills` path here:
  // `read` is file-only, so a directory read should fall through to
  // the normal sandbox path and surface the later directory-specific
  // error.
  let abs: string;
  if (rel.startsWith('skills/')) {
    const content = readSkillFile(rel);
    if (content !== null) {
      // Merged / system-only / user-only SKILL.md content is materialised
      // in memory. Render the same JSON envelope as a normal file read
      // (frontmatter convenience parse + line/byte windowing) without
      // ever touching disk again.
      return renderTextResponse(rel, content, offset, limit);
    }
    // Not a SKILL.md (or unknown id): fall back to the path resolver
    // for references / sub-files. Returns null on miss.
    const resolved = resolveSkillPath(rel);
    if (!resolved) {
      throw new Error(`Path not found: ${rel}`);
    }
    abs = resolved;
  } else if (rel.startsWith('memory/')) {
    // Memory virtual paths.
    //
    // Exactly two are accepted and routed to the corresponding
    // memory module readers (which resolve to setting/user.md and
    // the canvas's .memory/space.md respectively). The bodies live
    // outside the canvas sandbox — the canvas one is hidden behind
    // ALWAYS_SKIP for grep/find/ls, and the workspace one isn't under
    // the canvas root at all — so reading them via the normal
    // safeResolve path is impossible. This branch is the only way
    // for an agent to read them.
    //
    // Anything else under memory/ is rejected up-front so a typo
    // doesn't accidentally fall through to a 'path not found' that
    // looks like a missing memory file.
    let content: string | null = null;
    if (rel === 'memory/user.md') {
      content = readWorkspaceMemory();
    } else if (rel === 'memory/space.md') {
      if (!args.canvasId) {
        throw new Error(
          'memory/space.md is Space-scoped but no canvasId is bound to this request',
        );
      }
      content = readCanvasMemory(args.canvasId);
    } else {
      throw new Error(
        `Unknown memory path "${rel}". Valid: memory/user.md, memory/space.md`,
      );
    }
    if (content === null) {
      throw new Error(`Path not found: ${rel}`);
    }
    return renderTextResponse(rel, content, offset, limit);
  } else {
    // safeResolve throws when the path escapes the canvas sandbox; let
    // pi-agent-core wrap that as an isError tool result.
    abs = safeResolve(args.canvasId, rel);
  }

  // Stat first so we can give a better error than ENOENT spam.
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    throw new Error(`Path not found: ${rel}`);
  }
  if (stat.isDirectory()) {
    throw new Error(
      `"${rel}" is a directory. Use the ls tool to list directory contents.`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${rel}`);
  }
  if (stat.size > MAX_READ_FILE_BYTES) {
    throw new Error(
      `"${rel}" is ${(stat.size / (1024 * 1024)).toFixed(1)} MB, exceeds the ${
        MAX_READ_FILE_BYTES / (1024 * 1024)
      } MB read limit. Use grep to search inside it instead.`,
    );
  }

  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch (e) {
    throw new Error(`Failed to read file: ${(e as Error).message}`);
  }

  // Raster image artifacts are returned inline as vision content so
  // vision-capable models can actually see them. Types no vision model
  // accepts (SVG, BMP, AVIF) fall through: SVG is XML text that the
  // regular text path serves better, and the rest are refused as binary
  // rather than triggering a provider-side rejection of the whole request.
  const ext = path.extname(abs).toLowerCase();
  const candidateMime = IMAGE_MIME_MAP[ext];
  const imageMime = isVisionImageMime(candidateMime)
    ? candidateMime
    : undefined;
  if (imageMime) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            path: rel,
            mimeType: imageMime,
            bytes: buf.byteLength,
          }),
        },
        { type: 'image', data: buf.toString('base64'), mimeType: imageMime },
      ],
      details: undefined,
    };
  }

  // Binary detection: anything with a NUL byte in the first 1 KB we
  // treat as binary and refuse. Catches pdf / video / archives without
  // needing a full mime database.
  const head = buf.subarray(0, Math.min(1024, buf.length));
  if (head.includes(0)) {
    throw new Error(
      `"${rel}" appears to be a binary file. The read tool handles text and image artifacts only. PDF / video bytes live under .artifacts/ — use the canvas UI to view them; the agent only sees their src URL via the node markdown frontmatter.`,
    );
  }

  const text = buf.toString('utf8');
  if (readSet) recordNodeRev(rel, args.canvasId, text, readSet);
  return renderTextResponse(rel, text, offset, limit);
}

/**
 * Format the pi `read` JSON envelope around an already-loaded text body.
 *
 * Shared between the on-disk path (after binary detection) and the
 * skill merged-view path (where the body is materialised in memory by
 * the loader, so there's no file to stat or sniff for binary content).
 *
 * Encapsulates the line / byte windowing and frontmatter convenience
 * parse so the two callers cannot drift apart.
 */
function renderTextResponse(
  rel: string,
  text: string,
  offset: number | undefined,
  limit: number | undefined,
): string {
  // Parse frontmatter from the whole file (not the slice) so the structured
  // metadata is surfaced even when the agent pages through the body. The
  // raw fence block is still present in `content` when the slice covers
  // the file head — we don't strip it, so the file remains reproduced
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
    throw new Error(
      `Offset ${offset} is beyond end of file (${totalLines} lines total).`,
    );
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
    throw new Error(
      `Line ${startLine + 1} alone exceeds the ${
        DEFAULT_MAX_BYTES / 1024
      } KB output limit. Try a narrower window with grep, or use a tighter offset/limit.`,
    );
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
