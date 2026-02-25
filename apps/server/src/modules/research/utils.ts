/**
 * Research Utilities
 *
 * Helper functions for the deep research module.
 */

import type { ResearchConfig } from '@sediment/shared';

/**
 * Get the maximum number of sources based on search depth
 *
 * @param searchDepth - The search depth setting (basic or advanced)
 * @returns Number of sources to search
 */
export function getMaxSourcesFromDepth(
  searchDepth?: 'basic' | 'advanced',
): number {
  const depth = searchDepth ?? 'advanced';
  return depth === 'basic' ? 4 : 8;
}

/**
 * Get max sources from research config
 */
export function getMaxSources(config?: ResearchConfig): number {
  return getMaxSourcesFromDepth(config?.searchDepth);
}
