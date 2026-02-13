import type {
  KnowledgeStorageBackend,
  KnowledgeStorageConfig,
  MigrateStorageResponse,
} from '@sediment/shared';

/** Phases of the settings popover UI. */
export type PopoverPhase = 'settings' | 'confirm' | 'migrating' | 'result';

/** Node types whose content is managed by the knowledge DB. */
export const CONTENT_MANAGED_TYPES = new Set(['note', 'text']);

/**
 * Count nodes that reference a knowledge source and would be affected
 * when switching storage backends.
 */
export function countMigratableNodes(
  nodes: { type?: string; data?: Record<string, unknown> }[],
): number {
  return nodes.filter(
    (n) => !!n.data?.sourceId && CONTENT_MANAGED_TYPES.has(n.type ?? ''),
  ).length;
}

export type {
  KnowledgeStorageBackend,
  KnowledgeStorageConfig,
  MigrateStorageResponse,
};
