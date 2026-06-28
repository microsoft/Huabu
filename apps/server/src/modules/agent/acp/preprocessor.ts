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
 * `context/chat-turn.ts`), so both backends present one structure. On
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
import { renderAgentNodeList } from '../node-ref.js';

import type { ChatEnvelope } from '../context/envelope.js';
import type { ChatAttachment, ExternalAgentPrompt } from '@sediment/shared';
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
  const { envelope, agentAlias, includeSystem, logger } = input;
  // Verbatim user words — the ACP `task`. Sourced from the envelope so
  // it matches what the built-in path renders. The built-in path may
  // append an LLM-only sketch-raster hint that references built-in-only
  // tools (`snapshot_nodes` / `generate_image`); that hint is
  // intentionally absent here, as external agents fetch node content via
  // reachback instead.
  const rawText = envelope.user.text;
  // ── Slash-command short-circuit ────────────────────────────────────
  //
  // ACP agents recognise slash commands (`/<name> <args>`) natively
  // inside `session/prompt` text. Wrapping them in our `<selected_nodes>`
  // / preamble scaffolding could corrupt that wire format, so
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

  // Already-derived selection refs (frame children included) and
  // neighbourhood markdown — read straight from the envelope rather than
  // re-deriving from the raw wire selection, so ACP and the built-in
  // agent observe the identical set by construction.
  const selectedRefs = envelope.focus.selection.refs;
  const neighbourhood = envelope.preamble.nodeNeighbourhood;
  // Off-canvas uploads the user attached to this turn. They are NOT on
  // the canvas, so the external agent cannot reach them via `read-node`;
  // their textual content is inlined into the prompt instead. (Selection
  // image / snapshot attachments are deliberately excluded — those are
  // canvas nodes the agent fetches through reachback.)
  const attachments = buildAcpAttachments(envelope.user.attachments);

  const prompt: ExternalAgentPrompt = {
    task: rawText.trim(),
    selectedNodes: selectedRefs.map((ref) => ({
      nodeId: ref.id,
      type: ref.type,
      ...(ref.label ? { label: ref.label } : {}),
      // `preview` rides along (same server-side ladder as the built-in
      // agent); `filename` is intentionally NOT forwarded — the external
      // agent reads by id via `read-node`, so the virtual path would be a
      // dead reference.
      ...(ref.preview ? { preview: ref.preview } : {}),
    })),
    // Canvas neighbourhood (spatial context around an anchor node) when
    // the turn carried one — same source as the built-in agent's
    // node-neighbourhood preamble, so both backends agree.
    ...(neighbourhood ? { neighbourhood } : {}),
    // Off-canvas attachment text (uploads / web captures) that the agent
    // cannot otherwise see, since it has no canvas access for them.
    ...(attachments.length > 0 ? { attachments } : {}),
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
 * The per-turn body is built inline as XML — the SAME tag vocabulary
 * (`<selected_nodes>`, `<canvas_neighbourhood>`, `<attachments>`,
 * `<user_request>`) the built-in agent emits (`buildContextSections` in
 * `context/chat-turn.ts`), with the user's words LAST — so a reader
 * (human or model) sees one structure across both backends. A bare task
 * (no context sections) is sent unwrapped, mirroring the built-in
 * plain-text fast path. The inner guidance legitimately differs:
 * external agents read / write nodes through the Huabu Reachback Tool
 * (`read-node` / `write-node`) rather than the built-in `read()` over a
 * pre-computed `filename`. Off-canvas uploads, which the agent cannot
 * reach via `read-node`, are inlined under `<attachments>`.
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
  const sections: string[] = [];

  if (prompt.selectedNodes.length > 0) {
    // Rendered through the SAME `renderAgentNodeList` the built-in agent
    // uses, so the two backends present one `<node>` shape. `file` is
    // omitted here: the external agent reads by id (`read-node <id>`).
    const nodeList = renderAgentNodeList(
      prompt.selectedNodes.map((node) => ({
        id: node.nodeId,
        type: node.type,
        label: node.label,
        preview: node.preview,
      })),
      { includeFile: false },
    );
    sections.push(
      [
        '<selected_nodes>',
        'The user selected the canvas nodes below. Each <node> is metadata only: read any you need with the Huabu Reachback Tool (`read-node <node-id>`); update them with `write-node --id <node-id>`. `preview` is a short scan hint, not the full content.',
        nodeList,
        '</selected_nodes>',
      ].join('\n'),
    );
  }

  if (prompt.neighbourhood) {
    sections.push(
      [
        '<canvas_neighbourhood>',
        'The request was anchored at a specific node on the canvas. Use this neighbourhood to disambiguate references like "this" or "the one above", and to choose sensible positions when creating nodes nearby.',
        prompt.neighbourhood,
        '</canvas_neighbourhood>',
      ].join('\n'),
    );
  }

  if (prompt.attachments && prompt.attachments.length > 0) {
    // Each attachment is wrapped in its own `<attachment>` tag (mirroring
    // the built-in agent's `<attachment>` items) so multiple bodies stay
    // unambiguously separated; the whole group is bounded by
    // `<attachments>`.
    const items = prompt.attachments
      .map((att) => {
        const attrs = [
          `type="${escapeAttr(att.type)}"`,
          att.label ? `name="${escapeAttr(att.label)}"` : '',
          att.url ? `url="${escapeAttr(att.url)}"` : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `<attachment ${attrs}>\n${att.content}\n</attachment>`;
      })
      .join('\n');
    sections.push(
      [
        '<attachments>',
        'The user attached the content below directly. It is NOT on the canvas, so you cannot fetch it with `read-node` — use it as given.',
        items,
        '</attachments>',
      ].join('\n'),
    );
  }

  // The user's own words come LAST, mirroring the built-in layout. With
  // no context sections, send the bare task — symmetric with the
  // built-in plain-text fast path (no XML scaffolding for the common
  // case).
  const task = prompt.task.trim();
  const userBlock =
    sections.length > 0
      ? [...sections, `<user_request>\n${task}\n</user_request>`].join('\n')
      : task;

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
/**
 * Project the turn's off-canvas uploads into the structured prompt's
 * `attachments`. Text-bearing attachments forward their content
 * verbatim; an image upload — which cannot travel over the text-only
 * ACP wire — is reduced to a short locator note so the agent at least
 * knows it exists. Content-less, URL-only attachments forward their
 * source URL. Empty attachments (no content, no url) are dropped.
 */
function buildAcpAttachments(
  atts: ChatAttachment[],
): NonNullable<ExternalAgentPrompt['attachments']> {
  const out: NonNullable<ExternalAgentPrompt['attachments']> = [];
  for (const att of atts) {
    const label = att.label ?? att.filename;
    const base = {
      type: att.type,
      ...(label ? { label } : {}),
      ...(att.url ? { url: att.url } : {}),
    };
    const text = att.content?.trim();
    if (text) {
      out.push({ ...base, content: text });
    } else if (att.type === 'image') {
      out.push({
        ...base,
        content:
          '(image attachment — not visible to this agent; ask the user to describe it, or place it on the canvas to read via read-node)',
      });
    } else if (att.url) {
      out.push({ ...base, content: `(no inline content; source: ${att.url})` });
    }
  }
  return out;
}

/** Escape a string for safe inclusion in an XML attribute value. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, ' ')
    .trim();
}
