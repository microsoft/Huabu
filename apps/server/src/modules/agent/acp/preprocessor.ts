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
 *     pulls node bodies on demand through the Huabu Reachback Tool
 *     (`read-node <node-id>`), documented in the serialized prompt's
 *     `## Canvas Tools (Reachback)` section.
 *
 * Why deterministic instead of a preprocessor sub-agent:
 *   - An earlier design ran a dedicated `acp-preprocessor` LLM that
 *     explored the canvas (read-only tools) and synthesised a briefing.
 *     That paid an extra model round-trip on every turn, added latency,
 *     was non-deterministic, and could fail to emit valid JSON. Since
 *     the reachback tool already lets the external agent fetch node
 *     content by ID, all we need to hand it deterministically is the
 *     user's words + the IDs of what they selected.
 *
 * The serialized wire text is rendered from two standalone templates
 * under `prompt/external-agent/` via {@link renderPromptFile}:
 * `user_prompt.md` (the per-turn `task` + selected-node table) and, on
 * the first turn of a freshly-created session, `system_prompt.md` (the
 * one-shot persona + `## Canvas Tools (Reachback)` preamble) prepended in
 * front of it. The per-node table rows are assembled here in TS (the
 * in-house template engine has no loops) and injected as a single
 * variable.
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

/** PROMPT_ROOT-relative path of the per-turn user prompt template. */
const USER_TEMPLATE = 'external-agent/user_prompt.md';

/**
 * PROMPT_ROOT-relative path of the one-shot system preamble template
 * (persona + canvas-tool docs). Prepended to the first user prompt of a
 * freshly-created session — see {@link PreparePromptInput.includeSystem}.
 */
const SYSTEM_TEMPLATE = 'external-agent/system_prompt.md';

// ─── Public API ───────────────────────────────────────────────────────────

export interface PreparePromptInput {
  /** Raw user text Sediment is about to send via ACP `session/prompt`. */
  rawText: string;
  /** Short alias of the bound external agent (e.g. `'claude'`). */
  agentAlias: string;
  /** Canvas chat context for this turn (may be omitted when client didn't send one). */
  canvasContext?: AgentChatContext;
  /**
   * Prepend the one-shot system preamble (persona + canvas-tool docs,
   * from `external-agent/system_prompt.md`) to this turn's prompt. Set
   * by the service layer for the FIRST user turn of a freshly-created
   * session and never again (the agent keeps it in context); see
   * `AcpSessionEntry.systemPreambleSent`. Ignored for the slash-command
   * short-circuit, which forwards verbatim.
   */
  includeSystem?: boolean;
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
  /**
   * Whether {@link serializePrompt} actually prepended the system
   * preamble to this payload. The service layer flips
   * `AcpSessionEntry.systemPreambleSent` to `true` only when this is
   * `true` and the turn succeeds — so a slash-command short-circuit
   * (always `false`) or a failed turn re-sends the preamble next time.
   */
  includedSystem: boolean;
}

/**
 * Build the {@link ExternalAgentPrompt} deterministically from the raw
 * user message + node selection. Synchronous and free of network/LLM
 * I/O (it only reads the on-disk prompt template).
 */
export function prepareExternalAgentPrompt(
  input: PreparePromptInput,
): PreparePromptResult {
  const { rawText, agentAlias, canvasContext, includeSystem, logger } = input;

  // ── Slash-command short-circuit ────────────────────────────────────
  //
  // ACP agents recognise slash commands (`/<name> <args>`) natively
  // inside `session/prompt` text. Wrapping them in our `## Selected
  // Nodes` / preamble scaffolding could corrupt that wire format, so
  // when the raw user input starts with a slash command we forward it
  // verbatim with no extra sections (and no system preamble — it stays
  // unsent so the next real turn delivers it).
  if (SLASH_COMMAND_RE.test(rawText.trim())) {
    const trimmed = rawText.trim();
    logger.debug(
      { agentAlias, command: trimmed.split(/\s+/)[0] },
      '[acp/preprocessor] slash command detected — forwarding verbatim',
    );
    return {
      prompt: { task: trimmed, selectedNodes: [] },
      serialized: trimmed,
      includedSystem: false,
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
    // On the first turn of a fresh session we also carry the rendered
    // system preamble so the UI can show the complete prompt the agent
    // saw. The serialized wire text below prepends the same block.
    ...(includeSystem ? { systemPreamble: renderSystemPreamble() } : {}),
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
    serialized: serializePrompt(prompt, { includeSystem: !!includeSystem }),
    includedSystem: !!includeSystem,
  };
}

/**
 * Convert an {@link ExternalAgentPrompt} into the plain-text payload
 * sent over ACP `session/prompt`.
 *
 * The per-turn body is rendered from {@link USER_TEMPLATE}: the
 * verbatim `task` plus an optional `## Selected Nodes` table (IDs /
 * types / labels so the agent can read or update them by ID). The whole
 * markdown table is assembled here and injected as `selectedNodesTable`
 * because the in-house template engine has no loop construct.
 *
 * When `opts.includeSystem` is set, the one-shot system preamble
 * (persona + `## Canvas Tools (Reachback)` docs, from
 * {@link SYSTEM_TEMPLATE}) is rendered and prepended — used only for the
 * first user turn of a freshly-created session. The Huabu Reachback Tool
 * itself is pushed to every agentlet-backed agent unconditionally (see
 * `server-mount.ts` `pushReachbackTools`); the preamble just documents
 * how to call it, once.
 */
export function serializePrompt(
  prompt: ExternalAgentPrompt,
  opts: { includeSystem?: boolean } = {},
): string {
  const hasNodes = prompt.selectedNodes.length > 0;

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

  const userBlock = renderPromptFile(USER_TEMPLATE, {
    task: prompt.task.trim(),
    // Conditional-block flag: any non-empty string keeps the block.
    selectedNodes: hasNodes ? '1' : '',
    selectedNodesIntro:
      'The user selected the canvas nodes below. Read any you need with the Huabu Reachback Tool (`read-node <node-id>`); update them with `write-node --id <node-id>`.',
    selectedNodesTable,
  });

  if (!opts.includeSystem) return userBlock;

  const systemBlock = renderSystemPreamble();
  return `${systemBlock}\n\n${userBlock}`;
}

/**
 * Render the one-shot system preamble (persona + `## Canvas Tools
 * (Reachback)` docs) from {@link SYSTEM_TEMPLATE}. Shared by
 * {@link serializePrompt} (which prepends it to the wire text) and
 * {@link prepareExternalAgentPrompt} (which attaches it to the structured
 * prompt so the UI can show the complete prompt). Static — no template
 * variables.
 */
export function renderSystemPreamble(): string {
  return renderPromptFile(SYSTEM_TEMPLATE, {});
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
