// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Preprocessing Dispatcher
 *
 * Accepts a PreprocessNodeRequest, looks up the node profile, builds a
 * minimal execution plan, and runs the pipeline against the canvas
 * store identified by `request.canvasId`.
 */

import { coalesceInFlight } from './coalesce.js';
import { isLabelProtected } from './label-policy.js';
import { runPipeline, type PipelineDeps } from './pipeline.js';
import { getProfile } from './profiles.js';
import { ProviderManager } from './provider-manager.js';
import {
  canvasBlobs,
  getCanvasStore,
  getStructuredStore,
  withCanvasMutex,
} from '../storage/index.js';
import { withWorkspaceOperationLease } from '../workspace.js';

import type {
  Capability,
  NodePreprocessProfile,
  PreprocessExecutionBaseline,
  PreprocessNodeResult,
} from './types.js';
import type { CanvasFile } from '../canvas/persistence-types.js';
import type { PreprocessNodeRequest } from '@huabu/shared';

/**
 * Build the execution plan: which capabilities need to run given the request.
 *
 * - `force` (repair / manual) runs the full profile, bypassing all gating.
 * - Otherwise the profile's capabilities are filtered by two rules:
 *     1. **Per-capability triggers** (`profile.capabilityTriggers`): a listed
 *        capability is kept only when one of its trigger fields is dirty. On
 *        the first run (no `previousSnapshot`) every watched field counts as
 *        dirty, so first-run enrichment still happens.
 *     2. **Label protection**: `generate_label` never runs when the node's
 *        label is already user/agent-owned — the generated value would be
 *        discarded by the Project stage anyway (see {@link isLabelProtected}).
 *
 * Structural capabilities (`resolve_input`, `build_patch`) carry no triggers
 * and therefore always run.
 */
export function buildPlan(
  profile: NodePreprocessProfile,
  request: PreprocessNodeRequest,
): Capability[] {
  // Always include structural capabilities
  const structural: Capability[] = ['resolve_input', 'build_patch'];

  // Repair / manual triggers force a full run, overriding all gating.
  if (request.options?.force) {
    return profile.capabilities;
  }

  const isFirstRun = !request.previousSnapshot;

  // On the first run every watched field is effectively "new"; otherwise
  // compare against the previous snapshot.
  const dirtyFields = isFirstRun
    ? [...profile.watchFields]
    : profile.watchFields.filter(
        (field) =>
          request.previousSnapshot?.[field] !== request.snapshot[field],
      );

  if (!isFirstRun && dirtyFields.length === 0) {
    // Nothing changed — still run the structural caps (input resolve + patch
    // assembly); no extract / normalize / persist needed.
    return structural.filter((c) => profile.capabilities.includes(c));
  }

  const labelProtected = isLabelProtected(
    request.snapshot.labelSource,
    request.snapshot.title,
  );

  return profile.capabilities.filter((cap) => {
    // Never (re)generate a label the user or an agent already owns.
    if (cap === 'generate_label' && labelProtected) {
      return false;
    }
    // Trigger-gated capabilities run only when one of their fields is dirty.
    const triggers = profile.capabilityTriggers?.[cap];
    if (triggers && triggers.length > 0) {
      return triggers.some((field) => dirtyFields.includes(field));
    }
    // Untriggered capabilities run whenever the plan is non-empty.
    return true;
  });
}

/** Small stable string hash (djb2) — collisions only cost a missed
 *  coalesce, never a wrong result, so a 32-bit hash is plenty. */
function stableHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Key that is equal iff two requests would produce the same pipeline
 * outcome. Snapshots can be large (hundreds of KB for pdf/web), so they
 * are hashed rather than embedded verbatim.
 */
function dedupeKey(
  request: PreprocessNodeRequest,
  baseline: PreprocessExecutionBaseline,
): string {
  const o = request.options;
  return [
    request.canvasId,
    request.nodeId,
    request.nodeType,
    request.trigger,
    stableHash(JSON.stringify(request.snapshot ?? null)),
    stableHash(JSON.stringify(request.previousSnapshot ?? null)),
    o?.force ? 'F' : '_',
    o?.allowLLM === false ? 'nl' : 'll',
    o?.allowPersistence === false ? 'np' : 'pp',
    o?.mode ?? '',
    baseline.topologyType ?? '<absent>',
    baseline.spaceVersion === null ? '<absent>' : baseline.spaceVersion,
    baseline.nodeRecordRevision ?? '<absent>',
  ].join('\u0000');
}

function topologyTypeOf(
  canvas: CanvasFile | null,
  nodeId: string,
): string | null {
  const topologyNode = (canvas?.state.nodes ?? []).find((candidate) => {
    const id = (candidate as { id?: unknown } | null)?.id;
    return id === nodeId;
  }) as { type?: unknown } | undefined;
  return typeof topologyNode?.type === 'string' ? topologyNode.type : null;
}

/**
 * Capture the complete authoritative incarnation observed before any
 * asynchronous preprocessing work starts. Route handlers pass this exact
 * value into the dispatcher so there is no second read window in which a
 * same-id replacement can silently become the request's new baseline.
 */
export function capturePreprocessExecutionBaseline(
  canvasId: string,
  nodeId: string,
): Promise<PreprocessExecutionBaseline> {
  return withCanvasMutex(canvasId, async () => {
    const handle = getStructuredStore().space(canvasId);
    const [canvas, node] = await Promise.all([
      handle.record.read(),
      handle.nodes.read(nodeId),
    ]);
    return {
      topologyType: topologyTypeOf(canvas, nodeId),
      spaceVersion: canvas?.version ?? null,
      nodeRecordRevision: node?.revision ?? null,
    };
  });
}

/**
 * Strip every client-applicable projection from work that finished after its
 * target was deleted or structurally changed type. This is intentionally a
 * final pipeline gate: cache hits and `allowPersistence:false` never enter the
 * Persist stage, while Persist itself already performs the same check before
 * durable writes.
 */
export function supersedePreprocessResult(
  result: PreprocessNodeResult,
  topologyType: string | null,
): PreprocessNodeResult {
  return {
    nodeId: result.nodeId,
    nodeType: result.nodeType,
    trigger: result.trigger,
    requestId: result.requestId,
    success: true,
    status: 'skipped',
    superseded: true,
    usedCapabilities: result.usedCapabilities,
    patch: {},
    diagnostics: [
      {
        code: 'PREPROCESS_SUPERSEDED',
        level: 'info',
        message:
          topologyType === null
            ? 'Node is no longer present in the Space topology'
            : topologyType === result.nodeType
              ? 'Node changed while preprocessing was in flight'
              : `Node type changed to ${topologyType} while preprocessing was in flight`,
      },
    ],
  };
}

export class PreprocessDispatcher {
  private provider = new ProviderManager();

  /**
   * Coalesces concurrent identical requests so N tabs replaying the same
   * broadcast delta run the pipeline once. Keyed on {@link dedupeKey};
   * entries evict on settle (see {@link coalesceInFlight}).
   */
  private inFlight = new Map<string, Promise<PreprocessNodeResult>>();

  async preprocess(
    request: PreprocessNodeRequest,
    baseline?: PreprocessExecutionBaseline,
  ): Promise<PreprocessNodeResult> {
    return withWorkspaceOperationLease(async () => {
      const executionBaseline =
        baseline ??
        (await capturePreprocessExecutionBaseline(
          request.canvasId,
          request.nodeId,
        ));
      return coalesceInFlight(
        this.inFlight,
        dedupeKey(request, executionBaseline),
        () => this.runPreprocess(request, executionBaseline),
      );
    });
  }

  private async runPreprocess(
    request: PreprocessNodeRequest,
    baseline: PreprocessExecutionBaseline,
  ): Promise<PreprocessNodeResult> {
    const profile = getProfile(request.nodeType);

    if (!profile) {
      return {
        nodeId: request.nodeId,
        nodeType: request.nodeType,
        trigger: request.trigger,
        requestId: '',
        success: false,
        status: 'error',
        usedCapabilities: [],
        patch: {},
        diagnostics: [
          {
            code: 'UNKNOWN_NODE_TYPE',
            level: 'error',
            message: `No preprocessing profile for node type: ${request.nodeType}`,
          },
        ],
      };
    }

    const plan = buildPlan(profile, request);

    const deps: PipelineDeps = {
      store: getCanvasStore(request.canvasId),
      blobs: canvasBlobs(request.canvasId),
      provider: this.provider,
    };

    const result = await runPipeline(
      request,
      plan,
      profile.contentKind,
      profile.bodyOwnership,
      deps,
      baseline,
    );

    // Serialize the final observation with every aggregate Space mutation.
    // Without this gate, cache short-circuits and non-persisting previews can
    // return stale labels/content after a concurrent delete or type change.
    return withCanvasMutex(request.canvasId, async () => {
      const handle = getStructuredStore().space(request.canvasId);
      const [canvas, node] = await Promise.all([
        handle.record.read(),
        handle.nodes.read(request.nodeId),
      ]);
      const topologyType = topologyTypeOf(canvas, request.nodeId);
      // A committed result carries its own exact versioned event, so a later
      // commit is ordered by the HTTP/SSE gate rather than erasing this ACK.
      if (result.commit) return result;

      const baselineStillCurrent =
        topologyType === baseline.topologyType &&
        canvas?.version === baseline.spaceVersion &&
        (node?.revision ?? null) === baseline.nodeRecordRevision;
      return topologyType === request.nodeType && baselineStillCurrent
        ? { ...result, observedVersion: canvas.version }
        : supersedePreprocessResult(result, topologyType);
    });
  }
}
