import { createReadStream, existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createId } from '@sediment/shared';
import { z } from 'zod';

import { getExtFromMime, getMimeType } from '../../utils/mime.js';
import { ARTIFACT_API_PREFIX } from '../artifact/utils.js';
import { getPreprocessDispatcher } from '../preprocessing/index.js';
import {
  createCanvas,
  deleteCanvas,
  getCanvasStore,
  listCanvases,
  type CanvasFile,
} from '../storage/index.js';

import type { CanvasStore, NodeContent } from '../storage/canvas-store.js';
import type {
  CanvasExportBundle,
  CanvasNodeKind,
  ExportedSource,
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

  // --- Export Canvas ---

  fastify.get<{ Params: { canvasId: string } }>(
    '/:canvasId/export',
    async function (request, reply) {
      const { canvasId } = request.params;
      const store = getCanvasStore(canvasId);
      const canvas = store.read();

      if (!canvas) {
        return reply.code(404).send({ message: 'Canvas not found' });
      }

      const nodes = (canvas.state.nodes ?? []) as NodeLike[];
      const edges = canvas.state.edges ?? [];

      // Build exported sources from per-node markdown content.
      const sources: ExportedSource[] = [];
      for (const node of nodes) {
        const nodeId = typeof node.id === 'string' ? node.id : '';
        if (!nodeId) continue;
        const nodeContent = store.readNode(nodeId);
        if (!nodeContent) continue;
        sources.push({
          sourceId: nodeId,
          type: nodeContent.type,
          title: nodeContent.title ?? null,
          src: nodeContent.src ?? null,
          content: nodeContent.content,
          contentHash: nodeContent.contentHash,
          metaJson: nodeContent.metadata
            ? JSON.stringify(nodeContent.metadata)
            : null,
        });
      }

      // Collect PDF, image, and video artifacts
      const artifactsDir = store.artifactsDir();
      const artifactEntries: CanvasExportBundle['artifacts'] = [];

      for (const node of nodes) {
        if (
          node.type !== 'pdf' &&
          node.type !== 'image' &&
          node.type !== 'video'
        )
          continue;
        const src = node.data?.src as string | undefined;
        if (!src) continue;

        const filename = path.basename(src);
        const filePath = path.join(artifactsDir, filename);

        try {
          const data = await readFile(filePath);
          artifactEntries.push({
            filename,
            data: data.toString('base64'),
            mimeType: getMimeType(filename),
          });
        } catch {
          request.log.warn(
            { filename, nodeType: node.type },
            'Artifact not found during export',
          );
        }
      }

      // Normalise artifact src to portable relative paths (strip any absolute origin)
      for (const node of nodes) {
        if (
          node.type !== 'pdf' &&
          node.type !== 'image' &&
          node.type !== 'video'
        )
          continue;
        const src = node.data?.src as string | undefined;
        if (!src) continue;
        const artifactIdx = src.indexOf(ARTIFACT_API_PREFIX);
        if (artifactIdx !== -1) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          node.data!.src = src.slice(artifactIdx);
        }
      }

      // Convert PDF cover URLs to inline data URLs for cross-machine portability
      for (const node of nodes) {
        if (node.type !== 'pdf') continue;
        const coverUrl = node.data?.coverUrl as string | undefined;
        if (!coverUrl || coverUrl.startsWith('data:')) continue;

        const coverFilename = path.basename(coverUrl);
        const coverPath = path.join(artifactsDir, coverFilename);
        try {
          const coverData = await readFile(coverPath);
          const coverMime = getMimeType(coverFilename);
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          node.data!.coverUrl = `data:${coverMime};base64,${coverData.toString('base64')}`;
        } catch {
          request.log.warn(
            { filename: coverFilename },
            'Cover image not found during export, removing coverUrl',
          );
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          delete node.data!.coverUrl;
        }
      }

      const bundle: CanvasExportBundle = {
        manifest: {
          version: '1.0',
          exportedAt: new Date().toISOString(),
          canvasId,
          title: canvas.title ?? 'Untitled',
        },
        canvas: {
          nodes,
          edges,
        },
        sources,
        artifacts: artifactEntries,
      };

      // Write bundle to a temp file, then stream it to avoid holding the
      // entire serialised JSON (which can be huge due to base64 artifacts)
      // in memory for the duration of the HTTP transfer.
      const rawName = `${canvas.title ?? canvasId}.sediment.json`;
      const asciiFallback = rawName
        .replace(/[^\x20-\x7E]/g, '_')
        .replace(/[;'"\\]/g, '_');
      const encodedName = encodeURIComponent(rawName);
      const tmpFile = path.join(tmpdir(), `${createId('tmp')}.json`);
      await writeFile(tmpFile, JSON.stringify(bundle));

      const stream = createReadStream(tmpFile);
      stream.on('close', () => {
        unlink(tmpFile).catch(() => {});
      });

      return reply
        .header(
          'Content-Disposition',
          `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`,
        )
        .header('Content-Type', 'application/json')
        .send(stream);
    },
  );

  // --- Import Canvas ---

  const importBodySchema = z.object({
    manifest: z.object({
      version: z.string(),
      exportedAt: z.string(),
      canvasId: z.string(),
      title: z.string().nullable().optional(),
    }),
    canvas: z.object({
      nodes: z.array(z.unknown()),
      edges: z.array(z.unknown()),
    }),
    sources: z.array(
      z.object({
        sourceId: z.string(),
        type: z.string(),
        title: z.string().nullable(),
        src: z.string().nullable(),
        content: z.string(),
        contentHash: z.string(),
        metaJson: z.string().nullable(),
      }),
    ),
    artifacts: z.array(
      z.object({
        filename: z.string().min(1).max(255),
        data: z.string(),
        mimeType: z.string(),
      }),
    ),
  });

  fastify.post<{ Body: unknown }>('/import', async function (request, reply) {
    const parsed = importBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: 'Invalid import bundle',
        details: parsed.error.format(),
      });
    }

    const bundle = parsed.data;
    // Always generate a new canvas ID so imports never overwrite existing canvases
    const targetCanvasId = createId('canvas');
    const targetTitle = bundle.manifest.title ?? 'Untitled';
    createCanvas(targetCanvasId, targetTitle);
    const targetStore = getCanvasStore(targetCanvasId);

    // 0. Normalise PDF cover images — convert inline base64 data URLs to files
    const artifactsDir = targetStore.artifactsDir();
    const bundleArtifactFilenames = new Set(
      bundle.artifacts.map((a) => path.basename(a.filename)),
    );

    for (const raw of bundle.canvas.nodes) {
      const node = raw as NodeLike;
      if (node.type !== 'pdf') continue;
      const coverUrl = node.data?.coverUrl as string | undefined;
      if (!coverUrl) continue;

      if (coverUrl.startsWith('data:')) {
        const match = coverUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) continue;

        const [, mimeType, base64Data] = match;
        const ext = getExtFromMime(mimeType);
        const artifactId = createId('artifact');
        const filename = `${artifactId}${ext}`;
        const destPath = path.join(artifactsDir, filename);

        try {
          await writeFile(
            destPath,
            new Uint8Array(Buffer.from(base64Data, 'base64')),
          );
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          node.data!.coverUrl = `${ARTIFACT_API_PREFIX}/${filename}`;
        } catch (err) {
          request.log.error(
            { filename, err },
            'Failed to write cover image during import',
          );
        }
      } else {
        // Normalise cover URL to relative path
        const coverFilename = path.basename(coverUrl);
        const willExist =
          bundleArtifactFilenames.has(coverFilename) ||
          existsSync(path.join(artifactsDir, coverFilename));

        if (willExist) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          node.data!.coverUrl = `${ARTIFACT_API_PREFIX}/${coverFilename}`;
        } else {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          delete node.data!.coverUrl;
          request.log.warn(
            { coverFilename },
            'Cover image not available during import, removed coverUrl',
          );
        }
      }
    }

    // 0b. Normalise artifact src to relative paths
    for (const raw of bundle.canvas.nodes) {
      const node = raw as NodeLike;
      if (node.type !== 'image' && node.type !== 'video' && node.type !== 'pdf')
        continue;
      const src = node.data?.src as string | undefined;
      if (!src) continue;

      const srcFilename = path.basename(src);
      const willExist =
        bundleArtifactFilenames.has(srcFilename) ||
        existsSync(path.join(artifactsDir, srcFilename));

      if (willExist) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        node.data!.src = `${ARTIFACT_API_PREFIX}/${srcFilename}`;
      }
    }

    // 1. Write canvas state atomically
    const existing = targetStore.read();
    const nextVersion = (existing?.version ?? 0) + 1;
    const timestamp = nowMs();

    // 2. Persist sources as per-node markdown into the new canvas store first,
    // so persistAndStripNodes below can preserve any node-level fields.
    let importedSources = 0;
    for (const src of bundle.sources) {
      try {
        targetStore.writeNode(src.sourceId, {
          nodeId: src.sourceId,
          type: src.type,
          title: src.title ?? null,
          src: src.src ?? null,
          content: src.content,
          contentHash: src.contentHash,
          metadata: src.metaJson
            ? (JSON.parse(src.metaJson) as Record<string, unknown>)
            : {},
        });
        importedSources++;
      } catch {
        // Best effort — skip entries with unsanitisable ids.
      }
    }

    const leanNodes = persistAndStripNodes(
      targetStore,
      (bundle.canvas.nodes ?? []) as NodeLike[],
    );

    const canvasFile: CanvasFile = {
      canvasId: targetCanvasId,
      title: bundle.manifest.title ?? null,
      version: nextVersion,
      state: {
        nodes: leanNodes,
        edges: bundle.canvas.edges ?? [],
      },
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    targetStore.write(canvasFile);

    // 3. Write artifacts to disk (best-effort)
    let importedArtifacts = 0;
    for (const artifact of bundle.artifacts) {
      const safeFilename = path.basename(artifact.filename);
      if (!safeFilename) continue;

      const destPath = path.join(artifactsDir, safeFilename);
      try {
        await writeFile(
          destPath,
          new Uint8Array(Buffer.from(artifact.data, 'base64')),
        );
        importedArtifacts++;
      } catch (err) {
        request.log.error(
          { filename: safeFilename, err },
          'Failed to write artifact during import',
        );
      }
    }

    const response: ImportCanvasResponse = {
      canvasId: targetCanvasId,
      importedSources,
      importedArtifacts,
    };
    return reply.send(response);
  });
};

export default canvasRoutes;
