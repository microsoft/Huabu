// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Preprocessing Profiles
 *
 * Declarative registry that maps each canvas node type to its preprocessing
 * capabilities and watched fields.
 */

import type { NodePreprocessProfile } from './types.js';
import type { CanvasNodeType } from '@huabu/shared';

export const profiles: Record<CanvasNodeType, NodePreprocessProfile> = {
  note: {
    nodeType: 'note',
    contentKind: 'note',
    bodyOwnership: 'authored',
    capabilities: [
      'resolve_input',
      'extract_text',
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
    bodyOwnership: 'authored',
    capabilities: [
      'resolve_input',
      'extract_text',
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
    bodyOwnership: 'derived',
    capabilities: [
      'resolve_input',
      'fetch_remote_content',
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
    bodyOwnership: 'derived',
    capabilities: [
      'resolve_input',
      'extract_text',
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
    bodyOwnership: 'derived',
    capabilities: [
      'resolve_input',
      'extract_text',
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
    bodyOwnership: 'derived',
    capabilities: [
      'resolve_input',
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
    bodyOwnership: 'derived',
    capabilities: ['resolve_input', 'persist_source', 'build_patch'],
    watchFields: ['src'],
  },
  audio: {
    nodeType: 'audio',
    bodyOwnership: 'derived',
    capabilities: ['resolve_input', 'build_patch'],
    watchFields: ['src'],
  },
  frame: {
    nodeType: 'frame',
    bodyOwnership: 'derived',
    capabilities: ['resolve_input', 'generate_label', 'build_patch'],
    watchFields: ['childLabels', 'labelSource'],
    capabilityTriggers: {
      generate_label: ['childLabels'],
    },
  },
  spacePreview: {
    nodeType: 'spacePreview',
    bodyOwnership: 'derived',
    capabilities: [],
    watchFields: [],
  },
  canvasRef: {
    nodeType: 'canvasRef',
    bodyOwnership: 'derived',
    capabilities: [],
    watchFields: [],
  },
  frameRef: {
    nodeType: 'frameRef',
    bodyOwnership: 'derived',
    capabilities: [],
    watchFields: [],
  },
  nodeRef: {
    nodeType: 'nodeRef',
    bodyOwnership: 'derived',
    capabilities: [],
    watchFields: [],
  },
  sketch: {
    nodeType: 'sketch',
    bodyOwnership: 'derived',
    capabilities: ['resolve_input', 'build_patch'],
    watchFields: [],
  },
  question: {
    nodeType: 'question',
    bodyOwnership: 'authored',
    capabilities: ['resolve_input', 'generate_label', 'build_patch'],
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
