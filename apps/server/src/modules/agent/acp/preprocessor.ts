/**
 * ACP Preprocessor — intent translator.
 *
 * The external agent (Claude Code, Copilot CLI, …) **never sees the
 * canvas**. This module runs the dedicated `acp-preprocessor` agent
 * (see `prompt/agents/acp-preprocessor/AGENT.md`) which receives the
 * user's raw message + the selected-node refs, decides whether to
 * explore the canvas via its read-only tool surface
 * (`get_canvas_outline` / `inspect_nodes` / `inspect_edges` / `read`
 * / `grep` / `find` / `ls`), and emits an {@link ExternalAgentPrompt}:
 * a self-contained `task` briefing the external agent can act on with
 * no other context, plus a small `attachments` list reserved for
 * cases where verbatim file access is essential.
 *
 * Why a sub-agent instead of a one-shot LLM call:
 *   - The preprocessor used to inline a fixed-size slice of every
 *     selected node's body (≤ 16 KB). That ignored the spatial /
 *     edge context and forced the route to pay the cost of every
 *     selected node even when the user's intent didn't actually
 *     need it. Pushing the decision into the agent lets it skip
 *     reads for trivial turns and dig deeper (read neighbours,
 *     grep across nodes) when the user's request demands it.
 *   - The system prompt now lives alongside every other agent in
 *     `prompt/agents/<id>/AGENT.md` and reuses the canvas SKILL
 *     verbatim via `{{include:skills/canvas/SKILL.md}}` — no more
 *     copy-paste drift between the preprocessor's mental model and
 *     the read-only canvas tooling.
 *
 * Verbatim reading is still a fallback (e.g. "review this code",
 * binary artifacts, oversize nodes). The agent's prompt explains
 * when to attach vs. synthesise; {@link parsePromptJson} validates
 * the resulting paths against the known canvas surface.
 *
 * Attachments render as absolute disk paths so OS-native `Read`
 * tools (Copilot CLI) and ACP-fs-bridging agents (Claude Code) both
 * reach the file. See {@link serializePrompt} for the wire-format
 * trade-off.
 *
 * Failure model: callers `try`/`catch` and fall back to the raw user
 * text. The route-level service emits a `prepared_prompt` SSE event
 * with `prompt: null` + an `error` description so the UI can replace
 * its "Preparing…" placeholder with a visible failure note.
 */

import path from 'node:path';

import { loadAgent } from '../../../prompt/agents/loader.js';
import { runAgent } from '../agent.service.js';
import { buildAgentNodeRef } from '../node-ref.js';
import { ACP_CANVAS_VFS_PREFIX } from './capabilities/fs.js';

import type { AgentNodeRef } from '../node-ref.js';
import type {
  AssistantMessage,
  Context,
  TextContent,
} from '@earendil-works/pi-ai';
import type {
  AgentChatContext,
  ExternalAgentPrompt,
  WireSelectionNode,
} from '@sediment/shared';
import type { FastifyBaseLogger } from 'fastify';

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * Pattern for the slash-command short-circuit (see
 * {@link prepareExternalAgentPrompt}). Matches `/<name>` followed by
 * whitespace OR end of string. The leading character class is ASCII
 * letters only so URLs / Windows paths pasted mid-thought don't trip
 * it. Exported for tests.
 */
export const SLASH_COMMAND_RE = /^\/[a-zA-Z][\w-]*(?:\s|$)/;

// ─── Public API ───────────────────────────────────────────────────────────

export interface PreparePromptInput {
  /** Raw user text Sediment is about to send via ACP `session/prompt`. */
  rawText: string;
  /** Short alias of the bound external agent (e.g. `'claude'`). */
  agentAlias: string;
  /** Canvas chat context for this turn (may be omitted when client didn't send one). */
  canvasContext?: AgentChatContext;
  /**
   * Sediment canvasId for the current thread. Forwarded to
   * `runAgent` so the preprocessor's read-only canvas tools
   * (`get_canvas_outline`, `inspect_nodes`, `read`, …) resolve
   * against the correct canvas root. Omit only for the no-canvas
   * edge case — the agent then runs without canvas tooling and is
   * limited to whatever it can synthesise from `rawMessage` alone.
   */
  canvasId?: string;
  /**
   * Absolute on-disk path of the canvas directory. When supplied,
   * {@link serializePrompt} renders `attachments[].path` as **real
   * absolute on-disk paths** under this root so OS-native `Read`
   * tools (Copilot CLI) and ACP-fs-bridging agents (Claude Code)
   * both reach the file. When omitted (no-canvas edge case),
   * `serializePrompt` falls back to the `/canvas/<rel>` virtual
   * prefix. In practice service.ts always supplies `canvasRoot`.
   */
  canvasRoot?: string;
  logger: FastifyBaseLogger;
}

export interface PreparePromptResult {
  /** Structured prompt the UI renders and the history persists. */
  prompt: ExternalAgentPrompt;
  /**
   * The plain-text payload Sediment actually hands to ACP
   * `session/prompt`. Derived from `prompt` via {@link serializePrompt}
   * so server, log, and external agent all see the same wording.
   */
  serialized: string;
}

/**
 * Run the preprocessor sub-agent. Throws on network / parse / shape
 * errors; callers should catch and fall back to
 * {@link serializeRawPrompt}.
 */
export async function prepareExternalAgentPrompt(
  input: PreparePromptInput,
): Promise<PreparePromptResult> {
  const { rawText, agentAlias, canvasContext, canvasId, canvasRoot, logger } =
    input;

  // ── Slash-command short-circuit ────────────────────────────────────
  //
  // ACP agents recognise slash commands (`/<name> <args>`) natively
  // inside `session/prompt` text. The intent-translator LLM rewrites
  // would corrupt that wire format — e.g. wrap `/compact` in prose,
  // strip the leading `/`, or attach noise. When the raw user input
  // starts with a slash command we forward it verbatim and skip the
  // sub-agent run entirely. Cheaper AND correct.
  //
  // Match rule: starts with `/`, followed by an ASCII letter and zero
  // or more word/dash chars, then whitespace OR end of input. Avoids
  // false positives for forward-slashes inside URLs / paths the user
  // might paste mid-sentence.
  if (SLASH_COMMAND_RE.test(rawText.trim())) {
    const trimmed = rawText.trim();
    logger.debug(
      { agentAlias, command: trimmed.split(/\s+/)[0] },
      '[acp/preprocessor] slash command detected — forwarding verbatim',
    );
    return {
      // Surface as a minimal ExternalAgentPrompt so the UI's
      // PreparedPromptCard still has something to render. No
      // attachments by design — slash commands speak for themselves.
      prompt: { task: trimmed, attachments: [] },
      serialized: trimmed,
    };
  }

  const selectedRefs = canvasContext?.selectedNodes
    ? flattenSelection(canvasContext.selectedNodes)
    : [];

  // Build the input the agent receives. Note we deliberately pass
  // only the *refs* (id + filename + label + type) and not the body:
  // the agent decides per-turn whether it needs the content and uses
  // its `read` tool to fetch it. This replaces the old "always inline
  // every selected body up to 16 KB" heuristic and lets trivial turns
  // (general questions, slash-style commands the LLM rewrites) skip
  // the read cost entirely.
  const userPayload = {
    rawMessage: rawText,
    agentAlias,
    selectedNodes: selectedRefs.map((ref) => ({
      id: ref.id,
      type: ref.type,
      ...(ref.label ? { label: ref.label } : {}),
      filename: ref.filename,
    })),
  };

  const cfg = loadAgent('acp-preprocessor');

  // Isolated context — the preprocessor must NEVER share state with
  // the main ACP thread's `context.messages`. `runAgent` mutates the
  // context in place (replaces its messages with the agent's final
  // transcript); keeping it scoped here means the only thing that
  // escapes is the parsed JSON we return.
  const piContext: Context = {
    systemPrompt: cfg.systemPrompt,
    messages: [
      {
        role: 'user',
        content: JSON.stringify(userPayload, null, 2),
        timestamp: Date.now(),
      },
    ],
  };

  // Drive the sub-agent loop. We discard every stream event — the UI
  // never sees the preprocessor's intermediate tool calls or partial
  // text; it only sees the final `prepared_prompt` SSE that
  // service.ts emits after we return. `FastifyBaseLogger.info`
  // satisfies the `AgentLogger` shape (single-string form).
  for await (const _ev of runAgent({
    scope: 'acp-preprocessor',
    canvasId,
    context: piContext,
    logger: { info: (msg) => logger.info(msg) },
    maxIterations: cfg.runtime.maxIterations,
  })) {
    // Intentionally empty: drain to completion.
  }

  // Extract the final assistant text from the mutated context. The
  // agent's final turn must emit the ExternalAgentPrompt JSON
  // envelope as a plain text message (see AGENT.md for the rule);
  // any tool-call-only or empty assistant message is a contract
  // violation and falls through to the parse-error branch below.
  const lastAssistant = [...piContext.messages]
    .reverse()
    .find((m): m is AssistantMessage => m.role === 'assistant');
  const raw = lastAssistant
    ? lastAssistant.content
        .filter((b): b is TextContent => b.type === 'text')
        .map((b) => b.text)
        .join('')
    : '';

  const prompt = parsePromptJson(raw, selectedRefs);
  if (!prompt) {
    throw new Error(
      '[acp/preprocessor] agent response was not valid ExternalAgentPrompt JSON',
    );
  }

  logger.debug(
    {
      agentAlias,
      taskLength: prompt.task.length,
      attachmentsCount: prompt.attachments.length,
    },
    '[acp/preprocessor] prepared prompt',
  );

  return {
    prompt,
    serialized: serializePrompt(prompt, { canvasRoot, sidebandEnabled: !!canvasId }),
  };
}

/**
 * Convert an {@link ExternalAgentPrompt} into the plain-text payload
 * sent over ACP `session/prompt`. Format is deliberately simple
 * markdown so any agent's text rendering picks it up cleanly.
 *
 * Most turns should produce **just `task`** — the intent-translator
 * design synthesises selected-node content inline. The optional
 * `## Attachments` section is rendered only when the preprocessor
 * decided verbatim access is essential (large nodes, code-review
 * asks, `.artifacts/` files).
 *
 * Path rendering is **gated by `canvasRoot`** because not every agent
 * honours ACP's `fs/read_text_file` capability:
 *
 *   - **With `canvasRoot`** (normal case): each `attachments[].path`
 *     is joined onto `canvasRoot` to produce a real absolute on-disk
 *     path (e.g. `/home/me/sediment-data/huabu/<dir>/nodes/foo.md`).
 *     Empirically Copilot CLI's `Read` tool **never** calls
 *     `fs/read_text_file` — it always uses the OS directly (and asks
 *     `session/request_permission` for paths outside its trusted
 *     dirs). Feeding it absolute paths is the only way it can reach
 *     canvas content. Spec-compliant agents (Claude Code) read those
 *     same absolute paths fine via either channel.
 *
 *   - **Without `canvasRoot`** (no-canvas edge case): paths are
 *     rendered under the virtual prefix `/canvas/<rel>` so agents
 *     that DO route Read through ACP fs hit the `fs/read_text_file`
 *     handler in `acp/capabilities/fs.ts`. Reserved for threads
 *     without a bound canvas; in practice service.ts always supplies
 *     `canvasRoot`.
 *
 * Trade-off: the absolute-path mode effectively re-extends the
 * agent's OS reach into the canvas dir, so the `/canvas/` VFS
 * sandbox is **bypassed** by native-fs agents — they read canvas
 * files directly via syscall and the allowlist in
 * `acp/capabilities/fs.ts` never gets a chance to refuse. Real
 * isolation against an adversarial agent would require OS-level
 * sandboxing (FUSE / containers); ACP fs capabilities alone are a
 * cooperative protocol.
 *
 * Either way `attachments[].path` itself stays canvas-relative so
 * storage / UI / future internal consumers stay free of wire concerns.
 */
export function serializePrompt(
  prompt: ExternalAgentPrompt,
  opts: { canvasRoot?: string; sidebandEnabled?: boolean } = {},
): string {
  const lines: string[] = [prompt.task.trim()];
  if (prompt.attachments.length > 0) {
    lines.push('', '## Attachments', '');
    lines.push(
      'Read each file below before answering — they were attached because verbatim content is required:',
      '',
    );
    for (const ref of prompt.attachments) {
      const wirePath = opts.canvasRoot
        ? path.join(opts.canvasRoot, ref.path)
        : `${ACP_CANVAS_VFS_PREFIX}${ref.path}`;
      const nodeHint =
        opts.sidebandEnabled && ref.nodeId
          ? ` (node ID: \`${ref.nodeId}\`)`
          : '';
      lines.push(`- \`${wirePath}\`${nodeHint} — ${ref.reason}`);
    }
  }
  if (opts.sidebandEnabled) {
    lines.push('', '## Canvas Tools (Sideband)', '');
    lines.push(
      'You have the Huabu Sideband Tool (HST) available for reading/writing canvas nodes and querying the built-in agent.',
      '',
      'Usage: `node ${AGENTLET_SIDEBAND_DIR}/huabu-sideband-tool.mjs <command> [args...]`',
      '',
      'Commands:',
      '- `read-node <node-id>` — Download a node\'s content to a local file, prints file path to stdout',
      '- `write-node --type <type> <content-file>` — Create a new canvas node from a file',
      '- `write-node --id <node-id> <content-file>` — Update an existing node from a file',
      '- `ask-agent "<prompt>"` — Ask the built-in canvas agent a question (supports complex reasoning, spatial queries, multi-node operations)',
      '',
      'Run with `--help` for full usage details on each command.',
    );
  }
  return lines.join('\n');
}

/**
 * Fallback used when the preprocessor throws: just hand the raw user
 * text straight through. Kept here so the route layer doesn't have to
 * know about the prompt shape.
 */
export function serializeRawPrompt(rawText: string): string {
  return rawText;
}

// ─── Internals ────────────────────────────────────────────────────────────

/** Flatten the wire selection (frame children included) into AgentNodeRefs. */
function flattenSelection(nodes: WireSelectionNode[]): AgentNodeRef[] {
  const refs: AgentNodeRef[] = [];
  const walk = (list: WireSelectionNode[]) => {
    for (const n of list) {
      refs.push(buildAgentNodeRef({ id: n.id, type: n.type, label: n.label }));
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return refs;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Parse the LLM's JSON output into an ExternalAgentPrompt, clipping
 * malformed entries. Returns `null` if the JSON itself is unusable.
 * `selectedRefs` is used to validate `attachments[].path` against the
 * known canvas surface (selected node filenames + a small allowlist).
 */
function parsePromptJson(
  raw: string,
  selectedRefs: AgentNodeRef[],
): ExternalAgentPrompt | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const task = typeof obj.task === 'string' ? obj.task.trim() : '';
  if (!task) return null;

  const knownPaths = new Set<string>(selectedRefs.map((r) => r.filename));
  const pathToNodeId = new Map<string, string>(
    selectedRefs.map((r) => [r.filename, r.id]),
  );

  const rawRefs = Array.isArray(obj.attachments) ? obj.attachments : [];
  const attachments: ExternalAgentPrompt['attachments'] = [];
  for (const r of rawRefs) {
    if (!r || typeof r !== 'object') continue;
    const ref = r as Record<string, unknown>;
    const refPath = typeof ref.path === 'string' ? ref.path.trim() : '';
    if (!refPath) continue;
    // Allowlist mirrors the runtime fs/read_text_file handler
    // (`capabilities/fs.ts:isAllowedRead`): only canvas nodes and
    // artifact files. canvas.json is intentionally excluded — the
    // canvas structure was already synthesised into `task`.
    const allowed =
      knownPaths.has(refPath) ||
      refPath.startsWith('nodes/') ||
      refPath.startsWith('.artifacts/');
    if (!allowed) continue;
    const rawReason = typeof ref.reason === 'string' ? ref.reason.trim() : '';
    attachments.push({
      path: refPath,
      reason: rawReason ? truncate(rawReason, 80) : 'verbatim content required',
      ...(pathToNodeId.has(refPath) ? { nodeId: pathToNodeId.get(refPath) } : {}),
    });
    if (attachments.length >= 8) break;
  }

  return { task, attachments };
}
