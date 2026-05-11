import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createCanvasBodySchema,
  createId,
  exportCanvasQuerySchema,
  getCanvasEventsQuerySchema,
  postCanvasEventsBodySchema,
  preprocessNodeBodySchema,
  putCanvasBodySchema,
} from '@sediment/shared';
import archiver from 'archiver';
import yauzl from 'yauzl';

import { ARTIFACT_URL_REGEX } from '../artifact/utils.js';
import { getPreprocessDispatcher } from '../preprocessing/index.js';
import {
  refreshCanvasDirIndex,
  registerCanvasDir,
  suggestCanvasDir,
} from '../storage/canvas-dirs.js';
import {
  createCanvas,
  deleteCanvas,
  getCanvasStore,
  listCanvases,
  type CanvasFile,
} from '../storage/index.js';
import { canvasRoot } from '../storage/paths.js';
import { getWorkspacePath } from '../workspace.js';

import type { CanvasStore, NodeContent } from '../storage/canvas-store.js';
import type {
  ApiResult,
  CanvasConflictResponse,
  CreateCanvasRequest,
  CreateCanvasResponse,
  DeleteCanvasResponse,
  DeleteNodeResponse,
  ExportCanvasQuery,
  GetCanvasEventsQuery,
  GetCanvasEventsResponse,
  GetCanvasResponse,
  ImportCanvasResponse,
  ListCanvasesResponse,
  PostCanvasEventsRequest,
  PostCanvasEventsResponse,
  PreprocessNodeBody,
  PreprocessNodeRequest,
  PreprocessNodeResponse,
  PutCanvasRequest,
  PutCanvasResponse,
  RenamedNode,
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
 * Node types that have a sibling `nodes/<safe(label)>.md`. The body is
 * markdown content for note/text/web/pdf and empty for image/video/frame
 * (which only carry frontmatter).
 */
const MD_BACKED_NODE_TYPES = new Set([
  'note',
  'text',
  'web',
  'pdf',
  'image',
  'video',
  'frame',
]);

/** Subset that carries a textual body in the markdown. */
const TEXT_BEARING_NODE_TYPES = new Set(['note', 'text', 'web', 'pdf']);

/**
 * Persist node markdown into the canvas store and return canvas-state
 * nodes with the bulky `content` field stripped.
 *
 * Labels intentionally set by a user or the agent are preserved on the
 * canvas node so they survive save/load cycles without depending on the
 * node markdown.
 *
 * Strict (user-typed) renames are validated in a pre-pass against the
 * existing on-disk index AND against other strict renames in the same
 * batch, so a mid-batch conflict cannot leave canvas.json out of sync
 * with the freshly renamed `.md` files.
 */
type PersistResult =
  | {
      kind: 'ok';
      nodes: NodeLike[];
      renamed: RenamedNode[];
    }
  | {
      kind: 'conflict';
      nodeId: string;
      label: string;
      conflictWith: string;
    };

function persistAndStripNodes(
  store: CanvasStore,
  nodes: NodeLike[],
): PersistResult {
  // Pre-pass: validate every strict (user-typed) rename against the
  // existing on-disk index AND against other strict renames in this
  // same batch. We surface a 409 BEFORE touching disk so a mid-batch
  // conflict can't leave canvas.json out of sync with the freshly
  // renamed `.md` files.
  const normalize = (s: string) => s.normalize('NFC').toLowerCase();
  const reservedSlots = new Map<string, string>(); // norm(filename) → nodeId
  for (const node of nodes) {
    const data = node.data ?? {};
    const nodeId = typeof node.id === 'string' ? node.id : '';
    const nodeType = typeof node.type === 'string' ? node.type : '';
    if (!nodeId || !MD_BACKED_NODE_TYPES.has(nodeType)) continue;
    if (data['labelSource'] !== 'user') continue;
    const label =
      typeof data['label'] === 'string' ? (data['label'] as string) : null;
    let preview: ReturnType<CanvasStore['checkNodeRename']>;
    try {
      preview = store.checkNodeRename(nodeId, label);
    } catch {
      continue; // bad nodeId — let the write loop's catch handle it
    }
    if (preview.conflict) {
      return {
        kind: 'conflict',
        nodeId,
        label: label ?? '',
        conflictWith: preview.conflict.filename,
      };
    }
    const slot = normalize(preview.desired);
    const owner = reservedSlots.get(slot);
    if (owner && owner !== nodeId) {
      return {
        kind: 'conflict',
        nodeId,
        label: label ?? '',
        conflictWith: preview.desired,
      };
    }
    reservedSlots.set(slot, nodeId);
  }

  const out: NodeLike[] = new Array(nodes.length);
  const renamed: RenamedNode[] = [];
  // Process user-sourced MD-backed renames FIRST so they claim their
  // requested filenames before any agent-sourced node in the same batch
  // can lazily auto-dedup into that slot. Without this, when a batch
  // contains two nodes pointing at the same label — one user-sourced,
  // one agent-sourced — the outcome was order-dependent: an
  // agent-sourced node landing earlier in `nodes` would take the slot,
  // and the user-sourced node would then 409 on its strict rename.
  const writeOrder = nodes
    .map((_, i) => i)
    .sort((a, b) => {
      const aUser = (nodes[a]?.data?.['labelSource'] ?? null) === 'user';
      const bUser = (nodes[b]?.data?.['labelSource'] ?? null) === 'user';
      if (aUser === bUser) return a - b;
      return aUser ? -1 : 1;
    });
  for (const i of writeOrder) {
    const node = nodes[i];
    if (!node) continue;
    const data = node.data ?? {};
    const nodeId = typeof node.id === 'string' ? node.id : '';
    const nodeType = typeof node.type === 'string' ? node.type : '';
    const incomingContent =
      typeof data['content'] === 'string'
        ? (data['content'] as string)
        : undefined;

    let hasPersistedTitle = false;
    let existing: NodeContent | null = null;
    if (nodeId) {
      try {
        existing = store.readNode(nodeId);
      } catch {
        existing = null;
      }
    }

    const shouldPersistMd = !!nodeId && MD_BACKED_NODE_TYPES.has(nodeType);
    const isTextBearing = TEXT_BEARING_NODE_TYPES.has(nodeType);
    const body = isTextBearing ? (incomingContent ?? '') : '';
    // Guard against accidental content wipes: if the incoming content is
    // an empty string but the persisted markdown already has non-empty
    // content for a text-bearing node, skip the write. This prevents
    // races (e.g. autosave firing before the editor flushes its buffer)
    // from clobbering real content with "".
    const wouldClobber =
      isTextBearing &&
      incomingContent === '' &&
      typeof existing?.content === 'string' &&
      existing.content.length > 0;

    if (
      shouldPersistMd &&
      !wouldClobber &&
      // For text-bearing nodes only persist when caller actually sent
      // content (or we're creating a fresh file). For image/video/frame
      // the markdown is metadata-only — always persist so src / label
      // changes land.
      (incomingContent !== undefined || !isTextBearing || !existing)
    ) {
      const incomingLabel =
        typeof data['label'] === 'string' &&
        (data['label'] as string).length > 0
          ? (data['label'] as string)
          : null;
      const label = incomingLabel ?? existing?.label ?? null;
      const nodeContent: NodeContent = {
        ...(existing ?? {}),
        nodeId,
        type: nodeType || existing?.type || 'note',
        label,
        src:
          typeof data['src'] === 'string'
            ? (data['src'] as string)
            : existing?.src,
        content: body,
      };
      try {
        // Strict rename only when the *user* intentionally typed this
        // label — those go through the `tryRename` flow, which surfaces
        // collisions as a window.alert and reverts the input.
        //
        // Agent-sourced labels are auto-deduped instead. AI runs in a
        // batched, fire-and-forget loop and has no way to react to a
        // 409, so refusing the save would silently drop the AI's
        // changes (and every subsequent autosave too). Auto-dedup keeps
        // the canvas saveable; we sync the bumped name back to
        // `data.label` below so the canvas display stays unique.
        const labelSource = data['labelSource'];
        const strictRename = labelSource === 'user';
        const result = store.writeNode(nodeId, nodeContent, {
          strictRename,
        });
        if (!result.ok && result.reason === 'conflict') {
          return {
            kind: 'conflict',
            nodeId,
            label: label ?? '',
            conflictWith: result.conflictWith.filename,
          };
        }
        // When the on-disk filename was bumped (e.g. `Foo (2).md`),
        // mirror the dedupe suffix back into the node's display label
        // so sibling labels stay unique on the canvas. We use the
        // resolved label returned by `writeNode` (which is the original
        // label with the suffix appended) rather than the filename
        // stem, so user-typed punctuation / non-ASCII characters
        // survive instead of being replaced with `_`.
        if (result.ok && result.label && result.label !== label) {
          data['label'] = result.label;
          renamed.push({ nodeId, label: result.label });
        }
        hasPersistedTitle = !!label;
      } catch {
        // Best effort — skip nodes whose id fails sanitisation.
      }
    } else {
      hasPersistedTitle = !!existing?.label;
    }

    const {
      content: _omitContent,
      summary: _omitSummary,
      keywords: _omitKeywords,
      ...dataRest
    } = data;
    const labelSource = data['labelSource'];
    const isUserOrAgent = labelSource === 'user' || labelSource === 'agent';
    // Drop the auto label only when per-node markdown can provide it back
    // on hydration. For nodes without persisted markdown (e.g. annotation
    // / question nodes whose label is generated by preprocessing), keep
    // the label on canvas.json so it survives reload.
    const keepLabel = isUserOrAgent || !hasPersistedTitle;
    const cleanData: Record<string, unknown> = { ...dataRest };
    if (!keepLabel) delete cleanData['label'];
    out[i] = { ...node, data: cleanData };
  }
  return { kind: 'ok', nodes: out, renamed };
}

/**
 * Node types whose primary content lives in `nodes/<safe(label)>.md`.
 * For these, a missing markdown file means the node body is empty and we
 * surface a `contentMissing` flag so the client can prompt the user.
 */
const CONTENT_BACKED_NODE_TYPES = new Set(['note', 'text']);

/**
 * Node types that reference an artifact file via `data.src`. When the
 * referenced file is gone from disk we surface an `artifactMissing` flag
 * so the client can show a placeholder + Remove button.
 */
const ARTIFACT_BACKED_NODE_TYPES = new Set(['pdf', 'image', 'video']);

/**
 * Inspect a node's `data.src` and report whether the underlying artifact
 * file still exists on disk. Returns `false` (not missing) for nodes
 * without a canvas-scoped artifact URL — remote URLs and data URLs are
 * out of scope for this check.
 */
function isArtifactMissing(
  store: CanvasStore,
  data: Record<string, unknown>,
): boolean {
  const src = typeof data['src'] === 'string' ? (data['src'] as string) : '';
  if (!src) return false;
  const match = src.match(ARTIFACT_URL_REGEX);
  if (!match) return false;
  const filename = match[2];
  if (!filename) return false;
  return store.resolveArtifactFilePath(filename) === null;
}

/**
 * Hydrate persisted nodes with side-channel content. Reads each node's
 * markdown file and re-attaches `content` / `label` (when auto-derived)
 * onto each node so callers see fresh data. Also sets `contentMissing` /
 * `artifactMissing` hints when the underlying file has been deleted or
 * renamed outside the app, so the client can render a non-blocking
 * placeholder instead of silently rendering an empty / broken node.
 */
function hydrateNodeContent(store: CanvasStore, nodes: NodeLike[]): NodeLike[] {
  return nodes.map((node) => {
    const nodeId = typeof node.id === 'string' ? node.id : '';
    if (!nodeId) return node;

    const nodeType = typeof node.type === 'string' ? node.type : '';
    const data: Record<string, unknown> = { ...(node.data ?? {}) };

    // ----- Artifact-backed nodes: flag missing src file -----
    if (ARTIFACT_BACKED_NODE_TYPES.has(nodeType)) {
      if (isArtifactMissing(store, data)) {
        data['artifactMissing'] = true;
      } else if ('artifactMissing' in data) {
        delete data['artifactMissing'];
      }
    }

    // ----- Content-backed nodes: read markdown side-file -----
    let nodeContent: NodeContent | null = null;
    try {
      nodeContent = store.readNode(nodeId);
    } catch {
      nodeContent = null;
    }

    if (!nodeContent) {
      if (CONTENT_BACKED_NODE_TYPES.has(nodeType)) {
        data['contentMissing'] = true;
      }
      // Return early only when we actually mutated something; otherwise
      // preserve the original node reference to keep diffs minimal.
      return data === node.data ? node : { ...node, data };
    }

    if ('contentMissing' in data) {
      delete data['contentMissing'];
    }
    // Only restore body for text-bearing types — image/video/frame
    // markdown is metadata-only and the canvas state does not carry
    // a content field for them.
    if (TEXT_BEARING_NODE_TYPES.has(nodeType)) {
      data['content'] = nodeContent.content;
    }

    // Surface preprocessed AI summary / keywords from the per-node
    // markdown frontmatter so the client can render them without a
    // separate fetch.
    const summary = nodeContent['summary'];
    if (typeof summary === 'string' && summary.trim()) {
      data['summary'] = summary.trim();
    }
    const keywords = nodeContent['keywords'];
    if (
      Array.isArray(keywords) &&
      keywords.every((k) => typeof k === 'string')
    ) {
      data['keywords'] = keywords;
    }

    if (nodeContent.label) {
      const labelSource = data['labelSource'];
      if (labelSource !== 'user' && labelSource !== 'agent') {
        data['label'] = nodeContent.label;
        data['labelSource'] = 'auto';
      } else if (!data['label']) {
        data['label'] = nodeContent.label;
      }
    }

    return { ...node, data };
  });
}

const canvasRoutes: FastifyPluginAsync = async (fastify) => {
  // --- List all canvases ---

  fastify.get<{ Reply: ApiResult<ListCanvasesResponse> }>(
    '/',
    async function (_request, reply) {
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
    },
  );

  // --- Create a new canvas ---

  fastify.post<{
    Body: CreateCanvasRequest;
    Reply: ApiResult<CreateCanvasResponse>;
  }>('/', async function (request, reply) {
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

  fastify.delete<{
    Params: { canvasId: string };
    Reply: ApiResult<DeleteCanvasResponse>;
  }>('/:canvasId', async function (request, reply) {
    const { canvasId } = request.params;
    const deleted = deleteCanvas(canvasId);

    if (!deleted) {
      return reply.code(404).send({ message: 'Canvas not found' });
    }

    return reply.send({ success: true });
  });

  // Delete a node — removes its markdown sidecar.
  //
  // Note: this endpoint deliberately does *not* mutate `canvas.json`.
  // The client owns the canvas state (nodes / edges) and will persist
  // the updated state via the autosave PUT on `/:canvasId`. Touching
  // `canvas.json` here would race with that PUT and surface as a
  // spurious 409 (CANVAS_VERSION_MISMATCH) on the very next autosave.
  //
  // What only the server can do — and therefore what this route
  // exists for — is unlink the per-node markdown sidecar in
  // `<canvasId>/nodes/<nodeId>.md`, since that file is invisible to
  // the client's `state` payload.
  fastify.delete<{
    Params: { canvasId: string; nodeId: string };
    Reply: ApiResult<DeleteNodeResponse>;
  }>('/:canvasId/nodes/:nodeId', async function (request, reply) {
    const { canvasId, nodeId } = request.params;
    const store = getCanvasStore(canvasId);
    const canvas = store.read();
    if (!canvas) {
      return reply.code(404).send({ message: 'Canvas not found' });
    }

    store.deleteNode(nodeId);

    return reply.send({ success: true });
  });

  // --- Unified preprocessing endpoint ---
  // Single route that handles all node types (note/text/web/pdf/image/frame/video).
  // Replaces the split between PUT /:canvasId/nodes/:nodeId and POST /resolve-label.

  fastify.post<{
    Params: { canvasId: string; nodeId: string };
    Body: PreprocessNodeBody;
    Reply: ApiResult<PreprocessNodeResponse>;
  }>('/:canvasId/nodes/:nodeId/preprocess', async function (request, reply) {
    const { canvasId, nodeId } = request.params;
    const parsed = preprocessNodeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: parsed.error.issues[0]?.message ?? 'Invalid request body',
      });
    }

    const { nodeType, trigger, snapshot, previousSnapshot, options } =
      parsed.data;
    const dispatcher = getPreprocessDispatcher();

    try {
      const ppRequest: PreprocessNodeRequest = {
        canvasId,
        nodeId,
        nodeType,
        trigger: trigger ?? 'node_updated',
        snapshot,
        previousSnapshot,
        options: {
          allowLLM: options?.allowLLM ?? true,
          allowPersistence: options?.allowPersistence ?? true,
          force: options?.force ?? false,
          mode: options?.mode,
        },
      };

      const result = await dispatcher.preprocess(ppRequest);

      const response: PreprocessNodeResponse = {
        nodeId,
        success: result.success,
        suggestedLabel:
          typeof result.patch.label === 'string'
            ? result.patch.label
            : undefined,
        error:
          result.diagnostics
            .filter((d) => d.level === 'error')
            .map((d) => `${d.code}: ${d.message}`)
            .join('; ') || undefined,
      };
      return reply.send(response);
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

  fastify.get<{
    Params: { canvasId: string };
    Reply: ApiResult<GetCanvasResponse>;
  }>('/:canvasId', async function (request, reply) {
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
  });

  // --- PUT Canvas ---

  fastify.put<{
    Params: { canvasId: string };
    Body: PutCanvasRequest;
    Reply: ApiResult<PutCanvasResponse> | CanvasConflictResponse;
  }>('/:canvasId', async function (request, reply) {
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
      return reply.code(409).send({
        code: 'CANVAS_VERSION_CONFLICT',
        message: 'Canvas version mismatch',
        serverVersion,
      } satisfies CanvasConflictResponse);
    }

    // Title rename (and the directory rename it implies) happens
    // before any node persistence so a 409 doesn't half-apply changes.
    const previousTitle = existing?.title ?? null;
    const nextTitle = title ?? previousTitle;
    if (typeof title === 'string' && title !== previousTitle) {
      const renameResult = store.renameSelf(title);
      if (!renameResult.ok && renameResult.reason === 'conflict') {
        return reply.code(409).send({
          code: 'CANVAS_TITLE_CONFLICT',
          message: `Another canvas already uses the directory name "${renameResult.conflictWith}"`,
          conflictWith: renameResult.conflictWith,
        } satisfies CanvasConflictResponse);
      }
      if (!renameResult.ok && renameResult.reason === 'fs-error') {
        request.log.error(
          { canvasId, err: renameResult.message },
          'Failed to rename canvas directory',
        );
        return reply.code(500).send({ message: 'Failed to rename canvas' });
      }
    }

    const timestamp = nowMs();
    const nextVersion = serverVersion + 1;

    const rawState = state as {
      nodes?: NodeLike[];
      edges?: unknown[];
      [key: string]: unknown;
    };

    const persistResult = persistAndStripNodes(
      store,
      (rawState?.nodes ?? []) as NodeLike[],
    );
    if (persistResult.kind === 'conflict') {
      return reply.code(409).send({
        code: 'NODE_LABEL_CONFLICT',
        message: `Another node already uses the label "${persistResult.label}"`,
        nodeId: persistResult.nodeId,
        conflictWith: persistResult.conflictWith,
      } satisfies CanvasConflictResponse);
    }

    const canvasFile: CanvasFile = {
      canvasId,
      title: nextTitle,
      version: nextVersion,
      state: {
        ...rawState,
        nodes: persistResult.nodes,
        edges: rawState?.edges ?? [],
      },
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    store.write(canvasFile);

    return reply.send({
      canvasId,
      version: nextVersion,
      ...(persistResult.renamed.length > 0
        ? { renamedNodes: persistResult.renamed }
        : {}),
    });
  });

  // --- Canvas events: append-only behavioural log -----------------------
  //
  // The frontend buffers `RecentAction` records and POSTs them in
  // batches (autosave piggy-back, pre-agent flush, beforeunload). Each
  // request is capped to 200 events / 64 KB body; oversize uploads
  // should be split client-side.

  const EVENTS_BODY_LIMIT_BYTES = 64 * 1024;
  const DEFAULT_EVENTS_LIMIT = 100;

  fastify.post<{
    Params: { canvasId: string };
    Body: PostCanvasEventsRequest;
    Reply: ApiResult<PostCanvasEventsResponse>;
  }>(
    '/:canvasId/events',
    { bodyLimit: EVENTS_BODY_LIMIT_BYTES },
    async function (request, reply) {
      const { canvasId } = request.params;
      const parsed = postCanvasEventsBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          message: parsed.error.issues[0]?.message ?? 'Invalid request body',
        });
      }

      const store = getCanvasStore(canvasId);
      if (!store.read()) {
        return reply.code(404).send({ message: 'Canvas not found' });
      }

      try {
        store.appendEvents(parsed.data.events);
      } catch (error) {
        request.log.error(
          { canvasId, error },
          'Failed to append canvas events',
        );
        return reply.code(500).send({
          message: 'Failed to append canvas events',
          details: toMessage(error),
        });
      }

      return reply.send({ appended: parsed.data.events.length });
    },
  );

  fastify.get<{
    Params: { canvasId: string };
    Querystring: GetCanvasEventsQuery;
    Reply: ApiResult<GetCanvasEventsResponse>;
  }>('/:canvasId/events', async function (request, reply) {
    const { canvasId } = request.params;
    const parsedQuery = getCanvasEventsQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({
        message: parsedQuery.error.issues[0]?.message ?? 'Invalid query',
      });
    }

    const store = getCanvasStore(canvasId);
    if (!store.read()) {
      return reply.code(404).send({ message: 'Canvas not found' });
    }

    const limit = parsedQuery.data.limit ?? DEFAULT_EVENTS_LIMIT;
    const since = parsedQuery.data.since;
    const events = store.readEvents(limit);
    const filtered =
      since != null ? events.filter((e) => e.ts >= since) : events;
    const trimmed = filtered.length > limit ? filtered.slice(-limit) : filtered;

    return reply.send({ events: trimmed });
  });

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
    Querystring: ExportCanvasQuery;
    // Success path streams a zip archive (Readable). Failure path is the
    // canonical ApiErrorBody — declared here so the 400/404 branches
    // type-check via the same `reply.send(...)` machinery the JSON
    // routes use.
    Reply: ApiResult<NodeJS.ReadableStream>;
  }>('/:canvasId/export', async function (request, reply) {
    const { canvasId } = request.params;
    const parsedQuery = exportCanvasQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({
        message: parsedQuery.error.issues[0]?.message ?? 'Invalid query',
      });
    }
    const includeHistory = parsedQuery.data.includeHistory !== 'false';

    const store = getCanvasStore(canvasId);
    const canvas = store.read();
    if (!canvas) {
      return reply.code(404).send({ message: 'Canvas not found' });
    }

    const canvasDir = canvasRoot(canvasId);
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
    // dot:true so the hidden `.artifacts/` directory is always included;
    // `.history/` is opted out unless the caller explicitly requests it.
    archive.glob('**/*', {
      cwd: canvasDir,
      dot: true,
      ignore: includeHistory ? [] : ['.history/**'],
    });

    void archive.finalize();
    return reply.send(archive);
  });

  // --- Import Canvas (zip) ---

  fastify.post<{ Reply: ApiResult<ImportCanvasResponse> }>(
    '/import',
    async function (request, reply) {
      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ message: 'No file provided' });
      }

      // Stream the upload to a temp zip file
      const tmpZip = path.join(tmpdir(), `${createId('import')}.zip`);
      const targetCanvasId = createId('canvas');
      // Extract into a hidden staging dir so `scanWorkspace()` ignores it
      // (it skips dot-prefixed entries) and the as-yet-unrenamed dir cannot
      // be picked up by `read()`'s self-heal as a canvas titled `<canvasId>`.
      const stagingDir = path.join(
        getWorkspacePath(),
        `.import-${targetCanvasId}`,
      );
      let stagingCleanedUp = false;
      try {
        await new Promise<void>((resolve, reject) => {
          const ws = createWriteStream(tmpZip);
          file.file.pipe(ws);
          ws.on('finish', () => resolve());
          ws.on('error', reject);
          file.file.on('error', reject);
        });

        mkdirSync(stagingDir, { recursive: true });

        type ImportManifest = {
          version?: string;
          sourceCanvasId?: string;
          title?: string | null;
        };
        let manifest: ImportManifest | null = null;

        await extractZip(tmpZip, async (entryPath, readEntry) => {
          if (entryPath === 'manifest.json') {
            const buf = await readEntry();
            try {
              manifest = JSON.parse(buf.toString('utf-8')) as ImportManifest;
            } catch {
              manifest = null;
            }
            return;
          }
          // Path traversal guard: resolve to absolute paths, then use
          // path.relative to detect any escape from the staging dir
          // (a `..` segment or absolute entry would surface as a
          // relative path that starts with `..` or is itself absolute).
          // This is more robust than a `startsWith(prefix)` check, which
          // can be fooled by paths that share a directory-name prefix
          // (e.g. `/ws/import-foo` vs `/ws/import-foo-bar`).
          const resolvedRoot = path.resolve(stagingDir);
          const dest = path.resolve(resolvedRoot, entryPath);
          const rel = path.relative(resolvedRoot, dest);
          if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
            request.log.warn(
              { entryPath },
              'Refusing zip entry with traversal',
            );
            return;
          }
          await mkdir(path.dirname(dest), { recursive: true });
          const buf = await readEntry();
          await writeFile(dest, new Uint8Array(buf));
        });

        // Rewrite canvas.json so canvasId matches the new directory.
        const stagedJsonPath = path.join(stagingDir, 'canvas.json');
        if (!existsSync(stagedJsonPath)) {
          await rm(stagingDir, { recursive: true, force: true });
          stagingCleanedUp = true;
          return reply.code(400).send({
            message: 'Invalid bundle: missing canvas.json',
          });
        }
        const raw = await readFile(stagedJsonPath, 'utf-8');
        const parsed = JSON.parse(raw) as CanvasFile;
        const sourceCanvasId = parsed.canvasId;
        const importedManifest = manifest as ImportManifest | null;
        const targetTitle =
          importedManifest?.title ?? parsed.title ?? 'Imported canvas';

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
        await writeFile(stagedJsonPath, JSON.stringify(remapped));

        // Move the staged dir into its final, title-derived location so
        // the on-disk basename matches the title and `read()` will not
        // self-heal-overwrite the title with the staging dir basename on
        // the next access.
        const finalDirName = suggestCanvasDir(targetTitle, targetCanvasId);
        const finalDir = path.join(getWorkspacePath(), finalDirName);
        renameSync(stagingDir, finalDir);
        stagingCleanedUp = true;
        registerCanvasDir(targetCanvasId, finalDirName, targetTitle);
        refreshCanvasDirIndex();

        const response: ImportCanvasResponse = {
          canvasId: targetCanvasId,
        };
        return reply.send(response);
      } catch (err) {
        request.log.error({ err }, 'Failed to import canvas zip');
        return reply.code(500).send({ message: 'Failed to import canvas' });
      } finally {
        void unlink(tmpZip).catch(() => {});
        if (!stagingCleanedUp && existsSync(stagingDir)) {
          await rm(stagingDir, { recursive: true, force: true }).catch(
            () => {},
          );
        }
      }
    },
  );
};

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

/**
 * Iterate over zip entries via `yauzl`, calling `onEntry(path, read)` for
 * each file. `read()` returns a buffer of the entry's full content.
 */
async function extractZip(
  zipPath: string,
  onEntry: (entryPath: string, read: () => Promise<Buffer>) => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile)
        return reject(err ?? new Error('Failed to open zip'));
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          // Directory entry — skip.
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (err2, stream) => {
          if (err2 || !stream) {
            zipfile.close();
            return reject(err2 ?? new Error('Failed to open entry'));
          }
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            void onEntry(entry.fileName, async () => Buffer.concat(chunks))
              .then(() => zipfile.readEntry())
              .catch((e) => {
                zipfile.close();
                reject(e);
              });
          });
          stream.on('error', reject);
        });
      });
      zipfile.on('end', () => resolve());
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

export default canvasRoutes;
