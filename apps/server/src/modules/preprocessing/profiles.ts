/**
 * Preprocessing Profiles
 *
 * Declarative registry that maps each canvas node type to its preprocessing
 * capabilities and watched fields.
 */

import type { NodePreprocessProfile } from './types.js';
import type { CanvasNodeType } from '@sediment/shared';

export const profiles: Record<CanvasNodeType, NodePreprocessProfile> = {
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
    capabilityTriggers: {
      generate_label: ['src'],
      generate_summary: ['src'],
      generate_keywords: ['src'],
    },
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
    capabilityTriggers: {
      generate_label: ['src'],
      generate_summary: ['src'],
      generate_keywords: ['src'],
    },
  },
  office: {
    nodeType: 'office',
    contentKind: 'office',
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
    watchFields: ['src', 'title', 'labelSource', 'format'],
    capabilityTriggers: {
      generate_label: ['src'],
      generate_summary: ['src'],
      generate_keywords: ['src'],
    },
  },
  image: {
    nodeType: 'image',
    contentKind: 'image',
    capabilities: [
      'resolve_input',
      'compute_fingerprint',
      'generate_label',
      'persist_source',
      'build_patch',
    ],
    watchFields: ['src', 'labelSource'],
    capabilityTriggers: {
      generate_label: ['src'],
    },
  },
  video: {
    nodeType: 'video',
    contentKind: 'video',
    capabilities: [
      'resolve_input',
      'compute_fingerprint',
      'persist_source',
      'build_patch',
    ],
    watchFields: ['src'],
  },
  audio: {
    nodeType: 'audio',
    capabilities: ['resolve_input', 'build_patch'],
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
    capabilityTriggers: {
      generate_label: ['childLabels'],
    },
  },
  sketch: {
    nodeType: 'sketch',
    capabilities: ['resolve_input', 'build_patch'],
    watchFields: [],
  },
  question: {
    nodeType: 'question',
    capabilities: [
      'resolve_input',
      'compute_fingerprint',
      'generate_label',
      'build_patch',
    ],
    watchFields: ['content'],
    capabilityTriggers: {
      generate_label: ['content'],
    },
  },
};

/**
 * Look up the preprocessing profile for a given node type.
 * Returns undefined for unknown node types.
 */
export function getProfile(
  nodeType: CanvasNodeType,
): NodePreprocessProfile | undefined {
  return profiles[nodeType];
}
