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
    contentKind: 'note',
    capabilities: [
      'resolve_input',
      'extract_text',
      'compute_fingerprint',
      'resolve_title',
      'merge_metadata',
      'persist_source',
      'build_patch',
    ],
    watchFields: ['content', 'title', 'labelSource'],
  },
  text: {
    nodeType: 'text',
    contentKind: 'text',
    capabilities: [
      'resolve_input',
      'extract_text',
      'compute_fingerprint',
      'resolve_title',
      'merge_metadata',
      'persist_source',
      'build_patch',
    ],
    watchFields: ['content', 'title', 'labelSource'],
  },
  web: {
    nodeType: 'web',
    contentKind: 'web',
    capabilities: [
      'resolve_input',
      'fetch_remote_content',
      'compute_fingerprint',
      'resolve_title',
      'merge_metadata',
      'generate_label',
      'generate_summary',
      'generate_keywords',
      'persist_source',
      'build_patch',
    ],
    watchFields: ['src', 'title', 'labelSource'],
  },
  pdf: {
    nodeType: 'pdf',
    contentKind: 'pdf',
    capabilities: [
      'resolve_input',
      'extract_text',
      'compute_fingerprint',
      'resolve_title',
      'merge_metadata',
      'generate_label',
      'generate_summary',
      'generate_keywords',
      'persist_source',
      'build_patch',
    ],
    watchFields: ['src', 'title', 'labelSource'],
  },
  image: {
    nodeType: 'image',
    capabilities: [
      'resolve_input',
      'compute_fingerprint',
      'generate_label',
      'build_patch',
    ],
    watchFields: ['src', 'labelSource'],
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
    watchFields: ['childLabels', 'labelSource'],
  },
  annotation: {
    nodeType: 'annotation',
    capabilities: ['resolve_input', 'build_patch'],
    watchFields: [],
  },
  question: {
    nodeType: 'question',
    capabilities: [],
    watchFields: [],
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
