/**
 * Preprocessing Dispatcher
 *
 * Accepts a PreprocessNodeRequest, looks up the node profile, builds a
 * minimal execution plan, and runs the pipeline against the canvas
 * store identified by `request.canvasId`.
 */

import { coalesceInFlight } from './coalesce.js';
import { runPipeline, type PipelineDeps } from './pipeline.js';
import { getProfile } from './profiles.js';
import { ProviderManager } from './provider-manager.js';
import { getCanvasStore } from '../storage/index.js';

import type {
  Capability,
  NodePreprocessProfile,
  PreprocessNodeResult,
} from './types.js';
import type { PreprocessNodeRequest } from '@sediment/shared';

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
function dedupeKey(request: PreprocessNodeRequest): string {
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
  ].join('\u0000');
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
  ): Promise<PreprocessNodeResult> {
    return coalesceInFlight(this.inFlight, dedupeKey(request), () =>
      this.runPreprocess(request),
    );
  }

  private async runPreprocess(
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
