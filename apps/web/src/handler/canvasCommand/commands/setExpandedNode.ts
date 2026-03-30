import type { MetaOnlyDefinition } from './types';

/**
 * SET_EXPANDED_NODE is handled inline by the executor (no handler needed).
 * Only metadata is declared here.
 */
const setExpandedNode: MetaOnlyDefinition = {
  meta: {
    snapshot: 'no',
    requiresEdgeReroute: false,
    needsTransitionCleanup: false,
  },
};

export default setExpandedNode;
