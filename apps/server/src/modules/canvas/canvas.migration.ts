import { z } from 'zod';

import { getCanvasDb } from './canvas.db.js';
import {
  setKnowledgeStorageConfig,
  resetIngestService,
  createRepositoryForConfig,
} from '../knowledge/index.js';

import type { CanvasRow, NodeLike } from './canvas.types.js';
import type {
  KnowledgeStorageConfig,
  MigrateStorageNodeResult,
} from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

function nowMs(): number {
  return Date.now();
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const migrateStorageBodySchema = z.object({
  to: z.discriminatedUnion('backend', [
    z.object({
      backend: z.literal('sqlite'),
      // Obsidian-specific config is not required when using sqlite backend
      obsidianVaultPath: z.string().optional(),
    }),
    z.object({
      backend: z.literal('obsidian'),
      // When using the obsidian backend, a vault path must be provided
      obsidianVaultPath: z.string(),
    }),
  ]),
});

/**
 * Migrate node sources from the current storage backend to a new one.
 * Copies every source referenced by canvas nodes, updates the canvas
 * state with the new storageConfig + sourceBackend, and bumps the version.
 */
export const migrationRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Params: { canvasId: string };
    Body: unknown;
  }>('/:canvasId/migrate-storage', async function (request, reply) {
    const { canvasId } = request.params;
    const parsed = migrateStorageBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid request body' });
    }

    const { to: targetConfig } = parsed.data;

    const database = getCanvasDb();
    const row = database
      .prepare(
        `SELECT canvasId, workspaceId, title, version, stateJson, createdAt, updatedAt
         FROM canvases
         WHERE canvasId = ?`,
      )
      .get(canvasId) as CanvasRow | undefined;

    if (!row) {
      return reply.code(404).send({ message: 'Canvas not found' });
    }

    let state: Record<string, unknown>;
    try {
      state = JSON.parse(row.stateJson) as Record<string, unknown>;
    } catch {
      return reply.code(500).send({ message: 'Failed to parse canvas state' });
    }

    const nodes = (state.nodes ?? []) as NodeLike[];
    const fromConfig: KnowledgeStorageConfig =
      (state.storageConfig as KnowledgeStorageConfig) ?? { backend: 'sqlite' };

    // Skip if source and target are identical
    if (
      fromConfig.backend === targetConfig.backend &&
      fromConfig.obsidianVaultPath === targetConfig.obsidianVaultPath
    ) {
      return reply.send({
        success: true,
        totalNodes: 0,
        migratedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        results: [],
        version: row.version,
      });
    }

    // Collect nodes whose content is managed by the knowledge DB
    const migratableNodes = nodes.filter((n) => n.data?.sourceId);

    const nextVersion = row.version + 1;

    if (migratableNodes.length === 0) {
      // Nothing to migrate – just update the config
      state.storageConfig = targetConfig;
      database
        .prepare(
          `UPDATE canvases SET stateJson = ?, version = ?, updatedAt = ? WHERE canvasId = ?`,
        )
        .run(JSON.stringify(state), nextVersion, nowMs(), canvasId);

      setKnowledgeStorageConfig(targetConfig);
      resetIngestService();

      return reply.send({
        success: true,
        totalNodes: 0,
        migratedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        results: [],
        version: nextVersion,
      });
    }

    // Create repositories for both backends
    let sourceRepo: Awaited<ReturnType<typeof createRepositoryForConfig>>;
    let targetRepo: Awaited<ReturnType<typeof createRepositoryForConfig>>;

    try {
      sourceRepo = await createRepositoryForConfig(fromConfig);
    } catch (error) {
      return reply.code(500).send({
        message: `Failed to connect to source backend (${
          fromConfig.backend
        }): ${toMessage(error)}`,
      });
    }

    try {
      targetRepo = await createRepositoryForConfig(targetConfig);
    } catch (error) {
      return reply.code(500).send({
        message: `Failed to connect to target backend (${
          targetConfig.backend
        }): ${toMessage(error)}`,
      });
    }

    // Migrate each source
    const results: MigrateStorageNodeResult[] = [];
    let migratedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const node of migratableNodes) {
      const sourceId = node.data?.sourceId as string;
      if (!sourceId) continue;

      const nodeId = (node.id as string) ?? sourceId;

      try {
        const source = sourceRepo.findSourceById(sourceId);
        if (!source) {
          skippedCount++;
          results.push({ nodeId, sourceId, status: 'skipped' });
          continue;
        }

        const existingInTarget = targetRepo.findSourceById(sourceId);
        const metadata = source.metaJson
          ? (JSON.parse(source.metaJson) as Record<string, unknown>)
          : undefined;

        if (existingInTarget) {
          targetRepo.updateSource(sourceId, {
            content: source.content,
            contentHash: source.contentHash,
            title: source.title ?? undefined,
            metadata,
          });
        } else {
          targetRepo.createSource({
            sourceId: source.sourceId,
            workspaceId: source.workspaceId,
            type: source.type,
            title: source.title ?? undefined,
            src: source.src ?? undefined,
            content: source.content,
            contentHash: source.contentHash,
            metadata,
          });
        }

        migratedCount++;
        results.push({ nodeId, sourceId, status: 'migrated' });
      } catch (error) {
        failedCount++;
        results.push({
          nodeId,
          sourceId,
          status: 'failed',
          error: toMessage(error),
        });
      }
    }

    // Update sourceBackend on all managed nodes and set new storageConfig
    const updatedNodes = nodes.map((node) => {
      if (!node.data?.sourceId) {
        return node;
      }
      return {
        ...node,
        data: { ...node.data, sourceBackend: targetConfig.backend },
      };
    });

    state.nodes = updatedNodes;
    state.storageConfig = targetConfig;

    database
      .prepare(
        `UPDATE canvases SET stateJson = ?, version = ?, updatedAt = ? WHERE canvasId = ?`,
      )
      .run(JSON.stringify(state), nextVersion, nowMs(), canvasId);

    // Switch global config to new backend
    setKnowledgeStorageConfig(targetConfig);
    resetIngestService();

    return reply.send({
      success: failedCount === 0,
      totalNodes: migratableNodes.length,
      migratedCount,
      skippedCount,
      failedCount,
      results,
      version: nextVersion,
    });
  });
};
