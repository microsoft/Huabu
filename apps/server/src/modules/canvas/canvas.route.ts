import { z } from 'zod';

import { getCanvasDb } from './canvas.db.js';

import type { FastifyPluginAsync } from 'fastify';

type CanvasNodeRow = {
  canvas_id: string;
  node_id: string;
  source_id: string | null;
};

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

function extractNodesFromState(
  state: unknown,
): Array<{ id: string; sourceId: string | null }> | null {
  if (typeof state !== 'object' || state === null) return null;
  const maybeNodes = (state as { nodes?: unknown }).nodes;
  if (!Array.isArray(maybeNodes)) return null;

  const result: Array<{ id: string; sourceId: string | null }> = [];

  for (const node of maybeNodes) {
    if (typeof node !== 'object' || node === null) continue;
    const id = (node as { id?: unknown }).id;
    if (typeof id !== 'string' || id.trim().length === 0) continue;

    const sourceIdRaw = (node as { sourceId?: unknown }).sourceId;
    const sourceId =
      typeof sourceIdRaw === 'string' && sourceIdRaw.trim().length > 0
        ? sourceIdRaw
        : null;

    result.push({ id, sourceId });
  }

  return result;
}

const putCanvasBodySchema = z.object({
  version: z.number().int().nonnegative(),
  state: z.unknown(),
  workspaceId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});

const canvasRoutes: FastifyPluginAsync = async (fastify) => {
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
      const nodes = extractNodesFromState(state) ?? [];

      const tx = database.transaction(() => {
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

        database
          .prepare('DELETE FROM canvas_nodes WHERE canvas_id = ?')
          .run(canvasId);

        const insertNode = database.prepare(
          `INSERT INTO canvas_nodes (canvas_id, node_id, source_id)
           VALUES (?, ?, ?)`,
        );

        for (const node of nodes) {
          const rowToInsert: CanvasNodeRow = {
            canvas_id: canvasId,
            node_id: node.id,
            source_id: node.sourceId,
          };

          insertNode.run(
            rowToInsert.canvas_id,
            rowToInsert.node_id,
            rowToInsert.source_id,
          );
        }
      });

      tx();

      return reply.send({
        canvasId,
        version: nextVersion,
      });
    },
  );
};

export default canvasRoutes;
