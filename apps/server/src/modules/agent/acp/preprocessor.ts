// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * ACP Preprocessor — deterministic prompt builder.
 *
 * The external agent (Claude Agent, GitHub Copilot, …) **never sees the
 * canvas** directly. This module turns the raw user message plus the
 * user's node selection into an {@link ExternalAgentPrompt} *without
 * any LLM call*:
 *
 *   - `task` is the user's message forwarded **verbatim**.
 *   - `selectedNodes` is a metadata-only table (node ID + type +
 *     label) of whatever the user had selected. Content is **not**
 *     inlined and files are **not** attached — the external agent
 *     pulls node bodies on demand over the RFS
 *     (`GET ${HUABU_RFS_URL}/download/<file>`), documented in the
 *     canvas-access guide it fetches from `${HUABU_RFS_URL}/skill`.
 *
 * Why deterministic instead of a preprocessor sub-agent:
 *   - An earlier design ran a dedicated `acp-preprocessor` LLM that
 *     explored the canvas (read-only tools) and synthesised a briefing.
 *     That paid an extra model round-trip on every turn, added latency,
 *     was non-deterministic, and could fail to emit valid JSON. Since
 *     the RFS already lets the external agent fetch node
 *     content by path, all we need to hand it deterministically is the
 *     user's words + the IDs of what they selected.
 *
 * The canonical input uses the same XML tag vocabulary as the built-in
 * renderer. Backend lowering and initial-preamble realization belong to
 * the driver, not this host adapter.
 *
 * Rendering completes before `AgentHandle.run()`. Any attachment-resolution
 * failure therefore prevents the submission from starting instead of being
 * disguised as a successful raw-text fallback.
 */

import { renderTurn } from '../conversation/prompt/build-prompt.js';
import {
  ACP_PROFILE,
  ACP_SLASH_PROFILE,
} from '../conversation/prompt/profile.js';

import type { ChatEnvelope } from '../conversation/envelope.js';
import type { AgentInput } from '@agenetes/protocol';
import type { FastifyBaseLogger } from 'fastify';

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * Pattern for the slash-command lead-with-task path. Matches `/<name>` followed by
 * whitespace OR end of string. The leading character class is ASCII
 * letters only so URLs / Windows paths pasted mid-thought don't trip
 * it. Exported for tests.
 */
export const SLASH_COMMAND_RE = /^\/[a-zA-Z][\w-]*(?:\s|$)/;

// ─── Public API ───────────────────────────────────────────────────────────

interface RenderExternalInput {
  /**
   * This turn's structured envelope — the single source of truth for
   * the user's text, node selection, and neighbourhood. The ACP
   * renderer reads from it through the shared `renderTurn` composition.
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
  logger: FastifyBaseLogger;
}

/** Render one Huabu envelope into the external route's canonical inputs. */
export async function renderExternalAgentInputs(
  input: RenderExternalInput,
): Promise<AgentInput[]> {
  const { envelope, agentAlias, logger } = input;
  const rawText = envelope.user.text;
  const isSlashCommand = SLASH_COMMAND_RE.test(rawText.trim());
  if (isSlashCommand) {
    logger.debug(
      { agentAlias, command: rawText.trim().split(/\s+/)[0] },
      '[acp/preprocessor] slash command detected — leading verbatim, context appended',
    );
  }

  const parts = await renderTurn(
    envelope,
    isSlashCommand ? ACP_SLASH_PROFILE : ACP_PROFILE,
    { canvasId: input.canvasId ?? null },
  );
  if (parts.length === 0) return [];

  if (isSlashCommand) {
    return [
      {
        type: 'command',
        text: rawText,
        context: parts.slice(1),
      },
    ];
  }
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return [{ type: 'text', text: parts[0].text }];
  }
  return [{ type: 'parts', parts }];
}
