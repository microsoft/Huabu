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

import {
  getAgentTeamRegistry,
  getSupervisedAgentletId,
} from '@agenetes/agentlet-host';

import { renderExternalAgentInputs } from './preprocessor.js';
import { ensureProfileCacheSubscription } from './profile-cache-port.js';
import { getProfileSessionPreferences } from './profile-session-preferences.js';
import { getProfile as getLegacyProfile } from './profile-store.js';
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

import type { HuabuSubmission } from '../agenetes/handle.js';
import type { ChatEnvelope } from '../conversation/envelope.js';
import type { AcpBindingRecipe, AcpTurnOverlay } from '@agenetes/acp-driver';
import type { AgentProfileSnapshot } from '@agenetes/agent-team';
import type { AgentLaunchOverrides, AgentStreamEvent } from '@huabu/shared';
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
  /** Per-node spawn overrides applied when the workload is first created. */
  launchOverrides?: AgentLaunchOverrides;
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
  onTurnStarted?: () => void;
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
  const managed = getAgentTeamRegistry()?.getProfile(profileId);
  if (managed?.launch.kind === 'acp-command') {
    return {
      command: managed.launch.command,
      cwd: managed.workingDirPath,
      autoRestart: true,
      alias: managed.alias,
    };
  }

  const profile = getLegacyProfile(profileId);
  if (!profile) return null;
  return {
    command: profile.command,
    cwd: profile.cwd,
    autoRestart: profile.autoRestart,
    alias: profile.displayName,
    ...(profile.agentTeam && { agentTeam: profile.agentTeam }),
  };
}

export function resolveProfileSnapshot(
  profileId: string,
): AgentProfileSnapshot | null {
  const profile = getAgentTeamRegistry()?.getProfile(profileId);
  if (!profile) return null;
  return {
    profileId: profile.id,
    agentletId: profile.agentletId,
    workingDirPath: profile.workingDirPath,
    launch: profile.launch,
  };
}

function applyWorkingDirectoryOverride(
  recipe: AcpBindingRecipe | null,
  workingDirPath: string | undefined,
): AcpBindingRecipe | null {
  if (!recipe || !workingDirPath) return recipe;
  return {
    ...recipe,
    cwd: workingDirPath,
    ...(recipe.agentTeam && 'workingDirPath' in recipe.agentTeam
      ? {
          agentTeam: {
            ...recipe.agentTeam,
            workingDirPath,
          },
        }
      : {}),
  };
}

export function buildAcpWorkloadSpec(
  opts: Pick<
    RunAcpAgentOptions,
    'binding' | 'threadId' | 'canvasId' | 'cwd' | 'launchOverrides'
  >,
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
    if (profile.launch.kind === 'acp-command') {
      recipe = {
        command: profile.launch.command,
        cwd: profile.workingDirPath,
        autoRestart: true,
        alias: binding.alias,
      };
    } else {
      recipe = {
        autoRestart: true,
        alias: binding.alias,
        agentTeam: {
          manifestPath: profile.launch.manifestPath,
          workingDirPath: profile.workingDirPath,
          harness: profile.launch.harness,
        },
      };
    }
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
        ...(opts.launchOverrides?.additionalInitialPreamble
          ? [opts.launchOverrides.additionalInitialPreamble]
          : []),
      ],
      initialPreferences: getProfileSessionPreferences(binding.profileId),
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
  const { binding, threadId, overlay, signal, logger } = opts;
  const canvasId = opts.canvasId ?? '';
  const submission =
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

  // Bake this thread's WorkloadSpec (I9.6). The ACP handle self-resolves
  // (opens or reuses) its live session per turn from these fields — L1 no
  // longer opens the session out-of-band. Agenetes keeps an existing
  // persisted spec authoritative when recovering a previously created
  // workload.
  const spec = buildAcpWorkloadSpec(opts);

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
  // session-open failures surface on the generator's first `next()`.
  // Static DriverMap construction guarantees that `external` is ACP.
  const handle = agenetes.create(spec) as AcpHandle;
  // Fold this thread's up-reported metadata into the L1 profile cache
  // (I9.7). Idempotent per thread — subscribing before `run()` so the
  // handle's initial state up-report is captured.
  ensureProfileCacheSubscription(threadId, binding.profileId);
  const iterator = handle.run(submission, {
    overlay,
    signal,
    logger,
    onPrepared,
  });
  opts.onTurnStarted?.();
  yield* iterator;
}
