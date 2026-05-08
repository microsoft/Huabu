import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createId } from '@sediment/shared';
import { type FastifyPluginAsync } from 'fastify';

import { artifactApiPath } from './utils.js';
import { getCanvasStore } from '../storage/index.js';

import type { ApiResult, ArtifactUploadResponse } from '@sediment/shared';

/**
 * Canvas-scoped artifact route. Mount under `/api/canvas`.
 *
 *   POST /:canvasId/artifact/:type   → upload (image | pdf | video)
 *   GET  /:canvasId/artifact/:key    → serve (key = `<artifactId><ext>`)
 *
 * The on-disk filename is derived from the upload's display name (the
 * client-supplied filename, falling back to the generated id) and may
 * differ from the URL key. Both old `<id><ext>` URLs and the new
 * label-named files resolve through the per-canvas artifact manifest.
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

    // Display name defaults to the user's original filename (without
    // extension); falls back to the generated id when nothing was
    // provided. The URL key always stays `<id><ext>` so persisted
    // node references remain stable.
    const uploadStem = data.filename
      ? path.basename(data.filename, path.extname(data.filename))
      : '';
    const displayName = uploadStem || id;

    let record;
    try {
      record = await store.writeArtifactStream(
        {
          id,
          displayName,
          source: uploadStem ? 'original' : 'auto',
          ext,
          mimeType: data.mimetype ?? null,
        },
        data.file,
      );
    } catch (error) {
      request.log.error({ err: error }, 'Failed to stream artifact to disk');
      return reply.code(500).send({ message: 'Failed to save file' });
    }

    const response: ArtifactUploadResponse = {
      id,
      // URL key is the stable `<id><ext>` so node `data.src` survives
      // any future display-name renames.
      uri: artifactApiPath(canvasId, `${id}${ext}`),
      filename: record.displayName + ext,
      mimetype: data.mimetype,
    };
    return reply.send(response);
  });

  fastify.get<{ Params: { canvasId: string; filename: string } }>(
    '/:canvasId/artifact/:filename',
    async (request, reply) => {
      const { canvasId, filename } = request.params;
      const store = getCanvasStore(canvasId);

      // Resolve the URL key (`<id><ext>` or legacy raw filename) to a
      // stored record so a renamed display name doesn't break old URLs.
      const record = store.resolveArtifactByKey(filename);
      const served = record?.filename ?? filename;
      try {
        return reply.sendFile(served, store.artifactsDir());
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
    Body: {
      srcCanvasId?: string;
      srcKey?: string;
      displayName?: string;
    };
  }>('/:canvasId/artifact/clone-from', async (request, reply) => {
    const { canvasId: dstCanvasId } = request.params;
    const {
      srcCanvasId,
      srcKey,
      displayName: requestedDisplayName,
    } = request.body ?? {};

    if (!srcCanvasId || !srcKey) {
      return reply
        .code(400)
        .send({ error: 'srcCanvasId and srcKey are required' });
    }

    const srcStore = getCanvasStore(srcCanvasId);
    const srcRecord = srcStore.resolveArtifactByKey(srcKey);
    const srcPath = srcStore.resolveArtifactFilePath(srcKey);
    if (!srcRecord || !srcPath) {
      return reply.code(404).send({ error: 'Source artifact not found' });
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(srcPath);
    } catch (err) {
      request.log.error({ err }, 'Failed to read source artifact for clone');
      return reply.code(500).send({ error: 'Failed to read source artifact' });
    }

    const dstStore = getCanvasStore(dstCanvasId);
    const id = createId('artifact');
    const displayName =
      (requestedDisplayName ?? srcRecord.displayName)?.trim() || id;

    let record;
    try {
      record = await dstStore.writeArtifactBuffer(
        {
          id,
          displayName,
          source: srcRecord.displayNameSource ?? 'original',
          ext: srcRecord.ext,
          mimeType: srcRecord.mimeType,
        },
        buffer,
      );
    } catch (err) {
      request.log.error({ err }, 'Failed to clone artifact');
      return reply.code(500).send({ error: 'Failed to save cloned artifact' });
    }

    return {
      id,
      uri: artifactApiPath(dstCanvasId, `${id}${record.ext}`),
      filename: record.displayName + record.ext,
      displayName: record.displayName,
      mimetype: record.mimeType,
    };
  });
};

export default artifactRoute;
