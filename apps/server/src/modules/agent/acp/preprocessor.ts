/**
 * ACP Preprocessor — deterministic prompt builder.
 *
 * The external agent (Claude Code, Copilot CLI, …) **never sees the
 * canvas** directly. This module turns the raw user message plus the
 * user's node selection into an {@link ExternalAgentPrompt} *without
 * any LLM call*:
 *
 *   - `task` is the user's message forwarded **verbatim**.
 *   - `selectedNodes` is a metadata-only table (node ID + type +
 *     label) of whatever the user had selected. Content is **not**
 *     inlined and files are **not** attached — the external agent
 *     pulls node bodies on demand through the Huabu Sideband Tool
 *     (`read-node <node-id>`), documented in the serialized prompt's
 *     `## Canvas Tools (Sideband)` section.
 *
 * Why deterministic instead of a preprocessor sub-agent:
 *   - An earlier design ran a dedicated `acp-preprocessor` LLM that
 *     explored the canvas (read-only tools) and synthesised a briefing.
 *     That paid an extra model round-trip on every turn, added latency,
 *     was non-deterministic, and could fail to emit valid JSON. Since
 *     the sideband tool already lets the external agent fetch node
 *     content by ID, all we need to hand it deterministically is the
 *     user's words + the IDs of what they selected.
 *
 * The serialized wire text is rendered from the standalone template
 * `prompt/external-agent/prompt.md` via {@link renderPromptFile}; the
 * per-node table rows are assembled here in TS (the in-house template
 * engine has no loops) and injected as a single variable.
 *
 * Failure model: this builder does no network/LLM I/O and effectively
 * cannot fail, but callers still `try`/`catch` and fall back to the raw
 * user text via {@link serializeRawPrompt} for safety. The route-level
 * service emits a `prepared_prompt` SSE event so the UI can render the
 * PreparedPromptCard.
 */

import { renderPromptFile } from '../../../prompt/index.js';
import { buildAgentNodeRef } from '../node-ref.js';

import type { AgentNodeRef } from '../node-ref.js';
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

/** PROMPT_ROOT-relative path of the external-agent prompt template. */
const PROMPT_TEMPLATE = 'external-agent/prompt.md';

// ─── Public API ───────────────────────────────────────────────────────────

export interface PreparePromptInput {
  /** Raw user text Sediment is about to send via ACP `session/prompt`. */
  rawText: string;
  /** Short alias of the bound external agent (e.g. `'claude'`). */
  agentAlias: string;
  /** Canvas chat context for this turn (may be omitted when client didn't send one). */
  canvasContext?: AgentChatContext;
  /**
   * Sediment canvasId for the current thread. Used only to gate the
   * `## Canvas Tools (Sideband)` section: the Huabu Sideband Tool is
   * only reachable when the thread is bound to a canvas. Omit for the
   * no-canvas edge case — the agent then gets `task` + selected-node
   * metadata but no sideband instructions.
   */
  canvasId?: string;
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
 * Build the {@link ExternalAgentPrompt} deterministically from the raw
 * user message + node selection. Synchronous and free of network/LLM
 * I/O (it only reads the on-disk prompt template).
 */
export function prepareExternalAgentPrompt(
  input: PreparePromptInput,
): PreparePromptResult {
  const { rawText, agentAlias, canvasContext, canvasId, logger } = input;

  // ── Slash-command short-circuit ────────────────────────────────────
  //
  // ACP agents recognise slash commands (`/<name> <args>`) natively
  // inside `session/prompt` text. Wrapping them in our `## Selected
  // Nodes` / sideband scaffolding could corrupt that wire format, so
  // when the raw user input starts with a slash command we forward it
  // verbatim with no extra sections.
  if (SLASH_COMMAND_RE.test(rawText.trim())) {
    const trimmed = rawText.trim();
    logger.debug(
      { agentAlias, command: trimmed.split(/\s+/)[0] },
      '[acp/preprocessor] slash command detected — forwarding verbatim',
    );
    return {
      prompt: { task: trimmed, selectedNodes: [] },
      serialized: trimmed,
    };
  }

  const selectedRefs = canvasContext?.selectedNodes
    ? flattenSelection(canvasContext.selectedNodes)
    : [];

  const prompt: ExternalAgentPrompt = {
    task: rawText.trim(),
    selectedNodes: selectedRefs.map((ref) => ({
      nodeId: ref.id,
      type: ref.type,
      ...(ref.label ? { label: ref.label } : {}),
    })),
  };

  logger.debug(
    {
      agentAlias,
      taskLength: prompt.task.length,
      selectedNodesCount: prompt.selectedNodes.length,
    },
    '[acp/preprocessor] prepared prompt',
  );

  return {
    prompt,
    serialized: serializePrompt(prompt, { sidebandEnabled: !!canvasId }),
  };
}

/**
 * Convert an {@link ExternalAgentPrompt} into the plain-text payload
 * sent over ACP `session/prompt`, rendering the standalone template at
 * {@link PROMPT_TEMPLATE}.
 *
 * The template emits the verbatim `task`, an optional `## Selected
 * Nodes` table (IDs / types / labels of the selected nodes so the
 * agent can read or update them by ID) and an optional `## Canvas
 * Tools (Sideband)` section (gated by `sidebandEnabled`) documenting
 * the Huabu Sideband Tool. The whole markdown table is assembled here
 * and injected as `selectedNodesTable` because the template engine has
 * no loop construct.
 */
export function serializePrompt(
  prompt: ExternalAgentPrompt,
  opts: { sidebandEnabled?: boolean } = {},
): string {
  const hasNodes = prompt.selectedNodes.length > 0;
  const sideband = !!opts.sidebandEnabled;

  // The full markdown table (header + separator + rows) is assembled
  // here rather than in the template: the in-house engine has no loop
  // construct, and keeping the table out of the `.md` also stops the
  // markdown formatter from reflowing / splitting it on save.
  const selectedNodesTable = hasNodes
    ? [
        '| Node ID | Type | Label |',
        '| --- | --- | --- |',
        ...prompt.selectedNodes.map((node) => {
          const label = node.label ? escapeCell(node.label) : '—';
          return `| \`${node.nodeId}\` | ${node.type} | ${label} |`;
        }),
      ].join('\n')
    : '';

  const selectedNodesIntro = sideband
    ? 'The user selected the canvas nodes below. Read any you need with the Huabu Sideband Tool (`read-node <node-id>`); update them with `write-node --id <node-id>`.'
    : 'The user selected the canvas nodes below.';

  return renderPromptFile(PROMPT_TEMPLATE, {
    task: prompt.task.trim(),
    // Conditional-block flags: any non-empty string keeps the block.
    selectedNodes: hasNodes ? '1' : '',
    sideband: sideband ? '1' : '',
    selectedNodesIntro,
    selectedNodesTable,
  });
}

/**
 * Fallback used when the caller decides to bypass the structured
 * prompt: just hand the raw user text straight through. Kept here so
 * the route layer doesn't have to know about the prompt shape.
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

/** Escape pipe / newline chars so a label can't break the markdown table. */
function escapeCell(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}
