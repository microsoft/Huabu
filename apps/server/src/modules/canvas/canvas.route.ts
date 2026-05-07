import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createId } from '@sediment/shared';
import archiver from 'archiver';
import { z } from 'zod';

import { getPreprocessDispatcher } from '../preprocessing/index.js';
import {
  createCanvas,
  deleteCanvas,
  getCanvasStore,
  listCanvases,
  type CanvasFile,
} from '../storage/index.js';
import { getWorkspacePath } from '../workspace.js';

import type { CanvasStore, NodeContent } from '../storage/canvas-store.js';
import type {
  CanvasNodeKind,
  ImportCanvasResponse,
  PreprocessNodeRequest,
  PreprocessNodeResponse,
  TriggerReason,
} from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Loose node type for processing unknown/untyped node structures.
 * Used when iterating over canvas state before validation.
 */
interface NodeLike {
  id?: string;
  type?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

function nowMs(): number {
  return Date.now();
}

/**
 * Generate a default canvas title that doesn't collide with existing ones.
 * Returns "Untitled", "Untitled (1)", "Untitled (2)", etc.
 */
function generateDefaultTitle(existingCanvases: CanvasFile[]): string {
  const base = 'Untitled';
  const existingNames = new Set(existingCanvases.map((c) => c.title));
  if (!existingNames.has(base)) return base;
  let i = 1;
  while (existingNames.has(`${base} (${i})`)) i++;
  return `${base} (${i})`;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Persist node markdown into the canvas store and return canvas-state
 * nodes with the bulky `content` / `contentSnapshot` fields stripped.
 *
 * Labels intentionally set by a user or the agent are preserved on the
 * canvas node so they survive save/load cycles without depending on the
 * node markdown.
 */
function persistAndStripNodes(
  store: CanvasStore,
  nodes: NodeLike[],
): NodeLike[] {
  return nodes.map((node) => {
    const data = node.data ?? {};
    const nodeId = typeof node.id === 'string' ? node.id : '';
    const content =
      typeof data['content'] === 'string'
        ? (data['content'] as string)
        : undefined;

    if (nodeId && typeof content === 'string') {
      const existing = store.readNode(nodeId);
      const nodeContent: NodeContent = {
        nodeId,
        type:
          typeof node.type === 'string'
            ? node.type
            : (existing?.type ?? 'note'),
        title:
          typeof data['label'] === 'string'
            ? (data['label'] as string)
            : (existing?.title ?? null),
        src:
          typeof data['src'] === 'string'
            ? (data['src'] as string)
            : (existing?.src ?? null),
        content,
        contentHash: existing?.contentHash ?? '',
        metadata: existing?.metadata ?? {},
      };
      try {
        store.writeNode(nodeId, nodeContent);
      } catch {
        // Best effort — skip nodes whose id fails sanitisation.
      }
    }

    const { content: _omitContent, ...dataRest } = data;
    const keepLabel =
      data['labelSource'] === 'user' || data['labelSource'] === 'agent';
    const cleanData: Record<string, unknown> = { ...dataRest };
    if (!keepLabel) delete cleanData['label'];
    return { ...node, data: cleanData };
  });
}

/**
 * Hydrate node content from the canvas store. Reads the per-node
 * markdown file and re-attaches `content` / `label` (when auto-derived)
 * onto each node so callers see fresh data.
 */
function hydrateNodeContent(store: CanvasStore, nodes: NodeLike[]): NodeLike[] {
  return nodes.map((node) => {
    const nodeId = typeof node.id === 'string' ? node.id : '';
    if (!nodeId) return node;

    let nodeContent: NodeContent | null = null;
    try {
      nodeContent = store.readNode(nodeId);
    } catch {
      nodeContent = null;
    }
    if (!nodeContent) return node;

    const data = { ...(node.data ?? {}) };
    data['content'] = nodeContent.content;

    if (nodeContent.title) {
      const labelSource = data['labelSource'];
      if (labelSource !== 'user' && labelSource !== 'agent') {
        data['label'] = nodeContent.title;
        data['labelSource'] = 'auto';
      } else if (!data['label']) {
        data['label'] = nodeContent.title;
      }
    }

    return { ...node, data };
  });
}

const putCanvasBodySchema = z.object({
  version: z.number().int().nonnegative(),
  state: z.unknown(),
  title: z.string().min(1).optional(),
});

const createCanvasBodySchema = z.object({
  title: z.string().min(1).optional(),
});

const canvasRoutes: FastifyPluginAsync = async (fastify) => {
  // --- List all canvases ---

  fastify.get('/', async function (_request, reply) {
    const canvases = listCanvases();

    const summaries = canvases.map((c) => ({
      canvasId: c.canvasId,
      title: c.title,
      nodeCount: Array.isArray(c.state.nodes) ? c.state.nodes.length : 0,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));

    // Sort by most recently updated first
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);

    return reply.send({ canvases: summaries });
  });

  // --- Create a new canvas ---

  fastify.post<{ Body: unknown }>('/', async function (request, reply) {
    const parsed = createCanvasBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid request body' });
    }

    const canvasId = createId('canvas');
    const existingCanvases = listCanvases();
    const title = parsed.data.title ?? generateDefaultTitle(existingCanvases);
    const canvas = createCanvas(canvasId, title);

    if (!canvas) {
      return reply
        .code(409)
        .send({ message: 'Canvas with this ID already exists' });
    }

    return reply
      .code(201)
      .send({ canvasId: canvas.canvasId, title: canvas.title });
  });

  // --- Delete a canvas ---

  fastify.delete<{ Params: { canvasId: string } }>(
    '/:canvasId',
    async function (request, reply) {
      const { canvasId } = request.params;
      const deleted = deleteCanvas(canvasId);

      if (!deleted) {
        return reply.code(404).send({ message: 'Canvas not found' });
      }

      return reply.send({ success: true });
    },
  );

  // Delete a node — removes its markdown, plus the node and any
  // incident edges from the canvas JSON.
  fastify.delete<{
    Params: { canvasId: string; nodeId: string };
  }>('/:canvasId/nodes/:nodeId', async function (request, reply) {
    const { canvasId, nodeId } = request.params;
    const store = getCanvasStore(canvasId);
    const canvas = store.read();
    if (!canvas) {
      return reply.code(404).send({ message: 'Canvas not found' });
    }

    store.deleteNode(nodeId);

    const nodes = (canvas.state.nodes ?? []) as NodeLike[];
    const remainingNodes = nodes.filter((n) => n.id !== nodeId);
    const edges = (canvas.state.edges ?? []) as Array<Record<string, unknown>>;
    const remainingEdges = edges.filter(
      (e) => e.source !== nodeId && e.target !== nodeId,
    );

    if (
      remainingNodes.length !== nodes.length ||
      remainingEdges.length !== edges.length
    ) {
      store.write({
        ...canvas,
        version: canvas.version + 1,
        state: {
          ...canvas.state,
          nodes: remainingNodes,
          edges: remainingEdges,
        },
        updatedAt: nowMs(),
      });
    }

    return reply.send({ success: true });
  });

  // --- Unified preprocessing endpoint ---
  // Single route that handles all node types (note/text/web/pdf/image/frame/video).
  // Replaces the split between PUT /:canvasId/nodes/:nodeId and POST /resolve-label.

  const preprocessBodySchema = z.object({
    nodeType: z.enum(['note', 'text', 'web', 'pdf', 'image', 'video', 'frame']),
    trigger: z
      .enum(['node_inserted', 'node_updated', 'flush', 'manual', 'repair'])
      .optional(),
    snapshot: z.record(z.string(), z.unknown()),
    options: z
      .object({
        allowLLM: z.boolean().optional(),
        allowPersistence: z.boolean().optional(),
        force: z.boolean().optional(),
      })
      .optional(),
  });

  fastify.post<{
    Params: { canvasId: string; nodeId: string };
    Body: unknown;
  }>('/:canvasId/nodes/:nodeId/preprocess', async function (request, reply) {
    const { canvasId, nodeId } = request.params;
    const parsed = preprocessBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid request body' });
    }

    const { nodeType, trigger, snapshot, options } = parsed.data;
    const dispatcher = getPreprocessDispatcher();

    try {
      const ppRequest: PreprocessNodeRequest = {
        canvasId,
        nodeId,
        nodeType: nodeType as CanvasNodeKind,
        trigger: (trigger ?? 'node_updated') as TriggerReason,
        snapshot,
        options: {
          allowLLM: options?.allowLLM ?? true,
          allowPersistence: options?.allowPersistence ?? true,
          force: options?.force ?? false,
        },
      };

      const result = await dispatcher.preprocess(ppRequest);

      return reply.send({
        nodeId,
        success: result.success,
        sourceId: result.persistence?.sourceId ?? undefined,
        suggestedLabel:
          typeof result.patch.label === 'string'
            ? result.patch.label
            : undefined,
        error:
          result.diagnostics
            .filter((d) => d.level === 'error')
            .map((d) => `${d.code}: ${d.message}`)
            .join('; ') || undefined,
      } satisfies PreprocessNodeResponse);
    } catch (error) {
      const message = toMessage(error);
      request.log.error(
        { nodeId, nodeType, error },
        'Failed to preprocess node',
      );
      return reply.code(500).send({
        message: 'Failed to preprocess node',
        details: message,
      });
    }
  });

  // --- GET Canvas ---

  fastify.get<{ Params: { canvasId: string } }>(
    '/:canvasId',
    async function (request, reply) {
      const { canvasId } = request.params;
      const store = getCanvasStore(canvasId);
      const canvas = store.read();

      if (!canvas) {
        return reply.code(404).send({ message: 'Canvas not found' });
      }

      // Hydrate node content from the per-canvas store so clients always
      // receive fresh markdown bodies.
      const nodes = canvas.state.nodes as NodeLike[];
      const hydratedNodes = hydrateNodeContent(store, nodes);

      return reply.send({
        canvasId: canvas.canvasId,
        title: canvas.title,
        version: canvas.version,
        state: {
          ...canvas.state,
          nodes: hydratedNodes,
        },
      });
    },
  );

  // --- PUT Canvas ---

  fastify.put<{ Params: { canvasId: string }; Body: unknown }>(
    '/:canvasId',
    async function (request, reply) {
      const { canvasId } = request.params;
      const parsed = putCanvasBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ message: 'Invalid request body' });
      }

      const { version: clientVersion, state, title } = parsed.data;

      const store = getCanvasStore(canvasId);
      const existing = store.read();
      const serverVersion = existing?.version ?? 0;
      if (clientVersion !== serverVersion) {
        return reply
          .code(409)
          .send({ message: 'Canvas version mismatch', serverVersion });
      }

      const timestamp = nowMs();
      const nextVersion = serverVersion + 1;

      const rawState = state as {
        nodes?: NodeLike[];
        edges?: unknown[];
        [key: string]: unknown;
      };

      const leanNodes = persistAndStripNodes(
        store,
        (rawState?.nodes ?? []) as NodeLike[],
      );

      const canvasFile: CanvasFile = {
        canvasId,
        title: title ?? existing?.title ?? null,
        version: nextVersion,
        state: {
          ...rawState,
          nodes: leanNodes,
          edges: rawState?.edges ?? [],
        },
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };

      store.write(canvasFile);

      return reply.send({
        canvasId,
        version: nextVersion,
      });
    },
  );

  // --- Export Canvas (zip) ---

  /**
   * Stream the entire `<canvasId>/` directory as a `.sediment.zip` archive.
   *
   * The zip mirrors the on-disk layout (canvas.json, nodes/, artifacts/,
   * memory/, .history/) with a `manifest.json` at the root identifying
   * the export version and source canvas id.
   */
  fastify.get<{
    Params: { canvasId: string };
    Querystring: { includeHistory?: string };
  }>('/:canvasId/export', async function (request, reply) {
    const { canvasId } = request.params;
    const includeHistory = request.query.includeHistory !== 'false';

    const store = getCanvasStore(canvasId);
    const canvas = store.read();
    if (!canvas) {
      return reply.code(404).send({ message: 'Canvas not found' });
    }

    const canvasDir = path.join(getWorkspacePath(), canvasId);
    if (!existsSync(canvasDir)) {
      return reply.code(404).send({ message: 'Canvas directory not found' });
    }

    const manifest = {
      version: '2',
      exportedAt: new Date().toISOString(),
      sourceCanvasId: canvasId,
      title: canvas.title,
    };

    const rawName = `${canvas.title ?? canvasId}.sediment.zip`;
    const asciiFallback = rawName
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/[;'"\\]/g, '_');
    const encodedName = encodeURIComponent(rawName);

    reply
      .header(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`,
      )
      .header('Content-Type', 'application/zip');

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', (err) => {
      request.log.warn({ err }, 'archiver warning during export');
    });
    archive.on('error', (err) => {
      request.log.error({ err }, 'archiver error during export');
    });

    archive.append(JSON.stringify(manifest, null, 2), {
      name: 'manifest.json',
    });
    archive.glob('**/*', {
      cwd: canvasDir,
      dot: includeHistory,
      ignore: includeHistory ? [] : ['.history/**'],
    });

    void archive.finalize();
    return reply.send(archive);
  });

  // --- Import Canvas (folder upload) ---
  //
  // Expects a multipart upload containing every file in the canvas folder.
  // Each file part's `fieldname` is treated as its path relative to the
  // selected folder (e.g. `MyCanvas/canvas.json`, `MyCanvas/nodes/x.md`),
  // matching what the browser provides via `File.webkitRelativePath`.
  //
  // The leading folder segment is stripped before writing so the contents
  // land directly under the new canvas directory. If `canvas.json` is not
  // found in the upload, an empty canvas is created instead.
  fastify.post('/import', async function (request, reply) {
    const targetCanvasId = createId('canvas');
    const targetDir = path.join(getWorkspacePath(), targetCanvasId);

    try {
      mkdirSync(targetDir, { recursive: true });

      let receivedAny = false;
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type !== 'file') continue;
        receivedAny = true;

        // The browser sends each file under fieldname = relative path.
        // Fall back to filename if a client posts without a relative path.
        const rawPath = part.fieldname || part.filename || '';
        const relPath = stripLeadingFolder(rawPath);

        if (!relPath) {
          // Drain the stream to allow the next part to be read.
          await new Promise<void>((resolve, reject) => {
            part.file.on('end', () => resolve());
            part.file.on('error', reject);
            part.file.resume();
          });
          continue;
        }

        const dest = path.join(targetDir, relPath);
        if (!dest.startsWith(targetDir + path.sep)) {
          // Path traversal guard — drain & skip.
          await new Promise<void>((resolve, reject) => {
            part.file.on('end', () => resolve());
            part.file.on('error', reject);
            part.file.resume();
          });
          continue;
        }

        await mkdir(path.dirname(dest), { recursive: true });
        await new Promise<void>((resolve, reject) => {
          const ws = createWriteStream(dest);
          part.file.pipe(ws);
          ws.on('finish', () => resolve());
          ws.on('error', reject);
          part.file.on('error', reject);
        });
      }

      const canvasJsonPath = path.join(targetDir, 'canvas.json');

      // No canvas.json in the uploaded folder → fall back to creating
      // a fresh, empty canvas instead.
      if (!receivedAny || !existsSync(canvasJsonPath)) {
        await rm(targetDir, { recursive: true, force: true });
        const fallback = createCanvas(
          targetCanvasId,
          generateDefaultTitle(listCanvases()),
        );
        if (!fallback) {
          return reply
            .code(500)
            .send({ message: 'Failed to create fallback canvas' });
        }
        const response: ImportCanvasResponse = {
          canvasId: fallback.canvasId,
          importedSources: 0,
          importedArtifacts: 0,
        };
        return reply.send(response);
      }

      // Rewrite canvas.json so canvasId matches the new directory.
      const raw = await readFile(canvasJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as CanvasFile;
      const sourceCanvasId = parsed.canvasId;
      const targetTitle = parsed.title ?? 'Imported canvas';

      const remapped: CanvasFile = {
        ...parsed,
        canvasId: targetCanvasId,
        title: targetTitle,
        state: rewriteCanvasArtifactUrls(
          parsed.state,
          sourceCanvasId,
          targetCanvasId,
        ),
      };
      await writeFile(canvasJsonPath, JSON.stringify(remapped));

      const response: ImportCanvasResponse = {
        canvasId: targetCanvasId,
        importedSources: 0,
        importedArtifacts: 0,
      };
      return reply.send(response);
    } catch (err) {
      request.log.error({ err }, 'Failed to import canvas folder');
      await rm(targetDir, { recursive: true, force: true }).catch(() => {});
      return reply.code(500).send({ message: 'Failed to import canvas' });
    }
  });
};

/**
 * Normalize an uploaded file path: convert backslashes to forward
 * slashes, strip a single leading folder segment (the folder the user
 * selected), and reject empty / dot / parent-relative segments.
 */
function stripLeadingFolder(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return '';
  const parts = normalized.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) return '';
  // If the upload preserves the selected folder name, strip it. A flat
  // upload (single file with no folder prefix) is kept as-is.
  if (parts.length > 1) parts.shift();
  return parts.join('/');
}

/**
 * Rewrite `/api/canvas/<old>/artifact/<file>` URLs inside canvas state to
 * point at the freshly-allocated canvas id. Mutates and returns the input.
 */
function rewriteCanvasArtifactUrls<T>(
  state: T,
  fromCanvasId: string,
  toCanvasId: string,
): T {
  const fromPrefix = `/api/canvas/${fromCanvasId}/artifact/`;
  const toPrefix = `/api/canvas/${toCanvasId}/artifact/`;
  const json = JSON.stringify(state).split(fromPrefix).join(toPrefix);
  return JSON.parse(json) as T;
}

export default canvasRoutes;
