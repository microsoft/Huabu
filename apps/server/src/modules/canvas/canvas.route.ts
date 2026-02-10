import { z } from 'zod';

import { getCanvasDb } from './canvas.db.js';
import { getArtifactsDir } from '../artifact/utils.js';
import { getIngestService } from '../knowledge/index.js';

import type { FastifyPluginAsync } from 'fastify';

type CanvasRow = {
  canvas_id: string;
  workspace_id: string | null;
  title: string | null;
  version: number;
  state_json: string;
  created_at: number;
  updated_at: number;
};

function nowMs(): number {
  return Date.now();
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

    const { workspaceId, type, title, content, src } = parsed.data;
    const database = getCanvasDb();

    // Get canvas to determine workspaceId
    const canvasRow = database
      .prepare('SELECT workspace_id FROM canvases WHERE canvas_id = ?')
      .get(canvasId) as { workspace_id: string | null } | undefined;

    const resolvedWorkspaceId =
      workspaceId ?? canvasRow?.workspace_id ?? 'default';

    const ingestService = getIngestService();

    const existingMapping = database
      .prepare(
        'SELECT source_id FROM canvas_nodes WHERE canvas_id = ? AND node_id = ?',
      )
      .get(canvasId, nodeId) as { source_id: string | null } | undefined;

    try {
      const existingSourceId = existingMapping?.source_id ?? null;

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

      // Upsert the node-source mapping
      database
        .prepare(
          `INSERT INTO canvas_nodes (canvas_id, node_id, source_id)
           VALUES (?, ?, ?)
           ON CONFLICT(canvas_id, node_id) DO UPDATE SET source_id = excluded.source_id`,
        )
        .run(canvasId, nodeId, sourceId);

      return reply.send({
        nodeId,
        sourceId,
        success,
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

  // Delete a node and its source mapping
  fastify.delete<{
    Params: { canvasId: string; nodeId: string };
  }>('/:canvasId/nodes/:nodeId', async function (request, reply) {
    const { canvasId, nodeId } = request.params;
    const database = getCanvasDb();

    database
      .prepare('DELETE FROM canvas_nodes WHERE canvas_id = ? AND node_id = ?')
      .run(canvasId, nodeId);

    return reply.send({ success: true });
  });

  fastify.get<{ Params: { canvasId: string } }>(
    '/:canvasId',
    async function (request, reply) {
      const { canvasId } = request.params;
      const database = getCanvasDb();

      const row = database
        .prepare(
          `SELECT canvas_id, workspace_id, title, version, state_json, created_at, updated_at
           FROM canvases
           WHERE canvas_id = ?`,
        )
        .get(canvasId) as CanvasRow | undefined;

      if (!row) {
        return reply.code(404).send({ message: 'Canvas not found' });
      }

      let state: unknown;
      try {
        state = JSON.parse(row.state_json) as unknown;
      } catch {
        state = row.state_json;
      }

      return reply.send({
        canvasId: row.canvas_id,
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
          `SELECT canvas_id, workspace_id, title, version, state_json, created_at, updated_at
           FROM canvases
           WHERE canvas_id = ?`,
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

      const stateJson = JSON.stringify(state);

      // Only update canvas metadata and state (node-source mappings are managed by node endpoints)
      if (!existing) {
        database
          .prepare(
            `INSERT INTO canvases (
              canvas_id, workspace_id, title, version, state_json, created_at, updated_at
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
             SET workspace_id = COALESCE(?, workspace_id),
                 title = COALESCE(?, title),
                 version = ?,
                 state_json = ?,
                 updated_at = ?
             WHERE canvas_id = ?`,
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
};

export default canvasRoutes;
