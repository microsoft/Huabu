import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { cloneArtifactBodySchema, createId } from '@sediment/shared';
import { type FastifyPluginAsync } from 'fastify';

import { getCanvasStore } from '../storage/index.js';

import type {
  ApiResult,
  ArtifactUploadResponse,
  CloneArtifactRequest,
} from '@sediment/shared';

/**
 * Canvas-scoped artifact route. Mount under `/api/canvas`.
 *
 *   POST /:canvasId/artifact/:type          → upload (image | pdf | video)
 *   GET  /:canvasId/artifact/:filename      → serve (filename = `<id><ext>`)
 *   POST /:canvasId/artifact/clone-from     → cross-canvas copy
 *
 * The on-disk filename equals the URL key, so a node's `data.src` resolves
 * directly without any indirection.
 */
const artifactRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Params: { canvasId: string; type: string };
    Reply: ApiResult<ArtifactUploadResponse>;
  }>('/:canvasId/artifact/:type', async (request, reply) => {
    const { canvasId, type } = request.params;

    const typeExtMap: Record<string, string> = {
      image: '.png',
      pdf: '.pdf',
      video: '.mp4',
    };

    if (!typeExtMap[type]) {
      return reply
        .code(400)
        .send({ message: 'Invalid type. Must be image, pdf, or video' });
    }

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ message: 'No file provided' });
    }

    const store = getCanvasStore(canvasId);
    const id = createId('artifact');
    const uploadedExt = path.extname(data.filename ?? '');
    const ext = uploadedExt || typeExtMap[type];

    let record;
    try {
      record = await store.writeArtifactStream(
        { id, ext, mimeType: data.mimetype ?? null },
        data.file,
      );
    } catch (error) {
      request.log.error({ err: error }, 'Failed to stream artifact to disk');
      return reply.code(500).send({ message: 'Failed to save file' });
    }

    // `uri` carries only the artifact key (`<id><ext>`); callers build
    // the canvas-scoped URL at render time.
    const response: ArtifactUploadResponse = {
      id,
      uri: record.filename,
      filename: data.filename ?? record.filename,
      mimetype: data.mimetype,
    };
    return reply.send(response);
  });

  fastify.get<{ Params: { canvasId: string; filename: string } }>(
    '/:canvasId/artifact/:filename',
    async (request, reply) => {
      const { canvasId, filename } = request.params;
      const store = getCanvasStore(canvasId);
      try {
        return reply.sendFile(path.basename(filename), store.artifactsDir());
      } catch {
        return reply.code(404).send({ message: 'Artifact not found' });
      }
    },
  );

  /**
   * Copy an artifact from one canvas into another.
   *
   * Used by the cross-canvas copy/paste flow: when a user pastes a node
   * carrying a `data.src` (or `data.coverUrl`) URL that points at a
   * different canvas's artifact, the frontend asks us to clone the
   * underlying file so the destination canvas owns its own copy.
   *
   * The destination receives a freshly-allocated artifact id; the source
   * remains untouched. The response shape mirrors the upload route so
   * callers can swap in the new `uri` directly.
   */
  fastify.post<{
    Params: { canvasId: string };
    Body: CloneArtifactRequest;
    Reply: ApiResult<ArtifactUploadResponse>;
  }>('/:canvasId/artifact/clone-from', async (request, reply) => {
    const { canvasId: dstCanvasId } = request.params;
    const parsed = cloneArtifactBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: parsed.error.issues[0]?.message ?? 'Invalid request body',
      });
    }
    const { srcCanvasId, srcKey } = parsed.data;

    const srcStore = getCanvasStore(srcCanvasId);
    const srcPath = srcStore.resolveArtifactFilePath(srcKey);
    if (!srcPath) {
      return reply.code(404).send({ message: 'Source artifact not found' });
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(srcPath);
    } catch (err) {
      request.log.error({ err }, 'Failed to read source artifact for clone');
      return reply
        .code(500)
        .send({ message: 'Failed to read source artifact' });
    }

    const dstStore = getCanvasStore(dstCanvasId);
    const id = createId('artifact');
    const ext = path.extname(srcKey);

    let record;
    try {
      record = await dstStore.writeArtifactBuffer(
        { id, ext, mimeType: null },
        buffer,
      );
    } catch (err) {
      request.log.error({ err }, 'Failed to clone artifact');
      return reply
        .code(500)
        .send({ message: 'Failed to save cloned artifact' });
    }

    // Mirror the upload route: return only the bare key.
    const response: ArtifactUploadResponse = {
      id,
      uri: record.filename,
      filename: record.filename,
      mimetype: record.mimeType ?? undefined,
    };
    return reply.send(response);
  });
};

export default artifactRoute;
