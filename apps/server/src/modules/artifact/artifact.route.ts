// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import path from 'node:path';

import { type FastifyPluginAsync } from 'fastify';

import { cloneArtifactBodySchema, createId } from '@huabu/shared';

import { sendBlob } from './send-blob.js';
import { space } from '../storage/index.js';
import { extractHtmlFromMhtml, injectBaseHref } from '../web/mhtml.js';

import type {
  ApiResult,
  ArtifactUploadResponse,
  CloneArtifactRequest,
} from '@huabu/shared';

/**
 * Canvas-scoped artifact route. Mount under `/api/canvas`.
 *
 *   POST /:canvasId/artifact/:type          → upload (image | pdf | office | video | audio | html)
 *   GET  /:canvasId/artifact/:filename      → serve (filename = `<id><ext>`)
 *   POST /:canvasId/artifact/clone-from     → cross-canvas copy
 *
 * The blob name equals the URL key, so a node's `data.src` resolves
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
      audio: '.webm',
      html: '.html',
      office: '.docx',
    };

    if (!typeExtMap[type]) {
      return reply.code(400).send({
        message:
          'Invalid type. Must be image, pdf, video, audio, html, or office',
      });
    }

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ message: 'No file provided' });
    }

    const id = createId('artifact');
    const uploadedExt = path.extname(data.filename ?? '');
    const ext = uploadedExt || typeExtMap[type];
    const name = `${id}${ext}`;

    try {
      await space(canvasId).blobs.put(name, data.file);
    } catch (error) {
      request.log.error({ err: error }, 'Failed to stream artifact to storage');
      return reply.code(500).send({ message: 'Failed to save file' });
    }

    // `uri` carries only the artifact key (`<id><ext>`); callers build
    // the canvas-scoped URL at render time.
    const response: ArtifactUploadResponse = {
      id,
      uri: name,
      filename: data.filename ?? name,
      mimetype: data.mimetype,
    };
    return reply.send(response);
  });

  fastify.get<{ Params: { canvasId: string; filename: string } }>(
    '/:canvasId/artifact/:filename',
    async (request, reply) => {
      const { canvasId, filename } = request.params;
      const blobs = space(canvasId).blobs;
      const safeName = path.basename(filename);

      // `.mhtml` snapshots are stored as proper multipart/related MHTML
      // (so they remain valid offline archives — drop the file into
      // Chromium and it opens correctly). For in-app iframe rendering
      // we strip the wrapper on the fly and serve the inner HTML as
      // `text/html` so no browser-side MHTML handler is required.
      if (safeName.toLowerCase().endsWith('.mhtml')) {
        const buffer = await blobs.read(safeName);
        if (!buffer) {
          return reply.code(404).send({ message: 'Artifact not found' });
        }
        const extracted = extractHtmlFromMhtml(buffer);
        if (!extracted) {
          // Malformed snapshot — fall back to serving the raw bytes so
          // the user can still download / inspect the file.
          return reply.header('Content-Type', 'message/rfc822').send(buffer);
        }
        const html = extracted.sourceUrl
          ? injectBaseHref(extracted.html, extracted.sourceUrl)
          : extracted.html;
        return (
          reply
            .header('Content-Type', 'text/html; charset=utf-8')
            // Allow same-origin iframe; the canvas web node always
            // loads us via a sandboxed iframe so this is purely
            // defensive against accidental top-level navigation.
            .header('X-Content-Type-Options', 'nosniff')
            .send(html)
        );
      }

      const served = await sendBlob(request, reply, blobs, safeName);
      if (!served) {
        return reply.code(404).send({ message: 'Artifact not found' });
      }
      return reply;
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

    let buffer: Buffer | null;
    try {
      buffer = await space(srcCanvasId).blobs.read(srcKey);
    } catch (err) {
      request.log.error({ err }, 'Failed to read source artifact for clone');
      return reply
        .code(500)
        .send({ message: 'Failed to read source artifact' });
    }
    if (!buffer) {
      return reply.code(404).send({ message: 'Source artifact not found' });
    }

    const id = createId('artifact');
    const ext = path.extname(srcKey);
    const name = `${id}${ext}`;

    try {
      await space(dstCanvasId).blobs.put(name, buffer);
    } catch (err) {
      request.log.error({ err }, 'Failed to clone artifact');
      return reply
        .code(500)
        .send({ message: 'Failed to save cloned artifact' });
    }

    // Mirror the upload route: return only the bare key.
    const response: ArtifactUploadResponse = {
      id,
      uri: name,
      filename: name,
      // The byte store carries no MIME metadata; the HTTP boundary infers the
      // representation type from this filename.
      mimetype: undefined,
    };
    return reply.send(response);
  });
};

export default artifactRoute;
