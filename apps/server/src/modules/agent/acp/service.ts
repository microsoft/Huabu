// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `runAcpAgent` \u2014 the external-binding counterpart of `runAgent`.
 *
 * Drives a single user prompt against an ACP-connected external agent
 * (Copilot / Claude Code / Codex / \u2026) and yields the resulting stream
 * as Huabu\u2019s standard `AgentStreamEvent`s, so the route handler can
 * treat external and internal dispatches uniformly.
 *
 * Persistence model: one ACP session per Huabu thread, kept alive for
 * the thread’s lifetime via {@link acpSessionRegistry}. Successive
 * prompts on the same thread reuse the sessionId so the external agent
 * retains conversation memory.
 *
 * Translation scope today: text deltas only —
 * `session/update.agent_message_chunk` → `text_delta`. Tool calls,
 * plans, thinking, and mode updates are silently dropped by the
 * translator and will be added incrementally.
 */

import { randomUUID } from 'node:crypto';

import {
  getAgentProfileRegistry,
  getSupervisedAgentletId,
} from '@agenetes/agentlet-host';

import { renderExternalAgentInputs } from './preprocessor.js';
import { getProfileSessionPreferences } from './profile-session-preferences.js';
import {
  recipeFromProfileSnapshot,
  resolveProfileSnapshot,
} from './profile-snapshot.js';
import { buildReachbackEnv } from './reachback-env.js';
import { renderExternalAgentSystemPreamble } from '../../../prompt/external-agent/system-preamble.js';
import { canvasAcpNamespace } from '../../workspace/paths.js';
import {
  agenetes,
  EXTERNAL_DRIVER_KIND,
  type AcpHandle,
  type AcpWorkloadSpec,
} from '../agenetes/drivers.js';
import { createChatSubmission } from '../agenetes/handle.js';
import { dumpAssembledPrompt } from '../conversation/prompt/debug-prompt.js';
import { renderInkReportEndpoint } from '../conversation/prompt/ink-intent.js';
import { conversationTitleService } from '../conversation-title.service.js';
import { beginActiveInkIntentTurn } from '../ink-intent-runtime.js';

import type { HuabuSubmission } from '../agenetes/handle.js';
import type { ChatEnvelope } from '../conversation/envelope.js';
import type { AcpBindingRecipe, AcpTurnOverlay } from '@agenetes/acp-driver';
import type {
  AgentLaunchOverrides,
  AgentStreamEvent,
  AgentTurnAccepted,
} from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

export interface RunAcpAgentOptions {
  /** Canonically realized handle shared by message and control paths. */
  handle: AcpHandle;
  /**
   * External binding for the active thread. `profileId` references a
   * persisted Profile in the generic registry; the
   * orchestrator resolves it to a live agentlet agent (spawning one
   * on the daemon if needed). `alias` is purely a label for logs +
   * `prepared_prompt` events.
   */
  binding: { alias: string; profileId: string };
  /** Huabu thread id \u2014 used as the registry key. */
  threadId: string;
  /**
   * Huabu canvasId for the active thread — plumbed into the
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
  /** Pre-rendered durable submission for non-chat host events. */
  submission?: HuabuSubmission;
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
  /** Called after Agenetes has synchronously persisted this turn's start. */
  onTurnStarted?: (acceptance?: AgentTurnAccepted) => void;
  inkIntentOwnerNodeId?: string;
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
 * host-side Profile projection; keeping it in the host composition layer lets the session-lifecycle helper stay
 * profile-store-free and its create-time spec fully serializable.
 */
export function resolveBindingRecipe(
  profileId: string,
): AcpBindingRecipe | null {
  const profile = resolveProfileSnapshot(profileId);
  const alias = getAgentProfileRegistry()?.getProfile(profileId)?.alias;
  return profile && alias ? recipeFromProfileSnapshot(profile, alias) : null;
}

export { resolveProfileSnapshot } from './profile-snapshot.js';

function applyWorkingDirectoryOverride(
  recipe: AcpBindingRecipe | null,
  workingDirPath: string | undefined,
): AcpBindingRecipe | null {
  if (!recipe || !workingDirPath) return recipe;
  return {
    ...recipe,
    cwd: workingDirPath,
  };
}

export interface BuildAcpWorkloadSpecOptions {
  binding: { alias: string; profileId: string };
  threadId: string;
  canvasId?: string;
  cwd?: string;
  launchOverrides?: AgentLaunchOverrides;
  spacePrompt?: string;
}

export function buildAcpWorkloadSpec(
  opts: BuildAcpWorkloadSpecOptions,
): AcpWorkloadSpec {
  const { binding, threadId } = opts;
  const canvasId = opts.canvasId ?? '';
  const profile = resolveProfileSnapshot(binding.profileId);
  let agentletId: string;
  let cwd: string | undefined;
  let recipe: AcpBindingRecipe | null;
  if (profile) {
    agentletId = profile.agentletId;
    cwd = profile.workingDirPath;
    recipe = recipeFromProfileSnapshot(profile, binding.alias);
  } else {
    agentletId = getSupervisedAgentletId();
    cwd = opts.cwd;
    recipe = resolveBindingRecipe(binding.profileId);
  }

  const workingDirPath = opts.launchOverrides?.workingDirPath;
  cwd = workingDirPath ?? cwd;
  recipe = applyWorkingDirectoryOverride(recipe, workingDirPath);

  return {
    threadId,
    kind: EXTERNAL_DRIVER_KIND,
    workloadType: 'Deployment' as const,
    namespace: canvasAcpNamespace(canvasId),
    spec: {
      initialPreamble: [
        renderExternalAgentSystemPreamble(),
        ...(opts.spacePrompt ? [opts.spacePrompt] : []),
        ...(opts.launchOverrides?.additionalInitialPreamble
          ? [opts.launchOverrides.additionalInitialPreamble]
          : []),
      ],
      initialPreferences: getProfileSessionPreferences(binding.profileId),
      profileExecutionRevision: profile?.executionRevision ?? 0,
      binding,
      agentletId,
      ...(cwd !== undefined && { cwd }),
      recipe,
      env: buildReachbackEnv(threadId, canvasId),
    },
  };
}

export async function* runAcpAgent(
  opts: RunAcpAgentOptions,
): AsyncGenerator<AgentStreamEvent, void> {
  const { binding, overlay, signal, logger, handle } = opts;
  const canvasId = opts.canvasId ?? '';
  let submission =
    opts.submission ??
    createChatSubmission(
      opts.envelope,
      await renderExternalAgentInputs({
        envelope: opts.envelope,
        agentAlias: binding.alias,
        canvasId: canvasId || null,
        logger,
      }),
    );

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

  // The shared realization service has already created the complete durable
  // workload and subscribed its metadata before either message or control
  // dispatch reaches this point.
  signal?.throwIfAborted();
  if (canvasId)
    await conversationTitleService.start(
      canvasId,
      opts.threadId,
      opts.envelope.user.text,
    );
  const inkToken =
    opts.envelope.user.inputKind === 'ink-intent' ? randomUUID() : undefined;
  if (inkToken) {
    if (!canvasId) throw new Error('Ink intent requires a Space');
    if (!submission.rendered) throw new Error('Ink input was not rendered');
    submission = {
      ...submission,
      rendered: [
        ...submission.rendered,
        {
          type: 'text',
          text: renderInkReportEndpoint(opts.threadId, inkToken),
        },
      ],
    };
  }
  const reportEvents: Exclude<AgentStreamEvent, { type: 'meta' | 'end' }>[] =
    [];
  let reported = false;
  const finishInk = inkToken
    ? beginActiveInkIntentTurn(
        canvasId,
        opts.threadId,
        opts.inkIntentOwnerNodeId,
        inkToken,
        (result) => {
          if (reported) return;
          reported = true;
          const toolCallId = `huabu-ink-${inkToken}`;
          reportEvents.push(
            {
              type: 'tool_call',
              data: {
                toolCallId,
                title: 'report_ink_intent',
                internalToolName: 'report_ink_intent',
                rawInput: result.report,
                status: 'in_progress',
              },
            },
            {
              type: 'tool_call_update',
              data: {
                toolCallId,
                status: 'completed',
                rawOutput: JSON.stringify({
                  ...result.report,
                  renamed: result.renamed,
                }),
              },
            },
          );
        },
      )
    : () => {};
  signal?.addEventListener('abort', finishInk, { once: true });
  try {
    signal?.throwIfAborted();
    const iterator = handle.run(submission, {
      overlay,
      signal,
      logger,
      onPrepared,
      ...(inkToken ? { drainHostEvents: () => reportEvents.splice(0) } : {}),
    });
    opts.onTurnStarted?.({
      threadId: opts.threadId,
      turnStartSeq: agenetes.logMetadata(
        canvasAcpNamespace(canvasId),
        opts.threadId,
      ).eventCount,
    });
    yield* iterator;
  } finally {
    signal?.removeEventListener('abort', finishInk);
    finishInk();
  }
}
