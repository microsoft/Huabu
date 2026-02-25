import { z } from 'zod';

import { getCanvasDb } from './canvas.db.js';
import { migrationRoute } from './canvas.migration.js';
import { getArtifactsDir } from '../artifact/utils.js';
import {
  getIngestService,
  getKnowledgeRepository,
  resetIngestService,
  setKnowledgeStorageConfig,
  getActiveStorageConfig,
} from '../knowledge/index.js';

import type { KnowledgeStorageConfig } from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

type CanvasRow = {
  canvasId: string;
  workspaceId: string | null;
  title: string | null;
  version: number;
  stateJson: string;
  createdAt: number;
  updatedAt: number;
};

function nowMs(): number {
  return Date.now();
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the storageConfig from a canvas row's stateJson and apply it
 * so subsequent repository/service calls use the correct backend.
 */
function applyStorageConfigFromCanvas(canvasId: string): void {
  const database = getCanvasDb();
  const row = database
    .prepare('SELECT stateJson FROM canvases WHERE canvasId = ?')
    .get(canvasId) as { stateJson: string } | undefined;

  if (!row) return;

  try {
    const state = JSON.parse(row.stateJson) as {
      storageConfig?: KnowledgeStorageConfig;
    };
    if (state.storageConfig) {
      setKnowledgeStorageConfig(state.storageConfig);
      resetIngestService();
    }
  } catch {
    // Ignore parse errors – fall back to current config
  }
}

interface NodeLike {
  type?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Strip derived `content` from nodes that already have a `sourceId`.
 * This avoids storing a redundant copy in canvas state_json – the knowledge
 * DB is the single source of truth for note/text content.
 */
function stripManagedContent(state: unknown): unknown {
  if (
    typeof state !== 'object' ||
    state === null ||
    !('nodes' in state) ||
    !Array.isArray((state as { nodes: unknown }).nodes)
  ) {
    return state;
  }

  const { nodes, ...rest } = state as { nodes: NodeLike[] } & Record<
    string,
    unknown
  >;

  const strippedNodes = nodes.map((node) => {
    if (!node.data?.sourceId) {
      return node;
    }

    // Strip `content` but preserve it as `contentSnapshot` for fallback
    // when the storage backend changes or a source cannot be found.
    const { content, ...dataRest } = node.data;
    return {
      ...node,
      data: {
        ...dataRest,
        ...(typeof content === 'string' ? { contentSnapshot: content } : {}),
      },
    };
  });

  return { ...rest, nodes: strippedNodes };
}

/**
 * Hydrate node `content` from the knowledge DB for nodes that reference a source.
 * Only applies to note/text nodes that have a `sourceId`.
 */
async function hydrateNodeContent(state: unknown): Promise<unknown> {
  if (
    typeof state !== 'object' ||
    state === null ||
    !('nodes' in state) ||
    !Array.isArray((state as { nodes: unknown }).nodes)
  ) {
    return state;
  }

  const { nodes, ...rest } = state as { nodes: NodeLike[] } & Record<
    string,
    unknown
  >;

  const repository = await getKnowledgeRepository();

  const hydratedNodes = nodes.map((node) => {
    const sourceId = node.data?.sourceId as string | undefined;
    if (!sourceId) {
      return node;
    }

    const source = repository.findSourceById(sourceId);

    // Fall back to contentSnapshot when the source cannot be found
    // (e.g. after switching storage backends without migrating).
    const content =
      source?.content ??
      (node.data?.contentSnapshot as string | undefined) ??
      '';

    return {
      ...node,
      data: {
        ...node.data,
        content,
      },
    };
  });

  return { ...rest, nodes: hydratedNodes };
}

const putCanvasBodySchema = z.object({
  version: z.number().int().nonnegative(),
  state: z.unknown(),
  workspaceId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});

const upsertNodeBodySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  type: z.enum(['note', 'text', 'web', 'pdf']),
  title: z.string().optional(),
  content: z.string().optional(),
  src: z.string().optional(),
  sourceId: z.string().min(1).optional(),
});

const canvasRoutes: FastifyPluginAsync = async (fastify) => {
  // Upsert a single node (create or update) and ingest it
  fastify.put<{
    Params: { canvasId: string; nodeId: string };
    Body: unknown;
  }>('/:canvasId/nodes/:nodeId', async function (request, reply) {
    const { canvasId, nodeId } = request.params;
    const parsed = upsertNodeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid request body' });
    }

    // Ensure the knowledge backend matches the canvas-level config
    applyStorageConfigFromCanvas(canvasId);

    const {
      workspaceId,
      type,
      title,
      content,
      src,
      sourceId: existingSourceId,
    } = parsed.data;
    const database = getCanvasDb();

    // Get canvas to determine workspaceId
    const canvasRow = database
      .prepare('SELECT workspaceId FROM canvases WHERE canvasId = ?')
      .get(canvasId) as { workspaceId: string | null } | undefined;

    const resolvedWorkspaceId =
      workspaceId ?? canvasRow?.workspaceId ?? 'default';

    const ingestService = await getIngestService();

    try {
      const outcome =
        type === 'pdf'
          ? await ingestService.ingestPdfCanvasNodeFromArtifact({
              workspaceId: resolvedWorkspaceId,
              nodeId,
              title,
              artifactUri: src,
              artifactsDir: getArtifactsDir(),
              existingSourceId,
            })
          : await ingestService.ingestCanvasNode({
              workspaceId: resolvedWorkspaceId,
              nodeId,
              type,
              title,
              content,
              src,
              existingSourceId,
            });

      const { sourceId, success, error } = outcome;
      const currentConfig = getActiveStorageConfig();

      return reply.send({
        nodeId,
        sourceId,
        success,
        sourceBackend: currentConfig.backend,
        suggestedLabel: outcome.title,
        error: error ? `${error.code}: ${error.message}` : undefined,
      });
    } catch (error) {
      // Unexpected failure (DB issues, etc). Keep 500, but provide a detailed message.
      const message = toMessage(error);
      request.log.error(
        { nodeId, nodeType: type, error },
        'Failed to ingest node',
      );
      return reply.code(500).send({
        message: 'Failed to ingest node',
        details: message,
      });
    }
  });

  // Delete a node
  fastify.delete<{
    Params: { canvasId: string; nodeId: string };
  }>('/:canvasId/nodes/:nodeId', async function (_request, reply) {
    return reply.send({ success: true });
  });

  fastify.get<{ Params: { canvasId: string } }>(
    '/:canvasId',
    async function (request, reply) {
      const { canvasId } = request.params;
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

      let state: unknown;
      try {
        state = JSON.parse(row.stateJson) as unknown;
      } catch {
        state = row.stateJson;
      }

      // Hydrate node content from knowledge DB so clients always get fresh data
      applyStorageConfigFromCanvas(canvasId);
      state = await hydrateNodeContent(state);

      return reply.send({
        canvasId: row.canvasId,
        version: row.version,
        state,
      });
    },
  );

  fastify.put<{ Params: { canvasId: string }; Body: unknown }>(
    '/:canvasId',
    async function (request, reply) {
      const { canvasId } = request.params;
      const parsed = putCanvasBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ message: 'Invalid request body' });
      }

      const { version: clientVersion, state, workspaceId, title } = parsed.data;

      const database = getCanvasDb();
      const existing = database
        .prepare(
          `SELECT canvasId, workspaceId, title, version, stateJson, createdAt, updatedAt
           FROM canvases
           WHERE canvasId = ?`,
        )
        .get(canvasId) as CanvasRow | undefined;

      const serverVersion = existing?.version ?? 0;
      if (clientVersion !== serverVersion) {
        return reply
          .code(409)
          .send({ message: 'Canvas version mismatch', serverVersion });
      }

      const timestamp = nowMs();
      const nextVersion = serverVersion + 1;

      // Strip content that is managed by the knowledge DB to avoid data duplication
      const leanState = stripManagedContent(state);
      const stateJson = JSON.stringify(leanState);

      // Only update canvas metadata and state (node-source mappings are managed by node endpoints)
      if (!existing) {
        database
          .prepare(
            `INSERT INTO canvases (
              canvasId, workspaceId, title, version, stateJson, createdAt, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            canvasId,
            workspaceId ?? null,
            title ?? null,
            nextVersion,
            stateJson,
            timestamp,
            timestamp,
          );
      } else {
        database
          .prepare(
            `UPDATE canvases
             SET workspaceId = COALESCE(?, workspaceId),
                 title = COALESCE(?, title),
                 version = ?,
                 stateJson = ?,
                 updatedAt = ?
             WHERE canvasId = ?`,
          )
          .run(
            workspaceId ?? null,
            title ?? null,
            nextVersion,
            stateJson,
            timestamp,
            canvasId,
          );
      }

      return reply.send({
        canvasId,
        version: nextVersion,
      });
    },
  );

  // ───────────────────── Storage Migration ─────────────────────
  await fastify.register(migrationRoute);
};

export default canvasRoutes;
