/**
 * Preprocessing Profiles
 *
 * Declarative registry that maps each canvas node type to its preprocessing
 * capabilities and watched fields.
 */

import type { CanvasNodeKind, NodePreprocessProfile } from '@sediment/shared';

export const profiles: Record<CanvasNodeKind, NodePreprocessProfile> = {
  note: {
    nodeType: 'note',
    sourceKind: 'note',
    capabilities: [
      'resolve_input',
      'extract_text',
      'compute_fingerprint',
      'resolve_title',
      'merge_metadata',
      'persist_source',
      'build_patch',
    ],
    watchFields: ['content', 'label'],
  },
  text: {
    nodeType: 'text',
    sourceKind: 'text',
    capabilities: [
      'resolve_input',
      'extract_text',
      'compute_fingerprint',
      'resolve_title',
      'merge_metadata',
      'persist_source',
      'build_patch',
    ],
    watchFields: ['content', 'label'],
  },
  web: {
    nodeType: 'web',
    sourceKind: 'web',
    capabilities: [
      'resolve_input',
      'fetch_remote_content',
      'compute_fingerprint',
      'resolve_title',
      'merge_metadata',
      'persist_source',
      'build_patch',
    ],
    watchFields: ['src', 'label'],
  },
  pdf: {
    nodeType: 'pdf',
    sourceKind: 'pdf',
    capabilities: [
      'resolve_input',
      'extract_text',
      'compute_fingerprint',
      'resolve_title',
      'merge_metadata',
      'persist_source',
      'build_patch',
    ],
    watchFields: ['src', 'label'],
  },
  image: {
    nodeType: 'image',
    capabilities: [
      'resolve_input',
      'compute_fingerprint',
      'generate_label',
      'build_patch',
    ],
    watchFields: ['src'],
  },
  video: {
    nodeType: 'video',
    capabilities: ['resolve_input', 'compute_fingerprint', 'build_patch'],
    watchFields: ['src'],
  },
  frame: {
    nodeType: 'frame',
    capabilities: [
      'resolve_input',
      'compute_fingerprint',
      'generate_label',
      'build_patch',
    ],
    watchFields: ['childLabels'],
  },
};

/**
 * Look up the preprocessing profile for a given node type.
 * Returns undefined for unknown node types.
 */
export function getProfile(
  nodeType: CanvasNodeKind,
): NodePreprocessProfile | undefined {
  return profiles[nodeType];
}
