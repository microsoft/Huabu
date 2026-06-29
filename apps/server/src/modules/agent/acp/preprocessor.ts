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
 * The per-turn wire text is built **inline as XML** (`<selected_nodes>`,
 * `<canvas_neighbourhood>`, `<attachments>`, `<user_request>`) — the same
 * tag vocabulary the built-in agent emits (`buildContextSections` in
 * `context/render-turn.ts`), so both backends present one structure. On
 * the first turn of a freshly-created session the one-shot persona +
 * `## Canvas Tools (Reachback)` preamble (`system_prompt.md`, rendered
 * via {@link renderPromptFile}) is prepended in front of it. The
 * per-node table rows are assembled here in TS and wrapped in the
 * `<selected_nodes>` tag.
 *
 * Failure model: this builder does no network/LLM I/O and effectively
 * cannot fail, but callers still `try`/`catch` and fall back to the raw
 * user text via {@link serializeRawPrompt} for safety. The route-level
 * service emits a `prepared_prompt` SSE event so the UI can render the
 * PreparedPromptCard.
 */

import { renderPromptFile } from '../../../prompt/index.js';
import { ACP_PROFILE, ACP_SLASH_PROFILE } from '../context/render/profile.js';
import { renderTurn } from '../context/render-turn.js';

import type { ChatEnvelope } from '../context/envelope.js';
import type { ContentPart } from '../context/render/attachments.js';
import type { FastifyBaseLogger } from 'fastify';

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * Pattern for the slash-command lead-with-task path (see
 * {@link prepareExternalAgentPrompt}). Matches `/<name>` followed by
 * whitespace OR end of string. The leading character class is ASCII
 * letters only so URLs / Windows paths pasted mid-thought don't trip
 * it. Exported for tests.
 */
export const SLASH_COMMAND_RE = /^\/[a-zA-Z][\w-]*(?:\s|$)/;

/**
 * PROMPT_ROOT-relative path of the one-shot system preamble template
 * (persona + canvas-tool docs). Prepended to the first user prompt of a
 * freshly-created session — see {@link PreparePromptInput.includeSystem}.
 */
const SYSTEM_TEMPLATE = 'external-agent/system_prompt.md';

// ─── Public API ───────────────────────────────────────────────────────────

export interface PreparePromptInput {
  /**
   * This turn's structured envelope — the single source of truth for
   * the user's text, node selection, and neighbourhood. The ACP
   * serializer reads from it exactly as the built-in serializer
   * (`renderEnvelopeMessages`) does, so the two backends cannot drift:
   * any field added to the envelope is available to both without
   * per-field plumbing through the dispatch layers.
   */
  envelope: ChatEnvelope;
  /** Short alias of the bound external agent (e.g. `'claude'`). */
  agentAlias: string;
  /**
   * Canvas the turn was sent from, used to resolve relative image URLs
   * to base64 vision bytes (mirrors the built-in agent's image inlining).
   * `null` when off-canvas.
   */
  canvasId?: string | null;
  /**
   * Prepend the one-shot system preamble (persona + canvas-tool docs,
   * from `external-agent/system_prompt.md`) to this turn's prompt. Set
   * by the service layer for the FIRST user turn of a freshly-created
   * session and never again (the agent keeps it in context); see
   * `AcpSessionEntry.systemPreambleSent`. Ignored for slash-command
   * turns, where the command must lead verbatim.
   */
  includeSystem?: boolean;
  logger: FastifyBaseLogger;
}

export interface PreparePromptResult {
  /**
   * The plain-text payload Sediment actually hands to ACP
   * `session/prompt`. Built by joining the text parts of
   * {@link renderTurn} so server, log, and external agent all see the
   * same wording.
   */
  serialized: string;
  /**
   * Whether the system preamble was prepended to this payload. to this payload. The service layer flips
   * `AcpSessionEntry.systemPreambleSent` to `true` only when this is
   * `true` and the turn succeeds — so a slash-command turn
   * (always `false`) or a failed turn re-sends the preamble next time.
   */
  includedSystem: boolean;
  /**
   * The generic per-turn content blocks (text + base64 image parts) sent
   * over ACP `session/prompt`. Mapped 1:1 to ACP content blocks by the
   * client — the same `renderTurn` output the built-in agent uses, plus
   * the one-shot preamble as a leading text block on the first turn. Not
   * persisted (images would bloat history) — re-resolved per turn.
   */
  blocks: ContentPart[];
}

/**
 * Build the {@link ExternalAgentPrompt} deterministically from the raw
 * user message + node selection. Synchronous and free of network/LLM
 * I/O (it only reads the on-disk prompt template).
 */
export async function prepareExternalAgentPrompt(
  input: PreparePromptInput,
): Promise<PreparePromptResult> {
  const { envelope, agentAlias, includeSystem, logger } = input;
  const canvasId = input.canvasId ?? null;
  // Verbatim user words — the ACP `task`. Sourced from the envelope so
  // it matches what the built-in path renders. The built-in path may
  // append an LLM-only sketch-raster hint that references built-in-only
  // tools (`snapshot_nodes` / `generate_image`); that hint is
  // intentionally absent here, as external agents fetch node content via
  // reachback instead.
  const rawText = envelope.user.text;
  // ── Slash-command detection ────────────────────────────────────────
  //
  // ACP agents recognise slash commands (`/<name> <args>`) natively, but
  // ONLY when the command leads the prompt text. So we never wrap a slash
  // command in our scaffolding *before* it: the command stays verbatim on
  // the first line and any supplementary context (selected nodes,
  // neighbourhood, attachments) is appended AFTER it. We also skip the
  // one-shot system preamble here so it isn't pushed in front of the
  // command — it stays unsent and the next real turn delivers it.
  const isSlashCommand = SLASH_COMMAND_RE.test(rawText.trim());
  if (isSlashCommand) {
    logger.debug(
      { agentAlias, command: rawText.trim().split(/\s+/)[0] },
      '[acp/preprocessor] slash command detected — leading verbatim, context appended',
    );
  }
  const effectiveIncludeSystem = isSlashCommand ? false : !!includeSystem;

  // Wire body: the SAME renderTurn the built-in agent uses, with the ACP
  // profile (read-node verb, no `file=`, selection visuals on, slash
  // leads). Text parts join to the serialized payload; image parts ride
  // as base64 vision blocks. Both backends now share one composer.
  const parts = await renderTurn(
    envelope,
    isSlashCommand ? ACP_SLASH_PROFILE : ACP_PROFILE,
    { canvasId },
  );
  // First turn of a fresh session: lead with the persona preamble as a
  // text block. The serialized mirror (text only) is for dump/log.
  const blocks: ContentPart[] = effectiveIncludeSystem
    ? [{ type: 'text', text: renderSystemPreamble() }, ...parts]
    : parts;
  const body = parts
    .filter(
      (p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text',
    )
    .map((p) => p.text)
    .join('\n');
  const serialized = effectiveIncludeSystem
    ? `${renderSystemPreamble()}\n\n${body}`
    : body;

  // Display model for the prepared-prompt card — projected from the SAME
  // envelope as the built-in agent's user-message chips, plus the ACP
  // preamble on the first turn. The card and bubble cannot drift.
  logger.debug(
    { agentAlias, taskLength: rawText.trim().length },
    '[acp/preprocessor] prepared prompt',
  );

  return {
    serialized,
    includedSystem: effectiveIncludeSystem,
    blocks,
  };
}

/**
 * Render the one-shot system preamble (persona + `## Canvas Tools
 * (Reachback)` docs) from {@link SYSTEM_TEMPLATE}. Prepended to the
 * serialized wire text (and attached to the structured prompt so the UI
 * can show the complete prompt) only on the first turn of a fresh
 * session. Static — no template variables.
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
