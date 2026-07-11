import { canvasAcpNamespace } from '../../storage/paths.js';
import { buildReachbackEnv } from '../acp/reachback-env.js';

import type { AgenetesWorkloadSpec } from './drivers.js';

/** Compile the complete target spec L1 supplies to Agenetes.fork(). */
export function buildForkTargetSpec(
  source: AgenetesWorkloadSpec,
  threadId: string,
  canvasId: string,
): AgenetesWorkloadSpec {
  const namespace = canvasAcpNamespace(canvasId);
  if ('binding' in source) {
    return {
      ...source,
      threadId,
      namespace,
      env: buildReachbackEnv(threadId, canvasId),
    };
  }
  return {
    ...source,
    threadId,
    namespace,
    spec: {
      ...source.spec,
      initialMessages: [],
      hostContext: {
        ...source.spec.hostContext,
        canvasId,
      },
    },
  };
}
