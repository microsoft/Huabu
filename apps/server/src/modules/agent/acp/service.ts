/**
 * `runAcpAgent` \u2014 the external-binding counterpart of `runAgent`.
 *
 * Drives a single user prompt against an ACP-connected external agent
 * (Copilot / Claude Code / Codex / \u2026) and yields the resulting stream
 * as Sediment\u2019s standard `AgentStreamEvent`s, so the route handler can
 * treat external and internal dispatches uniformly.
 *
 * Persistence model: one ACP session per Sediment thread, kept alive for
 * the thread’s lifetime via {@link acpSessionRegistry}. Successive
 * prompts on the same thread reuse the sessionId so the external agent
 * retains conversation memory.
 *
 * Translation scope today: text deltas only —
 * `session/update.agent_message_chunk` → `text_delta`. Tool calls,
 * plans, thinking, and mode updates are silently dropped by the
 * translator and will be added incrementally.
 */

import {
  prepareExternalAgentPrompt,
  serializeRawPrompt,
} from './preprocessor.js';
import { ensureProfileCacheSubscription } from './profile-cache-port.js';
import { getProfile } from './profile-store.js';
import { buildReachbackEnv } from './reachback-env.js';
import { canvasAcpNamespace } from '../../storage/paths.js';
import {
  agenetes,
  EXTERNAL_DRIVER_KIND,
  type AcpHandle,
  type AcpWorkloadSpec,
} from '../agenetes/drivers.js';
import { type RenderFn } from '../agenetes/handle.js';
import { dumpAssembledPrompt } from '../conversation/prompt/debug-prompt.js';

import type { ChatEnvelope } from '../conversation/envelope.js';
import type { ContentPart } from '../conversation/prompt/attachments.js';
import type { AcpTurnOverlay, PreparedAcpPrompt } from '@agenetes/acp-driver';
import type { AcpBindingRecipe } from '@agenetes/acp-driver';
import type { Message } from '@earendil-works/pi-ai';
import type { AcpContentBlock } from '@sediment/shared';
import type { AgentStreamEvent } from '@sediment/shared';
import type { FastifyBaseLogger } from 'fastify';

export interface RunAcpAgentOptions {
  /**
   * External binding for the active thread. `profileId` references a
   * user-configured spawn recipe (see `./profile-store.ts`); the
   * orchestrator resolves it to a live agentlet agent (spawning one
   * on the daemon if needed). `alias` is purely a label for logs +
   * `prepared_prompt` events.
   */
  binding: { alias: string; profileId: string };
  /** Sediment thread id \u2014 used as the registry key. */
  threadId: string;
  /**
   * Sediment canvasId for the active thread — plumbed into the
   * AcpAgentClient so capability handlers (fs sandbox, permission gate)
   * can scope checks to the correct canvas. Stored on the session entry
   * too: if a thread’s canvas changes (rebind), the stale session is
   * discarded just like an agent rebind.
   *
   * Optional only because the upstream schema (`agentRequestSchema`)
   * marks `canvasId` optional; in practice an external binding always
   * implies a canvas. The fs sandbox (once implemented) will reject
   * any fs/* request from a session opened without a canvasId.
   */
  canvasId?: string;
  /**
   * This turn's structured envelope — the single source of truth shared
   * with the built-in path. The preprocessor reads the user's text,
   * selection, and neighbourhood from it, so the external prompt cannot
   * drift from what the built-in serializer renders.
   */
  envelope: ChatEnvelope;
  /**
   * Mutable per-turn ACP overlay. We accumulate tool extensions
   * (keyed by `toolCallId`) and the turn's plan here; the route folds
   * it into the persisted turn record. Replaces the old `.parts.json`
   * sidecar — no timestamps, no position arrays.
   */
  overlay: AcpTurnOverlay;
  /**
   * `cwd` passed to `session/new` on first prompt for this thread.
   * Ignored for subsequent prompts (the session is already open).
   *
   * When omitted, `ensureAcpSession` resolves it from the bound
   * profile's `cwd` (set by the user in Settings → External Agents).
   * If the profile has been deleted and no `bindingRecipe` snapshot
   * was persisted, the call throws — we never silently fall back to
   * a sentinel like `'/'` (which the old agentlet relay was meant to
   * substitute with `process.cwd()` but never did, leaving agents
   * stranded at the filesystem root).
   */
  cwd?: string;
  /** Cancellation signal \u2014 wired through to `session/cancel`. */
  signal?: AbortSignal;
  logger: FastifyBaseLogger;
  /**
   * Optional developer aid: when present (and `HUABU_DEBUG_PROMPT` is
   * set), dump the serialized text payload handed to ACP. Mirrors the
   * built-in path's {@link AgentRunOptions.debugPrompt} so both
   * backends surface a comparable prompt log.
   */
  debugPrompt?: {
    turnNumber: number;
    threadId: string;
    mode: string;
    logger: FastifyBaseLogger;
  };
}

/**
 * Drive a prompt against the bound external agent and yield SSE-shaped
 * events. The route handler is responsible for the surrounding `meta` /
 * `end` frames and for context persistence beyond what we append here.
 */
/**
 * Resolve the host's spawn recipe for a profile id, snapshotting the
 * subset of the profile that determines spawn behaviour. Returns `null`
 * when the profile no longer exists (deleted in Settings) — the
 * session-lifecycle code then falls back to any persisted
 * `bindingRecipe`, or throws if the thread was never bound. This is the
 * one place the ACP path reaches into the L1 profile store; keeping it in
 * the host composition layer lets the session-lifecycle helper stay
 * profile-store-free and its create-time spec fully serializable.
 */
export function resolveBindingRecipe(
  profileId: string,
): AcpBindingRecipe | null {
  const profile = getProfile(profileId);
  if (!profile) return null;
  return {
    command: profile.command,
    cwd: profile.cwd,
    autoRestart: profile.autoRestart,
    alias: profile.displayName,
    ...(profile.agentTeam && { agentTeam: profile.agentTeam }),
  };
}

/**
 * Map the host's generic per-turn content parts onto ACP content blocks.
 * This is the L1 responsibility that used to live inside the ACP client:
 * the driver now speaks pure ACP, so the render closure produces
 * driver-native blocks. Explicit per-type so a new `ContentPart` variant
 * (audio / resource) breaks here until it gets its own block.
 */
function contentPartsToAcpBlocks(parts: ContentPart[]): AcpContentBlock[] {
  return parts.map((b): AcpContentBlock => {
    switch (b.type) {
      case 'image':
        return { type: 'image', data: b.data, mimeType: b.mimeType };
      case 'text':
        return { type: 'text', text: b.text };
      default: {
        const _exhaustive: never = b;
        throw new Error(
          `Unhandled content part: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  });
}

export async function* runAcpAgent(
  opts: RunAcpAgentOptions,
): AsyncGenerator<AgentStreamEvent, Message[]> {
  const { binding, threadId, overlay, signal, logger } = opts;
  const canvasId = opts.canvasId ?? '';
  // Verbatim user text for the raw-text fallback + slash detection.
  const rawText = opts.envelope.user.text;

  // Bake this thread's WorkloadSpec (I9.6). The ACP handle self-resolves
  // (opens or reuses) its live session per turn from these fields — L1 no
  // longer opens the session out-of-band. We deliberately do NOT set `cwd`
  // when the caller omitted it, so the handle derives it from the bound
  // profile's recipe.
  const spec: AcpWorkloadSpec = {
    threadId,
    kind: EXTERNAL_DRIVER_KIND,
    workloadType: 'Deployment',
    namespace: canvasAcpNamespace(canvasId),
    binding,
    env: buildReachbackEnv(threadId, canvasId),
    ...(opts.cwd !== undefined && { cwd: opts.cwd }),
    recipe: resolveBindingRecipe(binding.profileId),
  };

  // The render closure: (envelope, turnState) -> ACP wire blocks. Owns the
  // preprocessor + raw-text fallback so the driver always receives valid
  // blocks. The driver (L2) owns the per-turn session state and supplies
  // it here: `state.isFirstMessage` drives the one-shot system preamble —
  // L1 no longer reads the entry's `systemPreambleSent` flag itself.
  const render: RenderFn<PreparedAcpPrompt> = async (
    request,
    state,
  ): Promise<PreparedAcpPrompt> => {
    try {
      const result = await prepareExternalAgentPrompt({
        envelope: request,
        agentAlias: binding.alias,
        canvasId: canvasId || null,
        includeSystem: state.isFirstMessage,
        logger,
      });
      return {
        serialized: result.serialized,
        includedSystem: result.includedSystem,
        blocks: contentPartsToAcpBlocks(result.blocks),
      };
    } catch (err) {
      const preparedError = err instanceof Error ? err.message : String(err);
      logger.warn(
        { threadId, agentAlias: binding.alias, err: preparedError },
        '[acp] preprocessor failed — falling back to raw user text',
      );
      const serialized = serializeRawPrompt(rawText);
      return {
        serialized,
        includedSystem: false,
        blocks: [{ type: 'text', text: serialized }],
        preparedError,
      };
    }
  };

  // Optional developer aid: dump the exact text payload handed to ACP
  // `session/prompt` (the serialized prompt, NOT pi-ai messages — the
  // external agent keeps its own session history). No-op unless
  // HUABU_DEBUG_PROMPT is set. Lives in the composition layer so the ACP
  // driver need not import the host's prompt-debug util.
  const debugPrompt = opts.debugPrompt;
  const onPrepared = debugPrompt
    ? (serialized: string) => {
        dumpAssembledPrompt({
          systemPrompt: '',
          messages: [
            { role: 'user', content: serialized, timestamp: Date.now() },
          ],
          newMessageCount: 1,
          turnNumber: debugPrompt.turnNumber,
          threadId: debugPrompt.threadId,
          canvasId: canvasId || null,
          mode: debugPrompt.mode,
          logger: debugPrompt.logger,
        });
      }
    : undefined;

  // Get-or-create the long-lived ACP handle for this thread (I9.3) and
  // drive one turn. The handle self-resolves its session inside `run`, so
  // any session-open failure (unbound profile / bridge down) throws on the
  // generator's first `next()` — exactly as before. `spec.kind` is
  // `external`, so the instance's union handle narrows to an `AcpHandle`.
  const handle = agenetes.create(spec) as AcpHandle;
  // Fold this thread's up-reported metadata into the L1 profile cache
  // (I9.7). Idempotent per thread — subscribing before `run()` so the
  // handle's initial state up-report is captured.
  ensureProfileCacheSubscription(threadId, binding.profileId);
  return yield* handle.run(opts.envelope, render, {
    overlay,
    signal,
    logger,
    onPrepared,
  });
}
