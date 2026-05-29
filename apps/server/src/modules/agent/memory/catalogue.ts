/**
 * Memory catalogue helper.
 *
 * Mirrors `prompt/skills/catalogue.ts` — produces a short prompt-block
 * the agent loader injects into every system prompt. Two lines, one
 * per memory tier. Each line carries the file size as a hint so the
 * agent can decide whether a read is worth a turn (a 0-byte resource
 * is signalled by `(empty)`).
 *
 * Always renders both lines, regardless of file presence. Empty files
 * still tell the agent "this resource exists, the curator just hasn't
 * written to it yet" — which is also a meaningful signal.
 */

import { existsSync, statSync } from 'node:fs';

import { workingMemoryPath, workspaceMemoryPath } from '../../storage/paths.js';

/**
 * Render the per-turn memory catalogue. The optional `canvasId`
 * filters in the per-canvas line; when omitted (e.g. memory-less chat)
 * only the workspace line renders.
 *
 * Output shape mirrors `getSkillCatalogue`:
 *
 *   - **workspace** — user preferences & cross-canvas profile (1.2 KB).
 *     Load with: read("memory/workspace.md").
 *   - **working** — what this canvas is currently about (empty).
 *     Load with: read("memory/canvas.md").
 */
export function getMemoryCatalogue(canvasId: string | null): string {
  const lines: string[] = [];

  lines.push(
    catalogueLine({
      key: 'workspace',
      blurb: 'user preferences & cross-canvas profile',
      path: 'memory/workspace.md',
      sizeBytes: safeSize(workspaceMemoryPath()),
    }),
  );

  if (canvasId) {
    lines.push(
      catalogueLine({
        key: 'working',
        blurb: 'what this canvas is currently about',
        path: 'memory/canvas.md',
        sizeBytes: safeSize(workingMemoryPath(canvasId)),
      }),
    );
  }

  return lines.join('\n');
}

function catalogueLine(args: {
  key: string;
  blurb: string;
  path: string;
  sizeBytes: number | null;
}): string {
  // `sizeHint` already provides its own parentheses around 'empty',
  // so we wrap the formatted byte count separately and leave 'empty'
  // bare to avoid `((empty))`.
  const sizeHint =
    args.sizeBytes === null || args.sizeBytes === 0
      ? 'empty'
      : formatBytes(args.sizeBytes);
  return `- **${args.key}** — ${args.blurb} (${sizeHint}). Load with: \`read("${args.path}")\`.`;
}

function safeSize(file: string): number | null {
  if (!existsSync(file)) return null;
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}
