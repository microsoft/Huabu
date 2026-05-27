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
  putNodeContentBodySchema,
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
  GetNodeContentResponse,
  ImportCanvasResponse,
  ListCanvasesResponse,
  PostCanvasEventsRequest,
  PostCanvasEventsResponse,
  PreprocessNodeBody,
  PreprocessNodeRequest,
  PreprocessNodeResponse,
  PutCanvasRequest,
  PutCanvasResponse,
  PutNodeContentRequest,
  PutNodeContentResponse,
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
 * markdown content for note/text/web/pdf and empty for
 * image/video/frame/question (which only carry frontmatter).
 *
 * `question` is included so its auto-generated label / labelSource
 * (written by the preprocess pipeline via `patchNodeSilent` on the
 * client) survives canvas reloads — the structure PUT strips those
 * fields, so the sidecar is the only persistence path.
 */
const MD_BACKED_NODE_TYPES = new Set([
  'note',
  'text',
  'web',
  'pdf',
  'image',
  'video',
  'frame',
  'question',
]);

/** Subset that carries a textual body in the markdown. */
const TEXT_BEARING_NODE_TYPES = new Set(['note', 'text', 'web', 'pdf']);

/**
 * Per-node `data` keys whose values live exclusively in the markdown
 * sidecar (`nodes/<safe(label)>.md`). The structure PUT strips these
 * before persisting to `canvas.json` so the two stores cannot drift;
 * `hydrateNodeContent` re-attaches them from the `.md` on read.
 *
 * Must stay in sync with `NODE_CONTENT_KEYS` on the web (see
 * `apps/web/src/store/canvasStore.ts`).
 */
const NODE_CONTENT_KEYS = new Set([
  'content',
  'label',
  'labelSource',
  'src',
  'summary',
  'keywords',
  'provenance',
]);

/**
 * Strip every per-node content / label / source / summary / keyword
 * field from each node's `data` before persisting `canvas.json`. The
 * structure PUT no longer carries those fields — they are persisted via
 * the dedicated `PUT /:canvasId/nodes/:nodeId/content` endpoint and
 * re-attached on read by {@link hydrateNodeContent}.
 *
 * Pure: takes a node list, returns a new list with the same `id` /
 * `type` / geometry / parenthood and a copy of `data` containing only
 * non-content keys. The original node objects are not mutated.
 *
 * Legacy clients that still send content in the structure body have it
 * silently dropped here; their per-node content PUTs (issued in
 * parallel) are the actual write path now.
 */
function stripNodesForCanvas(nodes: NodeLike[]): NodeLike[] {
  return nodes.map((node) => {
    const data = node.data;
    if (!data) return { ...node };
    const cleanData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (NODE_CONTENT_KEYS.has(k)) continue;
      cleanData[k] = v;
    }
    return { ...node, data: cleanData };
  });
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
 * Extract an artifact storage key from a `data.src` / `data.coverUrl`
 * value. Accepts both the canonical bare key (`<id><ext>`, the form the
 * frontend now persists) and a legacy full URL of shape
 * `/api/canvas/<canvasId>/artifact/<key>`. Returns `null` for empty
 * strings, data URLs, or remote URLs (which point at external hosts).
 */
function extractArtifactKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.startsWith('data:')) return null;
  const match = value.match(ARTIFACT_URL_REGEX);
  if (match && match[2]) return path.basename(match[2]);
  // Anything containing a slash beyond what `path.basename` strips is a
  // remote URL or a directory path — reject it so we don't try to
  // resolve `https://example.com/file.png` as a local artifact key.
  if (/^https?:/i.test(value)) return null;
  if (value.includes('/')) return null;
  return value;
}

/**
 * Inspect a node's `data.src` and report whether the underlying artifact
 * file still exists on disk. Returns `false` (not missing) for nodes
 * without a canvas-scoped artifact key — remote URLs and data URLs are
 * out of scope for this check.
 */
function isArtifactMissing(
  store: CanvasStore,
  data: Record<string, unknown>,
): boolean {
  const key = extractArtifactKey(data['src']);
  if (!key) return false;
  return store.resolveArtifactFilePath(key) === null;
}

/**
 * Hydrate a single persisted node with side-channel content from its
 * markdown sidecar (`nodes/<safe(label)>.md`). Pure per-node body of
 * {@link hydrateNodeContent}; also used by the per-node GET endpoint so
 * batch and single-node hydration stay in lock-step.
 *
 * Returns the original `node` reference when nothing was mutated so
 * callers can rely on identity-based diffing.
 */
function hydrateOneNode(store: CanvasStore, node: NodeLike): NodeLike {
  const nodeId = typeof node.id === 'string' ? node.id : '';
  if (!nodeId) return node;

  const nodeType = typeof node.type === 'string' ? node.type : '';
  const data: Record<string, unknown> = { ...(node.data ?? {}) };

  // ----- Read markdown side-file first -----
  // The structure PUT strips every per-node content key (src,
  // provenance, label, summary, keywords, …) before persisting
  // `canvas.json` via {@link stripNodesForCanvas}. The markdown sidecar
  // is the only source of truth for those fields, so we read it before
  // any check that depends on them (notably the artifact-missing probe,
  // which needs the hydrated `src`).
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
    // Without a sidecar we can't recover `src`, so the
    // artifact-missing probe below would be meaningless — skip it.
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

  // Rehydrate the source URL for artifact-backed (image/pdf/video) and
  // remote (web) nodes. Without this step the structure PUT permanently
  // wipes `data.src` from the canvas state on the next reload because
  // `stripNodesForCanvas` removed it before writing `canvas.json`.
  if (typeof nodeContent.src === 'string' && nodeContent.src.length > 0) {
    data['src'] = nodeContent.src;
  }

  // Rehydrate AI-edit block provenance. Same rationale as `src`: the
  // structure PUT strips it, so reloading any note that had AI edits
  // would lose its provenance markers without this step.
  const persistedProvenance = nodeContent['provenance'];
  if (persistedProvenance !== undefined) {
    data['provenance'] = persistedProvenance;
  }

  // Surface preprocessed AI summary / keywords from the per-node
  // markdown frontmatter so the client can render them without a
  // separate fetch.
  const summary = nodeContent['summary'];
  if (typeof summary === 'string' && summary.trim()) {
    data['summary'] = summary.trim();
  }
  const keywords = nodeContent['keywords'];
  if (Array.isArray(keywords) && keywords.every((k) => typeof k === 'string')) {
    data['keywords'] = keywords;
  }

  // The markdown sidecar is the canonical source for both `label` and
  // `labelSource` now. We unconditionally rehydrate both fields so the
  // canvas always reflects what was last persisted via the per-node
  // content endpoint. Nodes without an `.md` fall through the early
  // return above and keep whatever transient label the client placed
  // on `canvas.json`.
  data['label'] = nodeContent.label;
  const persistedLabelSource = nodeContent['labelSource'];
  data['labelSource'] =
    persistedLabelSource === 'user' ||
    persistedLabelSource === 'agent' ||
    persistedLabelSource === 'auto'
      ? persistedLabelSource
      : 'auto';

  // ----- Artifact-backed nodes: flag missing src file -----
  // Must run AFTER `src` is rehydrated above — otherwise `data.src`
  // would still be the post-strip empty string and `isArtifactMissing`
  // would unconditionally return `false`, silently masking deleted
  // artifacts.
  if (ARTIFACT_BACKED_NODE_TYPES.has(nodeType)) {
    if (isArtifactMissing(store, data)) {
      data['artifactMissing'] = true;
    } else if ('artifactMissing' in data) {
      delete data['artifactMissing'];
    }
  }

  return { ...node, data };
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
  return nodes.map((node) => hydrateOneNode(store, node));
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

  // --- Per-node content endpoints --------------------------------------
  //
  // These let the web client persist a single node's markdown sidecar
  // (`nodes/<safe(label)>.md`) without going through the full canvas
  // PUT, so editor edits no longer collide with the canvas-level
  // optimistic-concurrency `version` counter. The structure PUT in
  // `PUT /:canvasId` strips every per-node content field via
  // {@link stripNodesForCanvas} — these endpoints are the only write
  // path for `.md` sidecars. See `docs/node-content-api-split.md`.

  fastify.put<{
    Params: { canvasId: string; nodeId: string };
    Body: PutNodeContentRequest;
    Reply: ApiResult<PutNodeContentResponse> | CanvasConflictResponse;
  }>('/:canvasId/nodes/:nodeId/content', async function (request, reply) {
    const { canvasId, nodeId } = request.params;
    const parsed = putNodeContentBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: parsed.error.issues[0]?.message ?? 'Invalid request body',
      });
    }

    const store = getCanvasStore(canvasId);
    const canvas = store.read();
    if (!canvas) {
      return reply.code(404).send({ message: 'Canvas not found' });
    }

    const {
      nodeType,
      content: incomingContent,
      label: incomingLabel,
      labelSource,
      src: incomingSrc,
      summary,
      keywords,
      provenance,
    } = parsed.data;

    if (!MD_BACKED_NODE_TYPES.has(nodeType)) {
      return reply.code(400).send({
        message: `Node type "${nodeType}" does not have a markdown sidecar`,
      });
    }

    let existing: NodeContent | null = null;
    try {
      existing = store.readNode(nodeId);
    } catch {
      existing = null;
    }

    const isTextBearing = TEXT_BEARING_NODE_TYPES.has(nodeType);
    // Body resolution:
    //   - text-bearing nodes: prefer caller content; fall back to
    //     existing on-disk body to avoid wiping it when the caller
    //     only meant to update e.g. the label.
    //   - frontmatter-only nodes (image/video/frame): always empty.
    const body = isTextBearing
      ? (incomingContent ?? existing?.content ?? '')
      : '';

    // Guard against accidental content wipes (autosave race vs. editor
    // flush): if the caller explicitly sent `content: ""` but the
    // existing markdown is non-empty, refuse the body write but still
    // update frontmatter (label / src / summary / keywords / provenance).
    const wouldClobber =
      isTextBearing &&
      incomingContent === '' &&
      typeof existing?.content === 'string' &&
      existing.content.length > 0;
    const safeBody = wouldClobber ? existing!.content : body;

    // Label resolution: a present-but-explicit `null` clears the label;
    // an absent field leaves the existing label untouched.
    const resolvedLabel =
      incomingLabel === undefined
        ? (existing?.label ?? null)
        : (incomingLabel ?? null);

    const nodeContent: NodeContent = {
      ...(existing ?? {}),
      nodeId,
      type: nodeType,
      label: resolvedLabel,
      // Only include `src` when the caller or existing record actually
      // had one — keeps the frontmatter free of `src: undefined` for
      // pure note/text/frame nodes.
      ...(incomingSrc !== undefined
        ? { src: incomingSrc }
        : existing?.src !== undefined
          ? { src: existing.src }
          : {}),
      content: safeBody,
    };
    if (labelSource !== undefined) {
      nodeContent['labelSource'] = labelSource;
    }
    if (summary !== undefined) nodeContent['summary'] = summary;
    if (keywords !== undefined) nodeContent['keywords'] = keywords;
    if (provenance !== undefined) nodeContent['provenance'] = provenance;

    // Strict rename only for user-typed labels. The `tryRename` flow on
    // the web force-flushes the per-node save and awaits it so the
    // collision can be surfaced as an alert and the optimistic label
    // reverted. Agent / auto labels lazy-dedupe with `(N)` suffixes
    // because batched agent runs cannot react to a 409.
    const strictRename = labelSource === 'user';

    let writeResult: ReturnType<CanvasStore['writeNode']>;
    try {
      writeResult = store.writeNode(nodeId, nodeContent, { strictRename });
    } catch (error) {
      request.log.error(
        { canvasId, nodeId, err: toMessage(error) },
        'Failed to write node markdown',
      );
      return reply.code(500).send({ message: 'Failed to write node content' });
    }

    if (!writeResult.ok && writeResult.reason === 'conflict') {
      return reply.code(409).send({
        code: 'NODE_LABEL_CONFLICT',
        message: `Another node already uses the label "${resolvedLabel ?? ''}"`,
        nodeId,
        conflictWith: writeResult.conflictWith.filename,
      } satisfies CanvasConflictResponse);
    }
    if (!writeResult.ok) {
      // not-found / fs-error — treat as 500; not-found should not
      // happen here because we constructed the file via writeNode.
      request.log.error({ canvasId, nodeId, writeResult }, 'Node write failed');
      return reply.code(500).send({ message: 'Failed to write node content' });
    }

    const response: PutNodeContentResponse = {
      nodeId,
      label: writeResult.label,
    };
    // `artifactMissing` is only meaningful for src-backed types and is
    // surfaced so the client can render the same placeholder UI it
    // gets back on a hydrate-time miss.
    if (ARTIFACT_BACKED_NODE_TYPES.has(nodeType)) {
      const srcForCheck =
        typeof nodeContent.src === 'string' ? nodeContent.src : '';
      if (
        srcForCheck &&
        isArtifactMissing(store, { src: srcForCheck } as Record<
          string,
          unknown
        >)
      ) {
        response.artifactMissing = true;
      }
    }
    return reply.send(response);
  });

  fastify.get<{
    Params: { canvasId: string; nodeId: string };
    Reply: ApiResult<GetNodeContentResponse>;
  }>('/:canvasId/nodes/:nodeId/content', async function (request, reply) {
    const { canvasId, nodeId } = request.params;

    const store = getCanvasStore(canvasId);
    const canvas = store.read();
    if (!canvas) {
      return reply.code(404).send({ message: 'Canvas not found' });
    }

    // Find this node in the persisted canvas state so we know its type
    // (without it we can't apply the artifact-missing branch). For
    // nodes that exist in `.md` but not in canvas state we fall back
    // to the type recorded in the markdown frontmatter.
    const stateNodes = (canvas.state.nodes ?? []) as NodeLike[];
    const stateNode = stateNodes.find((n) => n.id === nodeId);
    let nodeType =
      stateNode && typeof stateNode.type === 'string' ? stateNode.type : '';

    let existing: NodeContent | null = null;
    try {
      existing = store.readNode(nodeId);
    } catch {
      existing = null;
    }
    if (!nodeType && existing) {
      nodeType = existing.type;
    }

    if (!existing) {
      // Markdown sidecar absent — surface a placeholder shape so the
      // client can render the same "missing content" UI it gets from
      // the batched hydrate path.
      return reply.send({
        nodeId,
        type: nodeType,
        label: null,
        content: '',
        contentMissing: true,
      } satisfies GetNodeContentResponse);
    }

    // Reuse the batched hydration helper so single-node and whole-
    // canvas reads stay in lock-step.
    const hydrated = hydrateOneNode(store, {
      id: nodeId,
      type: nodeType,
      data: { ...(stateNode?.data ?? {}) },
    });
    const data = (hydrated.data ?? {}) as Record<string, unknown>;

    const response: GetNodeContentResponse = {
      nodeId,
      type: nodeType,
      label: existing.label,
      content:
        typeof data['content'] === 'string'
          ? (data['content'] as string)
          : (existing.content ?? ''),
    };
    const ls = existing['labelSource'];
    if (ls === 'user' || ls === 'auto' || ls === 'agent') {
      response.labelSource = ls;
    }
    if (typeof existing.src === 'string') {
      response.src = existing.src;
    }
    const sum = existing['summary'];
    if (typeof sum === 'string' && sum.trim()) {
      response.summary = sum.trim();
    }
    const kws = existing['keywords'];
    if (Array.isArray(kws) && kws.every((k) => typeof k === 'string')) {
      response.keywords = kws as string[];
    }
    if (data['artifactMissing'] === true) {
      response.artifactMissing = true;
    }
    return reply.send(response);
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
        // Surface the post-Persist canonical `src` only when the
        // Project stage decided it diverged from the snapshot — see
        // the `patch.src` branch in `stages/project.ts`. Reading from
        // the patch (rather than `result.persistence`) means we
        // automatically inherit the same "only when changed" gate so
        // the client never receives a redundant src write.
        src:
          typeof result.patch.src === 'string' ? result.patch.src : undefined,
        summary: result.enriched?.summary,
        keywords: result.enriched?.keywords,
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

    const slimNodes = stripNodesForCanvas(
      (rawState?.nodes ?? []) as NodeLike[],
    );

    const canvasFile: CanvasFile = {
      canvasId,
      title: nextTitle,
      version: nextVersion,
      state: {
        ...rawState,
        nodes: slimNodes,
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
