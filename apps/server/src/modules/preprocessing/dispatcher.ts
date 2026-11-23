// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Preprocessing Dispatcher
 *
 * Accepts a PreprocessNodeRequest, looks up the node profile, builds a
 * minimal execution plan, and runs the pipeline against the canvas
 * store identified by `request.canvasId`.
 */

import { isLabelProtected } from './label-policy.js';
import { runPipeline, type PipelineDeps } from './pipeline.js';
import { getProfile } from './profiles.js';
import { ProviderManager } from './provider-manager.js';
import { withPublicNetworkOnly } from '../security/outbound.js';
import { space, getStructuredStore } from '../storage/index.js';
import { acquireWorkspaceOperationLease } from '../workspace.js';

import type {
  Capability,
  NodePreprocessProfile,
  PreprocessNodeResult,
} from './types.js';
import type { PreprocessNodeRequest } from './types.js';

/**
 * Build the execution plan: which capabilities need to run given the request.
 *
 * The profile's capabilities are filtered by two rules:
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

  const isFirstRun = !request.previousSnapshot;

  // On the first run every watched field is effectively "new"; otherwise
  // compare against the previous snapshot.
  const dirtyFields = isFirstRun
    ? [...profile.watchFields]
    : profile.watchFields.filter(
        (field) =>
          // By value: a Frame's `childLabels` is a fresh array on each side.
          JSON.stringify(request.previousSnapshot?.[field]) !==
          JSON.stringify(request.snapshot[field]),
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

export class PreprocessDispatcher {
  private provider = new ProviderManager();

  async preprocess(
    request: PreprocessNodeRequest,
  ): Promise<PreprocessNodeResult> {
    const lease = acquireWorkspaceOperationLease();
    try {
      return await this.runPreprocess(request);
    } finally {
      lease.release();
    }
  }

  private async runPreprocess(
    request: PreprocessNodeRequest,
  ): Promise<PreprocessNodeResult> {
    const profile = getProfile(request.nodeType);

    if (!profile) {
      return {
        nodeId: request.nodeId,
        nodeType: request.nodeType,
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
      nodes: getStructuredStore().space(request.canvasId).nodes,
      artifacts: space(request.canvasId).artifacts,
      provider: this.provider,
    };

    const run = () =>
      runPipeline(
        request,
        plan,
        profile.contentKind,
        profile.bodyOwnership,
        deps,
      );
    return request.publicNetworkOnly ? withPublicNetworkOnly(run) : run();
  }
}
