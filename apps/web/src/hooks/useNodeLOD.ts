// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useNodePresentation } from './useNodePresentation';

import type { LODRenderMode } from '@/config/semanticZoom';

/**
 * Compatibility for the shell's binary visibility. Overview and reading
 * share the full body slot; unlisted node types always remain full.
 */
export function useNodeLOD(nodeId: string, nodeType: string): LODRenderMode {
  return useNodePresentation(nodeId, nodeType).mode === 'minimal'
    ? 'minimal'
    : 'full';
}
