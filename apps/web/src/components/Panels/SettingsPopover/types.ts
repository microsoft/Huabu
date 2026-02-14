import type {
  KnowledgeStorageBackend,
  KnowledgeStorageConfig,
  MigrateStorageResponse,
} from '@sediment/shared';

/** Phases of the settings popover UI. */
export type PopoverPhase = 'settings' | 'migrating' | 'result';

/**
 * Count nodes that reference a knowledge source and would be affected
 * when switching storage backends.
 */
export function countMigratableNodes(
  nodes: { type?: string; data?: Record<string, unknown> }[],
): number {
  return nodes.filter((n) => !!n.data?.sourceId).length;
}

export type {
  KnowledgeStorageBackend,
  KnowledgeStorageConfig,
  MigrateStorageResponse,
};
