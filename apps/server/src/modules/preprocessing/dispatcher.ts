/**
 * Preprocessing Dispatcher
 *
 * Accepts a PreprocessNodeRequest, looks up the node profile, builds a
 * minimal execution plan, and runs the pipeline against the canvas
 * store identified by `request.canvasId`.
 */

import { runPipeline, type PipelineDeps } from './pipeline.js';
import { getProfile } from './profiles.js';
import { ProviderManager } from './provider-manager.js';
import { getCanvasStore } from '../storage/index.js';

import type {
  Capability,
  NodePreprocessProfile,
  PreprocessNodeRequest,
  PreprocessNodeResult,
} from '@sediment/shared';

/**
 * Build the execution plan: which capabilities need to run given the request.
 *
 * If `force` is set, all profile capabilities are included.
 * Otherwise, only capabilities whose watched fields changed are included,
 * plus structural capabilities (resolve_input, compute_fingerprint, build_patch)
 * which always run.
 */
function buildPlan(
  profile: NodePreprocessProfile,
  request: PreprocessNodeRequest,
): Capability[] {
  // Always include structural capabilities
  const structural: Capability[] = [
    'resolve_input',
    'compute_fingerprint',
    'build_patch',
  ];

  if (request.options?.force || !request.previousSnapshot) {
    // Full run: include all profile capabilities
    return profile.capabilities;
  }

  // Determine which watched fields changed
  const dirtyFields = profile.watchFields.filter((field) => {
    const prev = request.previousSnapshot?.[field];
    const curr = request.snapshot[field];
    return prev !== curr;
  });

  if (dirtyFields.length === 0) {
    // Nothing changed — still run structural caps for fingerprint check
    return structural.filter((c) => profile.capabilities.includes(c));
  }

  // Include all profile capabilities — dirty fields indicate work is needed.
  // Future optimization: map specific dirty fields to specific capabilities.
  return profile.capabilities;
}

export class PreprocessDispatcher {
  private provider = new ProviderManager();

  async preprocess(
    request: PreprocessNodeRequest,
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
        fingerprints: { input: '' },
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
      provider: this.provider,
    };

    return runPipeline(request, plan, profile.contentKind, deps);
  }
}
