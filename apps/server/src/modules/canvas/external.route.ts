import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  importExternalNoteBodySchema,
  type ApiResult,
  type ExternalNoteEvent,
  type ImportExternalNoteRequest,
  type ImportExternalNoteResponse,
} from '@sediment/shared';

import {
  openExternalNoteSession,
  takeExternalNote,
} from './external-watcher.js';
import { parseFrontmatter } from '../../utils/markdown-frontmatter.js';
import { canvasRoot } from '../storage/paths.js';

import type { FastifyPluginAsync } from 'fastify';

function writeSSE(raw: NodeJS.WritableStream, event: ExternalNoteEvent): void {
  raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

const externalRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  // SSE stream of external note events for a single canvas. The stream is the
  // sole consumer of live external-note events, so it also owns the Space's
  // native `nodes/` watcher for as long as it stays connected.
  fastify.get<{ Params: { canvasId: string } }>(
    '/:canvasId/external/stream',
    async (request, reply) => {
      const { canvasId } = request.params;
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders?.();
      reply.raw.write(': ok\n\n');

      // Track disconnects that happen while the initial scan is still running
      // so the session is released and nothing is written to a dead response.
      let closed = false;
      let release: (() => void) | null = null;
      request.raw.on('close', () => {
        closed = true;
        release?.();
        try {
          reply.raw.end();
        } catch {
          /* already closed */
        }
      });

      const session = await openExternalNoteSession(canvasId, (event) => {
        if (closed) return;
        writeSSE(reply.raw, event);
      });
      if (closed) {
        session.close();
        return;
      }
      release = session.close;

      writeSSE(reply.raw, {
        type: 'snapshot',
        data: { items: session.snapshot },
      });
    },
  );

  // Claim an external file: read its contents, delete the file, and
  // return { label, content } so the client can call addNodes() the
  // same way it does for a toolbar drop.
  fastify.post<{
    Params: { canvasId: string };
    Body: ImportExternalNoteRequest;
    Reply: ApiResult<ImportExternalNoteResponse>;
  }>('/:canvasId/external/import', async (request, reply) => {
    const { canvasId } = request.params;
    const parsed = importExternalNoteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: parsed.error.issues[0]?.message ?? 'Invalid request body',
      });
    }

    const item = takeExternalNote(canvasId, parsed.data.relativePath);
    if (!item) {
      return reply.code(404).send({ message: 'External note not found' });
    }

    const abs = path.join(canvasRoot(canvasId), item.relativePath);
    let raw: string;
    try {
      raw = await readFile(abs, 'utf8');
    } catch {
      return reply.code(404).send({ message: 'File no longer exists' });
    }
    const { content } = parseFrontmatter(raw);
    try {
      await unlink(abs);
    } catch {
      /* watcher unlink event will reconcile if the file is gone */
    }

    const label = item.fileName.replace(/\.md$/i, '');
    return reply.send({ label, content });
  });
};

export default externalRoutes;
