import { createReadStream, existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createId } from '@sediment/shared';
import { z } from 'zod';

import {
  readCanvas,
  writeCanvas,
  listCanvases,
  createCanvas,
  deleteCanvas,
  type CanvasFile,
  type NodeLike,
} from './canvas.filestore.js';
import { getExtFromMime, getMimeType } from '../../utils/mime.js';
import { getKnowledgeRepository } from '../knowledge/index.js';
import { getPreprocessDispatcher } from '../preprocessing/index.js';
import { getArtifactsDir } from '../workspace.js';

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
 * Strip derived `content` and `label` from nodes that already have a `sourceId`.
 * This avoids storing redundant copies in the canvas JSON - the knowledge
 * store is the single source of truth for content and title/label.
 *
 * Labels that were intentionally set by a user or the AI agent are preserved
 * in the canvas JSON so they survive save/load cycles without relying on
 * hydration from the knowledge store.
 */
function stripManagedContent(nodes: NodeLike[]): NodeLike[] {
  return nodes.map((node) => {
    if (!node.data?.sourceId) {
      return node;
    }

    // Strip `content`; the knowledge store owns it.
    // Preserve `content` as `contentSnapshot` for fallback.
    // Only strip `label` when it is auto-derived; keep intentional labels.
    const { content, label, ...dataRest } = node.data;
    const keepLabel =
      node.data.labelSource === 'user' || node.data.labelSource === 'agent';
    return {
      ...node,
      data: {
        ...dataRest,
        ...(keepLabel && label != null ? { label } : {}),
        ...(typeof content === 'string' ? { contentSnapshot: content } : {}),
      },
    };
  });
}

/**
 * Hydrate node `content` from the knowledge store for nodes that reference a source.
 * Only applies to note/text nodes that have a `sourceId`.
 */
async function hydrateNodeContent(nodes: NodeLike[]): Promise<NodeLike[]> {
  const repository = await getKnowledgeRepository();

  return nodes.map((node) => {
    const sourceId = node.data?.sourceId as string | undefined;
    if (!sourceId) {
      return node;
    }

    const source = repository.findSourceById(sourceId);

    // Fall back to contentSnapshot when the source cannot be found
    const content =
      source?.content ??
      (node.data?.contentSnapshot as string | undefined) ??
      '';

    // Hydrate label from source title.
    // When labelSource is 'auto' (or absent): always sync from the knowledge store.
    // When labelSource is 'user' or 'agent': only restore if the label was
    // stripped (missing) from a previous save cycle — preserves the
    // original labelSource so we don't downgrade to 'auto'.
    const labelPatch: Record<string, unknown> = {};
    if (source?.title) {
      if (
        node.data?.labelSource !== 'user' &&
        node.data?.labelSource !== 'agent'
      ) {
        labelPatch.label = source.title;
        labelPatch.labelSource = 'auto';
      } else if (!node.data?.label) {
        // Intentional label was stripped — restore from source as fallback
        labelPatch.label = source.title;
      }
    }

    return {
      ...node,
      data: {
        ...node.data,
        content,
        ...labelPatch,
      },
    };
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

  // Delete a node
  fastify.delete<{
    Params: { canvasId: string; nodeId: string };
  }>('/:canvasId/nodes/:nodeId', async function (_request, reply) {
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
    const dispatcher = await getPreprocessDispatcher();

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
      const canvas = readCanvas(canvasId);

      if (!canvas) {
        return reply.code(404).send({ message: 'Canvas not found' });
      }

      // Hydrate node content from knowledge store so clients always get fresh data
      const nodes = canvas.state.nodes as NodeLike[];
      const hydratedNodes = await hydrateNodeContent(nodes);

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

      const existing = readCanvas(canvasId);
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

      const leanNodes = stripManagedContent(
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

      writeCanvas(canvasFile);

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
      const canvas = readCanvas(canvasId);

      if (!canvas) {
        return reply.code(404).send({ message: 'Canvas not found' });
      }

      const nodes = (canvas.state.nodes ?? []) as NodeLike[];
      const edges = canvas.state.edges ?? [];

      // Collect all sourceIds referenced by nodes
      const sourceIds = nodes
        .map((n) => n.data?.sourceId as string | undefined)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      // Fetch corresponding knowledge sources
      const repository = await getKnowledgeRepository();
      const sources: ExportedSource[] = sourceIds
        .map((id) => repository.findSourceById(id))
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .map((s) => ({
          sourceId: s.sourceId,
          type: s.type,
          title: s.title ?? null,
          src: s.src ?? null,
          content: s.content,
          contentHash: s.contentHash,
          metaJson:
            (s as unknown as { metaJson?: string | null }).metaJson ?? null,
        }));

      // Collect PDF, image, and video artifacts
      const artifactsDir = getArtifactsDir();
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
      const safeName = (canvas.title ?? canvasId).replace(/[^a-z0-9_-]/gi, '_');
      const tmpFile = path.join(tmpdir(), `${createId('tmp')}.json`);
      await writeFile(tmpFile, JSON.stringify(bundle));

      const stream = createReadStream(tmpFile);
      stream.on('close', () => {
        unlink(tmpFile).catch(() => {});
      });

      return reply
        .header(
          'Content-Disposition',
          `attachment; filename="${safeName}.sediment.json"`,
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

    // 0. Normalise PDF cover images
    const artifactsDir = getArtifactsDir();
    const serverOrigin = `${request.protocol}://${request.headers.host as string}`;
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
          node.data!.coverUrl = `${serverOrigin}/api/artifact/${filename}`;
        } catch (err) {
          request.log.error(
            { filename, err },
            'Failed to write cover image during import',
          );
        }
      } else {
        const coverFilename = path.basename(coverUrl);
        const willExist =
          bundleArtifactFilenames.has(coverFilename) ||
          existsSync(path.join(artifactsDir, coverFilename));

        if (willExist) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          node.data!.coverUrl = `${serverOrigin}/api/artifact/${coverFilename}`;
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

    // 1. Write canvas state atomically
    const existing = readCanvas(targetCanvasId);
    const nextVersion = (existing?.version ?? 0) + 1;
    const timestamp = nowMs();

    const leanNodes = stripManagedContent(
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

    writeCanvas(canvasFile);

    // 2. Write sources into knowledge store (skip if sourceId already exists)
    const repository = await getKnowledgeRepository();
    let importedSources = 0;
    for (const src of bundle.sources) {
      if (repository.findSourceById(src.sourceId)) continue;

      repository.createSource({
        sourceId: src.sourceId,
        type: src.type as 'note' | 'text' | 'web' | 'pdf',
        title: src.title ?? undefined,
        src: src.src ?? undefined,
        content: src.content,
        contentHash: src.contentHash,
        metadata: src.metaJson
          ? (JSON.parse(src.metaJson) as Record<string, unknown>)
          : undefined,
      });
      importedSources++;
    }

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
