// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * ACP fs/* capability handlers.
 *
 * Implements `fs/read_text_file` (read-only) for external agents and
 * keeps `fs/write_text_file` explicitly closed.
 *
 * ─── Virtual filesystem namespace ──────────────────────────────────────
 *
 * The ACP spec requires `path` on the wire to be absolute. Huabu's
 * sandbox is purely server-side, so we expose a synthetic absolute
 * namespace rooted at `/space/` — the agent has no view of Huabu's
 * real disk layout, and the canvasId is never sent on the wire.
 *
 *   wire:        "/space/nodes/foo.md"
 *   internal:    safeResolve(canvasId, "nodes/foo.md")
 *                  → <workspace>/<canvasDir>/nodes/foo.md
 *
 * The preprocessor advertises this same `/space/<rel>` form in its
 * `fileRefs` list (see `acp/preprocessor.ts:serializePrompt`) so the
 * agent's `Read` tool emits matching absolute paths.
 *
 * ─── Allowlist ─────────────────────────────────────────────────────────
 *
 * Even within the canvas sandbox, external agents are limited to:
 *
 *   - `nodes/**`        — per-node markdown
 *   - `.artifacts/**`   — uploaded sources
 *
 * Everything else — `space.json`, `skills/**`, `memory/**`,
 * `.history/**` — is rejected as outside the allowlist.
 */

import { lstatSync, readFileSync } from 'node:fs';

import { normalizeRel, safeResolve } from '../../tools/handlers/fs-sandbox.js';

/**
 * Virtual root the agent sees on the wire (`/space/`). Anything outside
 * this prefix is rejected before the sandbox is ever consulted. The const
 * name keeps the legacy `CANVAS` token (internal); the wire value is Space.
 */
export const ACP_CANVAS_VFS_PREFIX = '/space/';

/**
 * Hard cap on a single `fs/read_text_file` response. Mirrors
 * `tools/handlers/fs-read.ts:MAX_READ_FILE_BYTES` so external and
 * internal reads have the same ceiling.
 */
const MAX_READ_FILE_BYTES = 10 * 1024 * 1024;

// JSON-RPC 2.0 error codes. Spec range -32000 to -32099 is reserved for
// implementation-defined errors; we stick to the standard set so any
// ACP-aware agent can categorise the failure.
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;

/**
 * Carries a JSON-RPC error code alongside the message so the client
 * router can craft a proper error reply without re-parsing the text.
 */
export class FsCapabilityError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'FsCapabilityError';
  }
}

/** Allowlist test against the canvas-relative path (after prefix strip). */
function isAllowedRead(rel: string): boolean {
  const norm = normalizeRel(rel);
  if (norm.length === 0) return false;
  if (norm.startsWith('/')) return false;
  if (norm === 'nodes' || norm.startsWith('nodes/')) return true;
  if (norm === '.artifacts' || norm.startsWith('.artifacts/')) return true;
  return false;
}

/** ACP `fs/read_text_file` request params we accept. */
export interface ReadTextFileParams {
  sessionId?: unknown;
  path?: unknown;
  /** Optional 1-based start line; ignored in v1. */
  line?: unknown;
  /** Optional max line count; ignored in v1. */
  limit?: unknown;
}

/** ACP `fs/read_text_file` response shape. */
export interface ReadTextFileResult {
  content: string;
}

/**
 * Handle one ACP `fs/read_text_file` request.
 *
 * Throws {@link FsCapabilityError} on any rejection; the caller (the
 * client router) is responsible for translating that to a JSON-RPC
 * error reply on the wire.
 *
 * `line` / `limit` are accepted but ignored in v1 — we always return
 * the whole file up to `MAX_READ_FILE_BYTES`. Adding pagination here
 * would require deciding on a consistent slice strategy for binary
 * detection / partial-line truncation; the 10 MB ceiling is enough
 * for canvas markdown today.
 */
export function handleFsReadTextFile(
  canvasId: string,
  params: unknown,
): ReadTextFileResult {
  if (!canvasId) {
    throw new FsCapabilityError(
      JSON_RPC_INVALID_PARAMS,
      'fs/read_text_file: no canvas is bound to this session',
    );
  }
  if (!params || typeof params !== 'object') {
    throw new FsCapabilityError(
      JSON_RPC_INVALID_PARAMS,
      'fs/read_text_file: params must be an object',
    );
  }
  const { path: wirePath } = params as ReadTextFileParams;
  if (typeof wirePath !== 'string' || wirePath.length === 0) {
    throw new FsCapabilityError(
      JSON_RPC_INVALID_PARAMS,
      'fs/read_text_file: "path" is required',
    );
  }
  if (!wirePath.startsWith(ACP_CANVAS_VFS_PREFIX)) {
    throw new FsCapabilityError(
      JSON_RPC_INVALID_PARAMS,
      `fs/read_text_file: path must begin with "${ACP_CANVAS_VFS_PREFIX}"`,
    );
  }

  const rel = wirePath.slice(ACP_CANVAS_VFS_PREFIX.length);

  if (!isAllowedRead(rel)) {
    throw new FsCapabilityError(
      JSON_RPC_INVALID_PARAMS,
      `fs/read_text_file: "${rel}" is outside the external-agent read allowlist (only nodes/** and .artifacts/**)`,
    );
  }

  let abs: string;
  try {
    abs = safeResolve(canvasId, rel);
  } catch (e) {
    // safeResolve throws on canvasId / traversal escapes. Surface as
    // invalid params so the agent's log shows a clear refusal.
    throw new FsCapabilityError(
      JSON_RPC_INVALID_PARAMS,
      e instanceof Error ? e.message : String(e),
    );
  }

  let stat;
  try {
    // lstatSync (not statSync) so symlinks are detected and rejected
    // instead of silently followed. safeResolve only does lexical
    // path-prefix checks; symlink resolution happens at the FS layer.
    stat = lstatSync(abs);
  } catch {
    throw new FsCapabilityError(
      JSON_RPC_INTERNAL_ERROR,
      `fs/read_text_file: path not found: ${rel}`,
    );
  }
  if (stat.isSymbolicLink()) {
    throw new FsCapabilityError(
      JSON_RPC_INVALID_PARAMS,
      `fs/read_text_file: refusing to follow symlink: ${rel}`,
    );
  }
  if (!stat.isFile()) {
    throw new FsCapabilityError(
      JSON_RPC_INVALID_PARAMS,
      `fs/read_text_file: not a regular file: ${rel}`,
    );
  }
  if (stat.size > MAX_READ_FILE_BYTES) {
    throw new FsCapabilityError(
      JSON_RPC_INVALID_PARAMS,
      `fs/read_text_file: "${rel}" is ${(stat.size / (1024 * 1024)).toFixed(1)} MB, exceeds the ${MAX_READ_FILE_BYTES / (1024 * 1024)} MB read limit`,
    );
  }

  const content = readFileSync(abs, 'utf8');
  return { content };
}
