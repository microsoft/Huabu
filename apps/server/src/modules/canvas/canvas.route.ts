// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import archiver from 'archiver';
import yauzl from 'yauzl';

import {
  createCanvasBodySchema,
  canvasSearchRequestSchema,
  createId,
  deleteNodeBodySchema,
  exportCanvasQuerySchema,
  getCanvasEventsQuerySchema,
  postCanvasEventsBodySchema,
  postCanvasExecuteBodySchema,
  preprocessNodeBodySchema,
  putCanvasBodySchema,
  putNodeContentBodySchema,
  setPortalNodePinsCommandSchema,
} from '@huabu/shared';
import {
  diffCanvasState,
  nodeRevisionOf,
  type CanvasEdge,
  type CanvasNode,
} from '@huabu/shared/canvas-engine';

import {
  CanvasCommandRoutingError,
  executeCanvasCommandsOnHost,
  MissingWorldPortalError,
} from './canvas-command-router.js';
import {
  CanvasNotFoundError,
  revertChangeOnServer,
} from './canvas-executor.js';
import { searchCanvas } from './canvas-search.js';
import { publishCanvasUpdate } from './canvas-sync.js';
import {
  projectSlimCanvasStructure,
  structureRevisionOf,
} from './structure-revision.js';
import {
  assertWorldPortalTopologyAllowed,
  WorldPortalMutationError,
} from './world-portal-policy.js';
import { reconcileWorldPortals } from './world-portals.js';
import {
  resolveWorldReferences,
  WorldReferenceResolutionError,
} from './world-reference-resolver.js';
import { MAX_UPLOAD_BYTES } from '../../upload-limits.js';
import { ARTIFACT_URL_REGEX } from '../artifact/utils.js';
import {
  capturePreprocessExecutionBaseline,
  getPreprocessDispatcher,
  getProfile,
} from '../preprocessing/index.js';
import { stripOfficeparserPreamble } from '../preprocessing/loaders/office-strip.js';
import {
  isWorldCanvasId,
  refreshCanvasDirIndex,
  registerCanvasDir,
  suggestCanvasDir,
} from '../storage/canvas-dirs.js';
import {
  canvasBlobs,
  createSpace,
  deleteSpace,
  getCanvasStore,
  getStructuredStore,
  listCanvases,
  withCanvasMutex,
  type CanvasFile,
} from '../storage/index.js';
import { canvasRoot, nodesDir, SPACE_JSON_FILENAME } from '../storage/paths.js';
import { toSafeFilename } from '../workspace/disk/naming.js';
import { getWorkspacePath, withWorkspaceOperationLease } from '../workspace.js';

import type { CanvasStore, NodeContent } from '../storage/canvas-store.js';
import type { CanvasNodeType } from '@huabu/shared';
import type {
  ApiResult,
  CanvasCommand,
  CanvasConflictResponse,
  CanvasSearchEvent,
  CanvasCommitEvent,
  CreateCanvasRequest,
  CreateCanvasResponse,
  DeleteCanvasResponse,
  DeleteNodeRequest,
  DeleteNodeResponse,
  DeleteThreadChangeResponse,
  ExportCanvasQuery,
  GetCanvasEventsQuery,
  GetCanvasEventsResponse,
  GetCanvasResponse,
  GetNodeContentResponse,
  GetWorldReferencesResponse,
  GetThreadChangesResponse,
  ImportCanvasResponse,
  ListCanvasesResponse,
  MutationAck,
  PostCanvasEventsRequest,
  PostCanvasEventsResponse,
  PostCanvasExecuteRequest,
  PostCanvasExecuteResponse,
  PreprocessNodeBody,
  PreprocessNodeRequest,
  PreprocessNodeResponse,
  PutCanvasRequest,
  PutCanvasResponse,
  PutNodeContentRequest,
  PutNodeContentResponse,
  RevealNodesFolderResponse,
} from '@huabu/shared';
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

function mutationAckOf(event: CanvasCommitEvent): MutationAck {
  return {
    commitId: event.commitId,
    fromVersion: event.fromVersion,
    toVersion: event.toVersion,
    structureRevision: event.structureRevision,
    recordChanged: event.recordChanged,
  };
}

/** Publish only after `SpaceHandle.commit()` has returned durable success. */
function publishNodeCommit(
  canvasId: string,
  event: CanvasCommitEvent,
  deletedNodeIds: string[] = [],
): void {
  publishCanvasUpdate(canvasId, {
    type: 'update',
    data: {
      fromVersion: event.fromVersion,
      toVersion: event.toVersion,
      deltas: event.structureDeltas,
      pendingEffects: {
        mutatedNodes: [],
        deletedNodeIds,
        contentEditedNodeIds: [],
        deferredFitFrameIds: [],
      },
      ...(event.originator.threadId
        ? { threadId: event.originator.threadId }
        : {}),
      commit: event,
    },
  });
}

/**
 * Best-effort: open a directory in the host OS file manager. Detached +
 * unref'd so the server never waits on (or is killed with) the spawned
 * process, and we deliberately ignore the exit code — Windows `explorer`
 * returns 1 even on success.
 *
 * Fire-and-forget by design: `spawn` reports a missing binary
 * asynchronously via the `'error'` event rather than throwing, so the
 * caller can't synchronously tell whether the open succeeded. Both that
 * async failure and the rare synchronous spawn throw (EMFILE / ENOMEM)
 * are swallowed — the user simply sees nothing open. The route already
 * guarded the path with existsSync, so there is no state to roll back.
 * Never throws.
 */
function openInFileManager(targetPath: string): void {
  const cmd =
    process.platform === 'win32'
      ? 'explorer'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  try {
    const child = spawn(cmd, [targetPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {
      // Swallow async spawn errors (e.g. missing xdg-open on a headless
      // box). Best-effort — nothing to roll back.
    });
    child.unref();
  } catch {
    // Rare synchronous spawn throw (EMFILE / ENOMEM). Best-effort.
  }
}

/**
 * Node types that have a sibling `nodes/<safe(label)>.md`. The body is
 * markdown content for note/text/web/pdf and empty for
 * image/video/frame/question/sketch (which only carry frontmatter).
 *
 * `question` is included so its auto-generated label / labelSource
 * (written by the preprocess pipeline via `patchNodeSilent` on the
 * client) survives canvas reloads — the structure PUT strips those
 * fields, so the sidecar is the only persistence path.
 *
 * `sketch` is included for the same reason: the canvas engine
 * auto-stamps a `Sketch N` label on `CREATE_NODES` and the user can
 * rename it from the layer panel. Stroke geometry stays in structural
 * state; only the label / labelSource live in the sidecar's
 * frontmatter.
 */
const MD_BACKED_NODE_TYPES = new Set([
  'note',
  'text',
  'web',
  'pdf',
  'office',
  'image',
  'video',
  'audio',
  'frame',
  'question',
  'sketch',
]);

/** Subset that carries a textual body in the markdown. */
const TEXT_BEARING_NODE_TYPES = new Set([
  'note',
  'text',
  'web',
  'pdf',
  'office',
  'question',
]);

/**
 * Subset of {@link TEXT_BEARING_NODE_TYPES} whose `data.content` is
 * actually consumed by the web renderer (preview body, AI block
 * provenance, …) — and therefore worth inlining into the batched
 * `GET /:canvasId` response so first paint can render without a
 * follow-up per-node fetch.
 *
 * `pdf` is intentionally excluded: the canvas card and the expanded
 * preview both render directly from `data.src` via pdf.js, and the
 * in-page text selection layer re-extracts text on demand with
 * `page.getTextContent()`. Shipping the server-side extracted body
 * here would add hundreds of KB to every canvas load for zero
 * rendering benefit. Server-side agent / context paths still read the
 * sidecar directly via `store.readNode()`, and the per-node
 * `GET /:canvasId/nodes/:nodeId/content` endpoint still returns the
 * full body (falling back to `existing.content` when this hydrate
 * skips it) so search / AI features can fetch on demand.
 *
 * `question` IS inlined: the prompt is short, the QuestionNode reads
 * `data.content` to render the textarea, and skipping the inline copy
 * would leave every question node blank on first paint (its
 * `data.content` is stripped by the canonical slim-structure projection on
 * PUT, so the sidecar body is the only surviving copy).
 */
const WIRE_INLINE_CONTENT_TYPES = new Set([
  'note',
  'text',
  'web',
  'office',
  'question',
]);

/**
 * Build the initial canonical sidecar for a topology insertion.
 *
 * Existing-node content in a structure PUT is never trusted: callers use
 * the dedicated content endpoint for that. Only an id absent from the
 * persisted topology may contribute these fields, allowing its topology and
 * first sidecar to become visible in the same aggregate commit.
 */
function initialNodeContent(node: NodeLike): NodeContent | null {
  if (
    typeof node.id !== 'string' ||
    typeof node.type !== 'string' ||
    !MD_BACKED_NODE_TYPES.has(node.type)
  ) {
    return null;
  }
  const data = node.data ?? {};
  const record: NodeContent = {
    nodeId: node.id,
    type: node.type,
    label: typeof data['label'] === 'string' ? data['label'] : null,
    content:
      TEXT_BEARING_NODE_TYPES.has(node.type) &&
      typeof data['content'] === 'string'
        ? data['content']
        : '',
  };
  if (
    data['labelSource'] === 'user' ||
    data['labelSource'] === 'auto' ||
    data['labelSource'] === 'agent'
  ) {
    record['labelSource'] = data['labelSource'];
  }
  if (typeof data['src'] === 'string') record.src = data['src'];
  if (typeof data['summary'] === 'string') {
    record['summary'] = data['summary'];
  }
  if (
    Array.isArray(data['keywords']) &&
    data['keywords'].every((keyword) => typeof keyword === 'string')
  ) {
    record['keywords'] = data['keywords'];
  }
  if ('provenance' in data) record['provenance'] = data['provenance'];
  return record;
}

/**
 * Node types that reference an artifact file via `data.src`. When the
 * referenced file is gone from disk we surface an `artifactMissing` flag
 * so the client can show a placeholder + Remove button.
 */
const ARTIFACT_BACKED_NODE_TYPES = new Set([
  'pdf',
  'office',
  'image',
  'video',
  'audio',
]);

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
  artifactExists: (key: string) => boolean,
  data: Record<string, unknown>,
): boolean {
  const key = extractArtifactKey(data['src']);
  if (!key) return false;
  return !artifactExists(key);
}

/**
 * Presence predicate covering a single node's artifact.
 *
 * Batch callers build theirs from one `hasMany()`; a single-node endpoint
 * submits a one-key batch for the only key that can matter.
 */
async function singleArtifactProbe(
  canvasId: string,
  src: unknown,
): Promise<(key: string) => boolean> {
  const key = extractArtifactKey(src);
  if (!key) return () => false;
  const exists = (await canvasBlobs(canvasId).hasMany([key])).has(key);
  return (candidate) => candidate === key && exists;
}

/**
 * Hydrate a single persisted node with side-channel content from its
 * markdown sidecar (`nodes/<safe(label)>.md`). Pure per-node body of
 * {@link hydrateNodeContent}; also used by the per-node GET endpoint so
 * batch and single-node hydration stay in lock-step.
 *
 * `preloaded` lets the batch path inject content from a one-pass
 * directory scan (see {@link CanvasStore.readAllNodes}) so we don't
 * re-read every `.md` file per node. Pass `undefined` to fall back to
 * the targeted single-node `store.readNode(nodeId)` lookup; pass
 * `null` to indicate the batch scan ran but found no sidecar.
 *
 * Returns the original `node` reference when nothing was mutated so
 * callers can rely on identity-based diffing.
 */
function hydrateOneNode(
  store: CanvasStore,
  node: NodeLike,
  artifactExists: (key: string) => boolean,
  preloaded?: NodeContent | null,
): NodeLike {
  const nodeId = typeof node.id === 'string' ? node.id : '';
  if (!nodeId) return node;

  const nodeType = typeof node.type === 'string' ? node.type : '';
  const data: Record<string, unknown> = { ...(node.data ?? {}) };

  // ----- Read markdown side-file first -----
  // The structure PUT strips every per-node content key (src,
  // provenance, label, summary, keywords, …) before persisting structural
  // state via the canonical slim-structure projection. The markdown sidecar
  // is the only source of truth for those fields, so we read it before
  // any check that depends on them (notably the artifact-missing probe,
  // which needs the hydrated `src`).
  let nodeContent: NodeContent | null;
  if (preloaded !== undefined) {
    nodeContent = preloaded;
  } else {
    try {
      nodeContent = store.readNode(nodeId);
    } catch {
      nodeContent = null;
    }
  }

  if (!nodeContent) {
    if (MD_BACKED_NODE_TYPES.has(nodeType)) {
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
  // Surface a non-blocking hint when more than one `.md` sidecar on disk
  // claims this nodeId. Unlike a write (which hard-fails), a read stays
  // best-effort — the index keeps the last-scanned file so the node still
  // renders — but the client can flag it so the user resolves the
  // duplicate. The duplicate set was already populated by the
  // `readAllNodes()` scan that produced `preloaded`, so this is a cheap
  // in-memory lookup with no extra disk I/O.
  if (store.isDuplicateNode(nodeId)) {
    data['contentDuplicate'] = true;
    data['duplicateFiles'] = store.duplicateNodeFiles(nodeId);
  } else {
    if ('contentDuplicate' in data) {
      delete data['contentDuplicate'];
    }
    if ('duplicateFiles' in data) {
      delete data['duplicateFiles'];
    }
  }
  // Only restore body for types whose preview actually renders
  // `data.content`. `pdf` is text-bearing on disk (the .md sidecar
  // holds the extracted body for AI context) but the web renderer
  // works straight off `data.src` via pdf.js, so we deliberately
  // skip the inline copy here — see `WIRE_INLINE_CONTENT_TYPES`.
  // image/video/audio/frame markdown is metadata-only and the canvas
  // state does not carry a content field for them.
  if (WIRE_INLINE_CONTENT_TYPES.has(nodeType)) {
    let body = nodeContent.content;
    if (nodeType === 'office' && typeof body === 'string') {
      body = stripOfficeparserPreamble(body);
    }
    data['content'] = body;
  }

  // Rehydrate the source URL for artifact-backed (image/pdf/video) and
  // remote (web) nodes. Without this step the structure PUT permanently
  // wipes `data.src` from the canvas state on the next reload because
  // the slim-structure projection removed it before persistence.
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
  // in structural state.
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
    if (isArtifactMissing(artifactExists, data)) {
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
 *
 * Performance: uses a one-pass `readAllNodes()` scan so the total
 * filesystem cost is `1 × readdirSync + N × readText` regardless of
 * node count. The previous per-node `readNode()` path triggered an
 * extra full-directory scan (via `nodeIndex()`) plus a second
 * `readText` on every file, making large canvases noticeably slow to
 * load on cold cache.
 */
async function hydrateNodeContent(
  store: CanvasStore,
  nodes: NodeLike[],
): Promise<NodeLike[]> {
  // Read sidecars first because they are the source of truth for `src`.
  // Probe only the keys referenced by artifact-backed nodes; enumerating the
  // entire scope would make hydration cost grow with unrelated blob count.
  const contentByNodeId = await store.readAllNodes();
  const referenced = new Set<string>();
  for (const node of nodes) {
    const nodeType = typeof node.type === 'string' ? node.type : '';
    if (!ARTIFACT_BACKED_NODE_TYPES.has(nodeType)) continue;
    const nodeId = typeof node.id === 'string' ? node.id : '';
    const key = extractArtifactKey(contentByNodeId.get(nodeId)?.src);
    if (key) referenced.add(key);
  }

  const present =
    referenced.size === 0
      ? new Set<string>()
      : await canvasBlobs(store.canvasId).hasMany([...referenced]);
  const artifactExists = (key: string): boolean => present.has(key);

  return nodes.map((node) => {
    const nodeId = typeof node.id === 'string' ? node.id : '';
    return hydrateOneNode(
      store,
      node,
      artifactExists,
      contentByNodeId.get(nodeId) ?? null,
    );
  });
}

const canvasRoutes: FastifyPluginAsync = async (fastify) => {
  // --- List all canvases ---

  fastify.get<{ Reply: ApiResult<ListCanvasesResponse> }>(
    '/',
    async function (_request, reply) {
      const summaries = [...(await getStructuredStore().catalog().list())].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      );

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
    const created = await createSpace({ canvasId, title });

    if (!created.ok) {
      return reply
        .code(409)
        .send({ message: 'Canvas with this ID already exists' });
    }

    return reply.code(201).send({
      canvasId: created.record.canvasId,
      title: created.effectiveTitle,
    });
  });

  // --- Delete a canvas ---

  fastify.delete<{
    Params: { canvasId: string };
    Reply: ApiResult<DeleteCanvasResponse>;
  }>('/:canvasId', async function (request, reply) {
    const { canvasId } = request.params;
    const deleted = await deleteSpace(canvasId);
    if (!deleted.ok && deleted.reason === 'world-forbidden') {
      return reply
        .code(403)
        .send({ message: 'World canvas cannot be deleted' });
    }
    if (!deleted.ok) {
      return reply.code(404).send({ message: 'Canvas not found' });
    }

    return reply.send({ success: true });
  });

  // Delete one node as an aggregate: topology, every incident edge, sidecar,
  // tombstone, global version, durable row, and publication land together.
  fastify.delete<{
    Params: { canvasId: string; nodeId: string };
    Body: DeleteNodeRequest;
    Reply: ApiResult<DeleteNodeResponse> | CanvasConflictResponse;
  }>('/:canvasId/nodes/:nodeId', async function (request, reply) {
    const { canvasId, nodeId } = request.params;
    const parsed = deleteNodeBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'INVALID_REQUEST',
        message: parsed.error.issues[0]?.message ?? 'Invalid request body',
      });
    }
    const originator = parsed.data.originator ?? { source: 'ui' as const };

    try {
      const outcome = await withCanvasMutex(canvasId, async () => {
        const handle = getStructuredStore().space(canvasId);
        const canvas = await handle.record.read();
        if (canvas === null) return { status: 'not-found' as const };

        const beforeNodes = canvas.state.nodes as CanvasNode[];
        const beforeEdges = canvas.state.edges as CanvasEdge[];
        const afterNodes = beforeNodes.filter((node) => node.id !== nodeId);
        const afterEdges = beforeEdges.filter(
          (edge) => edge.source !== nodeId && edge.target !== nodeId,
        );
        try {
          assertWorldPortalTopologyAllowed(canvasId, beforeNodes, afterNodes);
        } catch (error) {
          if (error instanceof WorldPortalMutationError) {
            return {
              status: 'portal-conflict' as const,
              message: error.message,
            };
          }
          throw error;
        }
        const nextState = {
          ...canvas.state,
          nodes: afterNodes,
          edges: afterEdges,
        };
        const deltas = diffCanvasState(
          { nodes: beforeNodes, edges: beforeEdges },
          { nodes: afterNodes, edges: afterEdges },
        );
        const current = await handle.nodes.read(nodeId);
        const result = await handle.commit({
          expectedVersion: canvas.version,
          record: { title: canvas.title, state: nextState },
          nodePreconditions: [{ nodeId, revision: current?.revision ?? null }],
          nodeMutations: [{ kind: 'delete', nodeId }],
          publication: {
            originator,
            optimistic: originator.source === 'ui',
            commands: [{ type: 'DELETE_NODES', nodeIds: [nodeId] }],
            structureDeltas: deltas,
          },
        });

        if (!result.ok) return { status: 'conflict' as const, result };
        if (result.committed) {
          // Keep publication ordered with other writers by emitting before
          // the shared per-Space mutex is released. `commit()` returning is
          // the durability boundary (record + sidecar + row are finalized).
          publishNodeCommit(canvasId, result.event, [nodeId]);
        }
        return { status: 'ok' as const, result };
      });

      if (outcome.status === 'not-found') {
        return reply.code(404).send({
          code: 'CANVAS_NOT_FOUND',
          message: 'Canvas not found',
        });
      }
      if (outcome.status === 'portal-conflict') {
        return reply.code(409).send({
          code: 'INVALID_REQUEST',
          message: outcome.message,
        });
      }
      if (outcome.status === 'conflict') {
        const { result } = outcome;
        if (result.reason === 'not-found') {
          return reply.code(404).send({
            code: 'CANVAS_NOT_FOUND',
            message: 'Canvas not found',
          });
        }
        if (result.reason === 'version-conflict') {
          return reply.code(409).send({
            code: 'CANVAS_VERSION_CONFLICT',
            message: 'Canvas changed while deleting node content',
            serverVersion: result.actualVersion,
          });
        }
        if (result.reason === 'node-conflict') {
          const latest = await getStructuredStore()
            .space(canvasId)
            .nodes.read(nodeId);
          return reply.code(409).send({
            code: 'NODE_CONTENT_CONFLICT',
            message: `Node "${nodeId}" changed while its file was being deleted`,
            nodeId,
            currentRev: nodeRevisionOf({
              ...(typeof latest?.record.content === 'string'
                ? { content: latest.record.content }
                : {}),
              ...(typeof latest?.record.src === 'string'
                ? { src: latest.record.src }
                : {}),
            }),
          });
        }
        throw new Error(`Unexpected node delete conflict: ${result.reason}`);
      }

      return reply.send({
        success: true,
        commit: outcome.result.event,
        ack: mutationAckOf(outcome.result.event),
      });
    } catch (error) {
      // CanvasStoreIOError (unlink rejected by the OS, e.g. EPERM /
      // EACCES). Surface the failure so the client can revert its
      // optimistic delete (or at least toast). Silently returning
      // success here would leave structural state with no reference to
      // the node but its `.md` orphaned on disk forever.
      //
      // `code` is the stable contract — the client maps it to a
      // localised toast. `message` is the English fallback used for
      // server logs and unknown-code situations.
      request.log.error(
        { canvasId, nodeId, err: toMessage(error) },
        'Failed to delete node sidecar',
      );
      return reply.code(500).send({
        code: 'NODE_FILE_DELETE_FAILED',
        message: `Failed to delete node file for "${nodeId}"`,
      });
    }
  });

  // --- Per-node content endpoints --------------------------------------
  //
  // These let the web client persist a single node's markdown sidecar
  // (`nodes/<safe(label)>.md`) without going through the full canvas
  // PUT. Each actual sidecar change participates in the Space's global
  // optimistic-concurrency `version` counter. The structure PUT in
  // `PUT /:canvasId` strips every per-node content field through the canonical
  // slim-structure projection — these endpoints are the only write
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

    const {
      nodeType,
      content: incomingContent,
      label: incomingLabel,
      labelSource,
      src: incomingSrc,
      summary,
      keywords,
      provenance,
      expectRev,
      originator: requestedOriginator,
    } = parsed.data;
    const originator = requestedOriginator ?? { source: 'ui' as const };
    let attempted: NodeContent | undefined;
    let outcome;
    try {
      outcome = await withCanvasMutex(canvasId, async () => {
        const handle = getStructuredStore().space(canvasId);
        const canvas = await handle.record.read();
        if (canvas === null) return { status: 'not-found' as const };

        // The complete node read, authored-content CAS, metadata merge,
        // whole-record precondition, and aggregate commit are one serialized
        // operation. This preserves the content ETag contract while also
        // protecting labels/frontmatter from a concurrent metadata write.
        const current = await handle.nodes.read(nodeId);
        const existing = current?.record ?? null;
        const topologyNode = ((canvas.state.nodes ?? []) as NodeLike[]).find(
          (candidate) => candidate.id === nodeId,
        );

        // A standalone content request must never mint a sidecar that is not
        // represented by the Space topology. First visibility belongs to the
        // structural aggregate commit, which publishes topology + sidecar
        // together. A missing topology entry is a recoverable stale conflict,
        // including for late writes after DELETE, so the client cannot mistake
        // a suppressed write for durable success.
        if (!topologyNode) {
          return {
            status: 'topology-conflict' as const,
            currentRev: nodeRevisionOf({
              ...(typeof existing?.content === 'string'
                ? { content: existing.content }
                : {}),
              ...(typeof existing?.src === 'string'
                ? { src: existing.src }
                : {}),
            }),
          };
        }

        const canonicalNodeType = topologyNode.type ?? '';
        if (canonicalNodeType !== nodeType) {
          return {
            status: 'type-conflict' as const,
            canonicalNodeType,
            currentRev: nodeRevisionOf({
              ...(typeof existing?.content === 'string'
                ? { content: existing.content }
                : {}),
              ...(typeof existing?.src === 'string'
                ? { src: existing.src }
                : {}),
            }),
          };
        }
        if (!MD_BACKED_NODE_TYPES.has(canonicalNodeType)) {
          return {
            status: 'invalid-type' as const,
            canonicalNodeType,
          };
        }

        const isAuthored =
          getProfile(canonicalNodeType as CanvasNodeType)?.bodyOwnership ===
          'authored';
        if (isAuthored && expectRev !== undefined) {
          const currentRev = nodeRevisionOf({
            ...(typeof existing?.content === 'string'
              ? { content: existing.content }
              : {}),
            ...(typeof existing?.src === 'string' ? { src: existing.src } : {}),
          });
          if (expectRev !== currentRev) {
            return { status: 'rev-conflict' as const, currentRev };
          }
        }

        const acceptsBody = TEXT_BEARING_NODE_TYPES.has(canonicalNodeType);
        const body = acceptsBody
          ? (incomingContent ?? existing?.content ?? '')
          : '';
        const wouldClobber =
          acceptsBody &&
          incomingContent === '' &&
          typeof existing?.content === 'string' &&
          existing.content.length > 0;
        const safeBody = wouldClobber && existing ? existing.content : body;
        const resolvedLabel =
          incomingLabel === undefined
            ? (existing?.label ?? null)
            : (incomingLabel ?? null);
        const next: NodeContent = {
          ...(existing ?? {}),
          nodeId,
          // The topology is the sole owner of type transitions. Content PUT
          // may update body/frontmatter, but cannot race a structural save and
          // revert the sidecar's canonical type.
          type: canonicalNodeType,
          label: resolvedLabel,
          ...(incomingSrc !== undefined
            ? { src: incomingSrc }
            : existing?.src !== undefined
              ? { src: existing.src }
              : {}),
          content: safeBody,
        };
        if (labelSource !== undefined) next['labelSource'] = labelSource;
        if (summary !== undefined) next['summary'] = summary;
        if (keywords !== undefined) next['keywords'] = keywords;
        if (provenance !== undefined) next['provenance'] = provenance;
        attempted = next;

        const result = await handle.commit({
          expectedVersion: canvas.version,
          record: { title: canvas.title, state: canvas.state },
          nodePreconditions: [{ nodeId, revision: current?.revision ?? null }],
          nodeMutations: [
            {
              kind: 'put',
              record: next,
              strictRename: labelSource === 'user',
            },
          ],
          publication: {
            originator,
            optimistic: originator.source === 'ui',
            commands: [],
            structureDeltas: [],
          },
        });

        if (!result.ok) {
          if (result.reason === 'node-write-suppressed') {
            return { status: 'skipped-deleted' as const };
          }
          if (result.reason === 'node-conflict') {
            const latest = await handle.nodes.read(nodeId);
            const currentRev = nodeRevisionOf({
              ...(typeof latest?.record.content === 'string'
                ? { content: latest.record.content }
                : {}),
              ...(typeof latest?.record.src === 'string'
                ? { src: latest.record.src }
                : {}),
            });
            return { status: 'rev-conflict' as const, currentRev };
          }
          return {
            status: 'commit-conflict' as const,
            result,
            snapshot: current,
          };
        }

        const snapshot =
          result.nodes.find((entry) => entry.record.nodeId === nodeId) ??
          current;
        if (snapshot === null) {
          throw new Error(`Committed node "${nodeId}" has no final snapshot`);
        }
        if (result.committed) publishNodeCommit(canvasId, result.event);
        return {
          status: 'ok' as const,
          result,
          snapshot,
          contentPreserved: wouldClobber,
        };
      });
    } catch (error) {
      // CanvasStoreIOError (ENOSPC, EACCES, EROFS, …) / any unexpected throw
      // — environmental, not client-actionable. Surface as 500 (web toasts).
      request.log.error(
        { canvasId, nodeId, err: toMessage(error) },
        'Failed to write node markdown',
      );
      return reply.code(500).send({ message: 'Failed to write node content' });
    }

    if (outcome.status === 'not-found') {
      return reply.code(404).send({ message: 'Canvas not found' });
    }
    if (outcome.status === 'invalid-type') {
      return reply.code(400).send({
        message:
          `Node type "${outcome.canonicalNodeType}" ` +
          'does not have a markdown sidecar',
      });
    }

    if (
      outcome.status === 'type-conflict' ||
      outcome.status === 'topology-conflict'
    ) {
      return reply.code(409).send({
        code: 'NODE_CONTENT_CONFLICT',
        message:
          outcome.status === 'type-conflict'
            ? `Node "${nodeId}" is now type "${outcome.canonicalNodeType}"; refresh before editing it`
            : `Node "${nodeId}" is no longer present in the canvas topology`,
        nodeId,
        currentRev: outcome.currentRev,
        expectedRev: expectRev,
      } satisfies CanvasConflictResponse);
    }

    // rev-CAS conflict: a concurrent write (another tab / device / agent, or
    // a Google-Drive-synced copy) moved the on-disk body past the client's
    // baseline — surface instead of silently overwriting it.
    if (outcome.status === 'rev-conflict') {
      return reply.code(409).send({
        code: 'NODE_CONTENT_CONFLICT',
        message:
          `Node "${nodeId}" changed since you last loaded it ` +
          '(another tab, device, or agent wrote it). Refresh to get the ' +
          'latest content before editing.',
        nodeId,
        currentRev: outcome.currentRev,
        expectedRev: expectRev,
      } satisfies CanvasConflictResponse);
    }
    if (outcome.status === 'commit-conflict') {
      const result = outcome.result;
      if (result.reason === 'node-name-conflict') {
        return reply.code(409).send({
          code: 'NODE_LABEL_CONFLICT',
          message: `Another node already uses the label "${attempted?.label ?? ''}"`,
          nodeId,
          conflictWith: result.conflictWith.logicalName,
        } satisfies CanvasConflictResponse);
      }
      if (result.reason === 'duplicate-node') {
        // Two `.md` sidecars claim this nodeId (a failed rename or an external
        // copy). Refuse rather than compound it; surface a 409 to resolve.
        request.log.warn(
          { canvasId, nodeId, files: result.logicalNames },
          'Refusing node write: duplicate sidecars on disk',
        );
        return reply.code(409).send({
          code: 'NODE_DUPLICATE_FILES',
          message:
            `Node "${nodeId}" has multiple markdown files on disk ` +
            `(${result.logicalNames.join(', ')}); ` +
            'resolve the duplicate before editing.',
          nodeId,
          duplicateFiles: [...result.logicalNames],
        } satisfies CanvasConflictResponse);
      }
      if (result.reason === 'not-found') {
        return reply.code(404).send({ message: 'Canvas not found' });
      }
      if (result.reason === 'version-conflict') {
        return reply.code(409).send({
          code: 'CANVAS_VERSION_CONFLICT',
          message: 'Canvas changed while writing node content',
          serverVersion: result.actualVersion,
        } satisfies CanvasConflictResponse);
      }
      if (result.reason === 'node-topology-conflict') {
        return reply.code(409).send({
          code: 'NODE_CONTENT_CONFLICT',
          message:
            result.topologyType === null
              ? `Node "${nodeId}" is no longer present in the canvas topology`
              : `Node "${nodeId}" is now type "${result.topologyType}"; refresh before editing it`,
          nodeId,
          currentRev: outcome.snapshot?.record
            ? nodeRevisionOf({
                ...(typeof outcome.snapshot.record.content === 'string'
                  ? { content: outcome.snapshot.record.content }
                  : {}),
                ...(typeof outcome.snapshot.record.src === 'string'
                  ? { src: outcome.snapshot.record.src }
                  : {}),
              })
            : undefined,
          expectedRev: expectRev,
        } satisfies CanvasConflictResponse);
      }
      request.log.error({ canvasId, nodeId, result }, 'Node write failed');
      return reply.code(500).send({ message: 'Failed to write node content' });
    }
    if (outcome.status !== 'ok') {
      // `skipped-deleted`: the node was deleted while this write was in
      // flight (an editor content PUT or a slow preprocessing run that
      // finished after the DELETE). Dropping the write prevents a
      // resurrected "ghost" sidecar the file watcher would surface as an
      // external note. Respond benignly — the client has already removed
      // the node — so no error toast fires. ('noop' is otherwise
      // unreachable: `apply` always returns a record.)
      if (outcome.status === 'skipped-deleted') {
        // Empty-content revision (not `''`) so the response still honours the
        // invariant that `rev` is always a valid node revision hash.
        return reply.send({ nodeId, label: null, rev: nodeRevisionOf({}) });
      }
      return reply.code(500).send({ message: 'Failed to write node content' });
    }

    const response: PutNodeContentResponse = {
      nodeId,
      label: outcome.snapshot.record.label,
      ...(outcome.contentPreserved
        ? {
            contentPreserved: true,
            content: outcome.snapshot.record.content,
          }
        : {}),
      // Authoritative rev of the content actually persisted (reflects the
      // refused-empty-clobber case), co-delivered with the write it confirms
      // as the client's new CAS baseline.
      rev: nodeRevisionOf({
        ...(typeof outcome.snapshot.record.content === 'string'
          ? { content: outcome.snapshot.record.content }
          : {}),
        ...(typeof outcome.snapshot.record.src === 'string'
          ? { src: outcome.snapshot.record.src }
          : {}),
      }),
      recordRevision: outcome.snapshot.revision,
      commit: outcome.result.event,
      ack: mutationAckOf(outcome.result.event),
    };
    // `artifactMissing` is only meaningful for src-backed types and is
    // surfaced so the client can render the same placeholder UI it gets
    // back on a hydrate-time miss.
    if (ARTIFACT_BACKED_NODE_TYPES.has(outcome.snapshot.record.type)) {
      const srcForCheck =
        typeof outcome.snapshot.record.src === 'string'
          ? outcome.snapshot.record.src
          : '';
      if (srcForCheck) {
        const probe = await singleArtifactProbe(canvasId, srcForCheck);
        if (isArtifactMissing(probe, { src: srcForCheck })) {
          response.artifactMissing = true;
        }
      }
    }
    return reply.send(response);
  });

  fastify.get<{
    Params: { canvasId: string; nodeId: string };
    Reply: ApiResult<GetNodeContentResponse>;
  }>('/:canvasId/nodes/:nodeId/content', async function (request, reply) {
    const { canvasId, nodeId } = request.params;

    const handle = getStructuredStore().space(canvasId);
    const store = getCanvasStore(canvasId);
    const canvas = await handle.record.read();
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

    // Read the canonical record and its opaque whole-record revision as one
    // snapshot. Reusing this exact record below keeps the content and CAS
    // baseline co-delivered; a second legacy-store read could otherwise pair
    // a newer body with the older snapshot revision.
    const snapshot = await handle.nodes.read(nodeId);
    if (!snapshot) {
      // Markdown sidecar absent — surface a placeholder shape so the
      // client can render the same "missing content" UI it gets from
      // the batched hydrate path.
      return reply.send({
        nodeId,
        type: nodeType,
        label: null,
        content: '',
        // Empty-content revision so the client seeds a baseline that only
        // matches a first write while no file exists yet (create-race safe).
        rev: nodeRevisionOf({}),
        contentMissing: true,
      } satisfies GetNodeContentResponse);
    }
    const existing = snapshot.record;
    if (!nodeType) {
      nodeType = existing.type;
    }

    // Reuse the batched hydration helper so single-node and whole-
    // canvas reads stay in lock-step.
    const hydrated = hydrateOneNode(
      store,
      {
        id: nodeId,
        type: nodeType,
        data: { ...(stateNode?.data ?? {}) },
      },
      await singleArtifactProbe(store.canvasId, existing.src),
      existing,
    );
    const data = (hydrated.data ?? {}) as Record<string, unknown>;

    const resolvedContent =
      typeof data['content'] === 'string'
        ? (data['content'] as string)
        : (existing.content ?? '');
    const response: GetNodeContentResponse = {
      nodeId,
      type: nodeType,
      label: existing.label,
      content: resolvedContent,
      // Baseline revision co-delivered with the content, so a single-node
      // refresh re-seeds the client's CAS baseline atomically.
      rev: nodeRevisionOf({
        content: resolvedContent,
        ...(typeof existing.src === 'string' ? { src: existing.src } : {}),
      }),
      recordRevision: snapshot.revision,
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
    // Forward duplicate-sidecar hints from the same canonical snapshot so a
    // single-node refresh can clear (or re-confirm) the editor overlay
    // without a full canvas reload.
    if (snapshot.duplicateLogicalNames?.length) {
      response.contentDuplicate = true;
      response.duplicateFiles = [...snapshot.duplicateLogicalNames];
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

    return withWorkspaceOperationLease(async () => {
      const {
        nodeType,
        trigger,
        snapshot,
        previousSnapshot,
        options,
        originator,
      } = parsed.data;
      const baseline = await capturePreprocessExecutionBaseline(
        canvasId,
        nodeId,
      );
      const handle = getStructuredStore().space(canvasId);

      // A late request for a deleted or type-transitioned node is a benign
      // superseded no-op. A topology-present MD node with no sidecar remains a
      // genuine integrity error and keeps the legacy diagnostic response.
      if (baseline.topologyType !== nodeType) {
        return reply.send({ nodeId, success: true });
      }
      if (
        MD_BACKED_NODE_TYPES.has(nodeType) &&
        baseline.nodeRecordRevision === null
      ) {
        return reply.send({
          nodeId,
          success: false,
          error: 'Node sidecar is missing',
        });
      }

      try {
        const dispatcher = getPreprocessDispatcher();
        const ppRequest: PreprocessNodeRequest = {
          canvasId,
          nodeId,
          nodeType,
          trigger: trigger ?? 'node_updated',
          snapshot,
          previousSnapshot,
          ...(originator ? { originator } : {}),
          options: {
            allowLLM: options?.allowLLM ?? true,
            allowPersistence: options?.allowPersistence ?? true,
            force: options?.force ?? false,
            mode: options?.mode,
          },
        };

        const result = await dispatcher.preprocess(ppRequest, baseline);
        const recordRevision = result.superseded
          ? undefined
          : (result.recordRevision ??
            (await handle.nodes.read(nodeId))?.revision);

        const response: PreprocessNodeResponse = {
          nodeId,
          success: result.success,
          observedVersion: result.observedVersion,
          recordRevision,
          commit: result.commit,
          ack: result.ack,
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
          // For office nodes the in-canvas preview reads `data.content`
          // directly, so ship the freshly-extracted body back so the
          // client doesn't need a full canvas reload (or a follow-up
          // GET /content) before the preview can render. The OfficeLoader
          // already strips officeparser's auto-prepended YAML frontmatter
          // and stray horizontal rule, so this value is preview-ready.
          // Other text-bearing types (pdf / web / note) deliberately do
          // NOT echo `content` here — their previews never read it and
          // the extracted text can be hundreds of KB.
          content:
            nodeType === 'office' &&
            typeof result.extracted?.content === 'string'
              ? result.extracted.content
              : undefined,
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
  });

  // --- GET Canvas ---

  fastify.get<{
    Params: { canvasId: string };
    Reply: ApiResult<GetCanvasResponse>;
  }>('/:canvasId', async function (request, reply) {
    const { canvasId } = request.params;
    if (isWorldCanvasId(canvasId)) {
      await reconcileWorldPortals();
    }
    const store = getCanvasStore(canvasId);
    const canvas = store.read();

    if (!canvas) {
      return reply.code(404).send({ message: 'Canvas not found' });
    }

    // Hydrate node content from the per-canvas store so clients always
    // receive fresh markdown bodies.
    const nodes = canvas.state.nodes as NodeLike[];
    const hydratedNodes = await hydrateNodeContent(store, nodes);

    return reply.send({
      canvasId: canvas.canvasId,
      title: canvas.title,
      version: canvas.version,
      structureRevision: structureRevisionOf(canvas),
      state: {
        ...canvas.state,
        nodes: hydratedNodes,
      },
    });
  });

  fastify.get<{
    Params: { canvasId: string };
    Reply: ApiResult<GetWorldReferencesResponse>;
  }>('/:canvasId/references', async function (request, reply) {
    try {
      return reply.send(await resolveWorldReferences(request.params.canvasId));
    } catch (error) {
      if (error instanceof WorldReferenceResolutionError) {
        return reply.code(400).send({ message: error.message });
      }
      throw error;
    }
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

    const {
      version: clientVersion,
      state,
      title,
      expectStructureRevision,
      originator: requestedOriginator,
    } = parsed.data;
    if (
      typeof state !== 'object' ||
      state === null ||
      !Array.isArray((state as { nodes?: unknown }).nodes) ||
      !Array.isArray((state as { edges?: unknown }).edges)
    ) {
      return reply.code(400).send({ message: 'Invalid canvas state' });
    }
    const incomingState = state as {
      nodes: NodeLike[];
      edges: CanvasEdge[];
    };
    const originator = requestedOriginator ?? { source: 'ui' as const };

    let outcome;
    try {
      outcome = await withCanvasMutex(canvasId, async () => {
        let handle = getStructuredStore().space(canvasId);
        let current = await handle.record.read();
        let implicitCreate = false;

        // Compatibility only: historical clients may PUT a never-created id
        // at version 0. Funnel even that path through lifecycle + commit so
        // there is still one structured write authority. A failure after the
        // v0 create leaves a visible empty Space rather than a torn record.
        if (current === null) {
          if (clientVersion !== 0) {
            return { status: 'version-conflict' as const, serverVersion: 0 };
          }
          const created = await createSpace({
            canvasId,
            title: title ?? null,
          });
          if (!created.ok) {
            const raced = await getStructuredStore()
              .space(canvasId)
              .record.read();
            return {
              status: 'version-conflict' as const,
              serverVersion: raced?.version ?? 0,
            };
          }
          current = created.record;
          implicitCreate = true;
          handle = getStructuredStore().space(canvasId);
        }

        const nextTitle = implicitCreate
          ? current.title
          : (title ?? current.title);
        const currentStructure = projectSlimCanvasStructure(current);
        const nextStructure = projectSlimCanvasStructure({
          title: nextTitle,
          state: {
            nodes: incomingState.nodes,
            edges: incomingState.edges,
          },
        });
        const currentStructureRevision = structureRevisionOf(current);
        const desiredStructureRevision = structureRevisionOf(nextStructure);

        if (!implicitCreate) {
          if (expectStructureRevision === undefined) {
            if (clientVersion !== current.version) {
              return {
                status: 'version-conflict' as const,
                serverVersion: current.version,
              };
            }
          } else if (
            clientVersion > current.version ||
            (expectStructureRevision !== currentStructureRevision &&
              desiredStructureRevision !== currentStructureRevision)
          ) {
            return {
              status: 'version-conflict' as const,
              serverVersion: current.version,
            };
          }
        }

        try {
          assertWorldPortalTopologyAllowed(
            canvasId,
            currentStructure.state.nodes as NodeLike[],
            nextStructure.state.nodes as NodeLike[],
          );
        } catch (error) {
          if (error instanceof WorldPortalMutationError) {
            return {
              status: 'portal-conflict' as const,
              message: error.message,
            };
          }
          throw error;
        }

        const nextState = {
          // Canvas PUT owns title/topology only. Preserve opaque state owned
          // by other features instead of accepting a stale client copy.
          ...current.state,
          nodes: nextStructure.state.nodes,
          edges: nextStructure.state.edges,
        };
        const deltas = diffCanvasState(
          {
            nodes: currentStructure.state.nodes as CanvasNode[],
            edges: currentStructure.state.edges as CanvasEdge[],
          },
          {
            nodes: nextStructure.state.nodes as CanvasNode[],
            edges: nextStructure.state.edges as CanvasEdge[],
          },
        );

        const currentById = new Map(
          (currentStructure.state.nodes as CanvasNode[]).map((node) => [
            node.id,
            node,
          ]),
        );
        const nextById = new Map(
          (nextStructure.state.nodes as CanvasNode[]).map((node) => [
            node.id,
            node,
          ]),
        );
        const incomingById = new Map(
          incomingState.nodes.flatMap((node) =>
            typeof node.id === 'string' ? [[node.id, node] as const] : [],
          ),
        );
        const nodePreconditions = [];
        const nodeMutations = [];
        const deletedNodeIds: string[] = [];

        for (const [nodeId, node] of currentById) {
          const next = nextById.get(nodeId);
          if (
            !MD_BACKED_NODE_TYPES.has(node.type ?? '') ||
            (next !== undefined && MD_BACKED_NODE_TYPES.has(next.type ?? ''))
          ) {
            continue;
          }
          const snapshot = await handle.nodes.read(nodeId);
          nodePreconditions.push({
            nodeId,
            revision: snapshot?.revision ?? null,
          });
          nodeMutations.push({ kind: 'delete' as const, nodeId });
          deletedNodeIds.push(nodeId);
        }

        for (const [nodeId, node] of nextById) {
          const previous = currentById.get(nodeId);
          if (!MD_BACKED_NODE_TYPES.has(node.type ?? '')) continue;

          // A markdown-backed type transition owns topology and frontmatter
          // together. Preserve the canonical sidecar fields and change only
          // its type; accepting the structure while leaving stale
          // frontmatter would make external readers disagree with the UI.
          if (
            previous !== undefined &&
            MD_BACKED_NODE_TYPES.has(previous.type ?? '')
          ) {
            if (previous.type === node.type) continue;
            const snapshot = await handle.nodes.read(nodeId);
            if (snapshot === null) continue;
            nodePreconditions.push({
              nodeId,
              revision: snapshot.revision,
            });
            nodeMutations.push({
              kind: 'put' as const,
              record: { ...snapshot.record, type: node.type ?? '' },
            });
            continue;
          }

          const initial = initialNodeContent(incomingById.get(nodeId) ?? {});
          if (initial === null) continue;
          const snapshot = await handle.nodes.read(nodeId);
          // Preserve a legacy content PUT that happened to win the old
          // create race. A type transition, however, deliberately replaces
          // the previous representation with the incoming initial sidecar.
          if (previous === undefined && snapshot !== null) {
            if (snapshot.record.type !== node.type) {
              return {
                status: 'orphan-type-conflict' as const,
                nodeId,
                sidecarType: snapshot.record.type,
                topologyType: node.type ?? '',
              };
            }
            // Attach the already-canonical orphan through a semantic no-op
            // mutation. The revision precondition closes the gap between
            // this read and commit, while the adapter's normal put path also
            // validates duplicate files and topology/type agreement. Because
            // the bytes are unchanged, publication emits no node change.
            nodePreconditions.push({
              nodeId,
              revision: snapshot.revision,
            });
            nodeMutations.push({
              kind: 'put' as const,
              record: snapshot.record,
            });
            continue;
          }
          nodePreconditions.push({
            nodeId,
            revision: snapshot?.revision ?? null,
          });
          nodeMutations.push({
            kind: 'put' as const,
            record: initial,
            strictRename: initial['labelSource'] === 'user',
          });
        }

        const result = await handle.commit({
          expectedVersion: current.version,
          record: { title: nextTitle, state: nextState },
          nodePreconditions,
          nodeMutations,
          publication: {
            originator,
            optimistic: originator.source === 'ui',
            commands: [],
            structureDeltas: deltas,
          },
          // Preserve the current autosave contract until the separately
          // tracked no-op cleanup: every accepted Canvas PUT advances once.
          forceVersionBump: true,
        });
        if (!result.ok) return { status: 'commit-conflict' as const, result };
        if (result.committed) {
          publishNodeCommit(canvasId, result.event, deletedNodeIds);
        }
        return { status: 'ok' as const, result };
      });
    } catch (error) {
      if (/deletion is pending/.test(toMessage(error))) {
        return reply.code(409).send({
          code: 'CANVAS_VERSION_CONFLICT',
          message: 'Canvas is being deleted',
          serverVersion: clientVersion,
        } satisfies CanvasConflictResponse);
      }
      request.log.error({ canvasId, error }, 'Failed to commit canvas');
      return reply.code(500).send({ message: 'Failed to save canvas' });
    }

    if (outcome.status === 'version-conflict') {
      return reply.code(409).send({
        code: 'CANVAS_VERSION_CONFLICT',
        message: 'Canvas version or structure mismatch',
        serverVersion: outcome.serverVersion,
      } satisfies CanvasConflictResponse);
    }
    if (outcome.status === 'portal-conflict') {
      return reply.code(409).send({
        code: 'INVALID_REQUEST',
        message: outcome.message,
      });
    }
    if (outcome.status === 'orphan-type-conflict') {
      return reply.code(409).send({
        code: 'NODE_CONTENT_CONFLICT',
        message:
          `Node "${outcome.nodeId}" has an existing ${outcome.sidecarType} ` +
          `sidecar that cannot be attached as ${outcome.topologyType}`,
        nodeId: outcome.nodeId,
      } satisfies CanvasConflictResponse);
    }
    if (outcome.status === 'commit-conflict') {
      const result = outcome.result;
      if (result.reason === 'title-conflict') {
        return reply.code(409).send({
          code: 'CANVAS_TITLE_CONFLICT',
          message: `Another canvas already uses the directory name "${result.conflictWith}"`,
          conflictWith: result.conflictWith,
        } satisfies CanvasConflictResponse);
      }
      if (result.reason === 'world-title-forbidden') {
        return reply
          .code(403)
          .send({ message: 'World canvas cannot be renamed' });
      }
      if (result.reason === 'not-found') {
        return reply.code(404).send({ message: 'Canvas not found' });
      }
      if (result.reason === 'version-conflict') {
        return reply.code(409).send({
          code: 'CANVAS_VERSION_CONFLICT',
          message: 'Canvas version mismatch',
          serverVersion: result.actualVersion,
        } satisfies CanvasConflictResponse);
      }
      if (result.reason === 'node-name-conflict') {
        return reply.code(409).send({
          code: 'NODE_LABEL_CONFLICT',
          message: `Another node already uses the label "${result.conflictWith.logicalName}"`,
          nodeId: result.nodeId,
          conflictWith: result.conflictWith.logicalName,
        } satisfies CanvasConflictResponse);
      }
      if (result.reason === 'duplicate-node') {
        return reply.code(409).send({
          code: 'NODE_DUPLICATE_FILES',
          message: `Node "${result.nodeId}" has multiple markdown files`,
          nodeId: result.nodeId,
          duplicateFiles: [...result.logicalNames],
        } satisfies CanvasConflictResponse);
      }
      return reply.code(409).send({
        code: 'NODE_CONTENT_CONFLICT',
        message: `Node "${result.nodeId}" changed while saving the canvas`,
        nodeId: result.nodeId,
      } satisfies CanvasConflictResponse);
    }

    return reply.send({
      canvasId,
      version: outcome.result.record.version,
      ack: mutationAckOf(outcome.result.event),
      commit: outcome.result.event,
    });
  });

  // --- POST /:canvasId/execute (headless executor, M2) -----------------
  //
  // Runs a batch of `CanvasCommand`s server-side: hydrates sidecar content,
  // drives the shared engine, persists topology and content,
  // appends one row to the delta log, and returns the structural delta
  // the client can apply locally without re-issuing a full snapshot.
  //
  // Atomic per-canvas (the executor owns a mutex keyed by canvasId).
  // Idempotent no-op batches do not bump the version.

  fastify.post<{
    Params: { canvasId: string };
    Body: PostCanvasExecuteRequest;
    Reply: ApiResult<PostCanvasExecuteResponse>;
  }>('/:canvasId/execute', async function (request, reply) {
    const { canvasId } = request.params;
    const parsed = postCanvasExecuteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: parsed.error.issues[0]?.message ?? 'Invalid request body',
      });
    }
    if (parsed.data.originator.source === 'system') {
      return reply.code(403).send({
        message: 'System command origin is reserved for internal callers',
      });
    }
    const { commands, originator, runId } = parsed.data;
    const validatedCommands: CanvasCommand[] = [];
    for (const command of commands) {
      if (
        typeof command === 'object' &&
        command !== null &&
        'type' in command &&
        command.type === 'SET_PORTAL_NODE_PINS'
      ) {
        const parsedCommand = setPortalNodePinsCommandSchema.safeParse(command);
        if (!parsedCommand.success) {
          return reply.code(400).send({
            message:
              parsedCommand.error.issues[0]?.message ??
              'Invalid Portal Pin command',
          });
        }
        validatedCommands.push(parsedCommand.data as CanvasCommand);
      } else {
        validatedCommands.push(command as CanvasCommand);
      }
    }

    try {
      const out = await executeCanvasCommandsOnHost({
        canvasId,
        commands: validatedCommands,
        originator,
        ...(runId ? { runId } : {}),
        // Derive review records only for thread-attributed (ACP) batches —
        // they feed that conversation's change card. Other callers skip it.
        computeChanges: !!originator.threadId,
      });
      const response: PostCanvasExecuteResponse = {
        canvasId: out.canvasId,
        fromVersion: out.fromVersion,
        toVersion: out.toVersion,
        deltas: out.deltas,
        results: out.results,
        commands: out.commands,
        pendingEffects: {
          mutatedNodes: out.pendingEffects.mutatedNodes,
          deletedNodeIds: out.pendingEffects.deletedNodeIds,
          contentEditedNodeIds: out.pendingEffects.contentEditedNodeIds,
          deferredFitFrameIds: out.pendingEffects.deferredFitFrameIds,
        },
        ...(out.commit
          ? { commit: out.commit, ack: mutationAckOf(out.commit) }
          : {}),
        ...(runId ? { runId } : {}),
      };

      return reply.send(response);
    } catch (err) {
      if (err instanceof CanvasNotFoundError) {
        return reply.code(404).send({ message: 'Canvas not found' });
      }
      if (err instanceof WorldPortalMutationError) {
        return reply.code(409).send({ message: err.message });
      }
      if (err instanceof MissingWorldPortalError) {
        return reply
          .code(409)
          .send({ code: 'WORLD_PORTAL_MISSING', message: err.message });
      }
      if (err instanceof CanvasCommandRoutingError) {
        return reply.code(409).send({ message: err.message });
      }
      request.log.error({ canvasId, err }, 'Failed to execute canvas commands');
      return reply.code(500).send({
        message: 'Failed to execute canvas commands',
      });
    }
  });

  // --- Change-review records (ACP change card) --------------------------
  //
  // `GET /:canvasId/threads/:threadId/changes` returns the pending review
  // records for a conversation; `DELETE …/changes/:changeId` removes one
  // (accept or post-revert). Revert of canvas content itself happens on
  // the client via the inverse deltas carried in each record.

  fastify.get<{
    Params: { canvasId: string; threadId: string };
    Reply: ApiResult<GetThreadChangesResponse>;
  }>('/:canvasId/threads/:threadId/changes', async function (request, reply) {
    const { canvasId, threadId } = request.params;
    const handle = getStructuredStore().space(canvasId);
    if (!(await handle.record.read())) {
      return reply.code(404).send({ message: 'Canvas not found' });
    }
    return reply.send({ changes: await handle.changes.read(threadId) });
  });

  fastify.delete<{
    Params: { canvasId: string; threadId: string; changeId: string };
    Reply: ApiResult<DeleteThreadChangeResponse>;
  }>(
    '/:canvasId/threads/:threadId/changes/:changeId',
    async function (request, reply) {
      const { canvasId, threadId, changeId } = request.params;
      const outcome = await withCanvasMutex(canvasId, async () => {
        const handle = getStructuredStore().space(canvasId);
        if (!(await handle.record.read())) {
          return { found: false as const, removed: false };
        }
        const removed = await handle.changes.remove(threadId, changeId);
        return { found: true as const, removed: !!removed };
      });
      if (!outcome.found) {
        return reply.code(404).send({ message: 'Canvas not found' });
      }
      return reply.send({ removed: outcome.removed });
    },
  );

  // Revert one change: apply its inverse deltas server-side (persists +
  // broadcasts to all live tabs), then drop the record.
  fastify.post<{
    Params: { canvasId: string; threadId: string; changeId: string };
    Reply: ApiResult<DeleteThreadChangeResponse>;
  }>(
    '/:canvasId/threads/:threadId/changes/:changeId/revert',
    async function (request, reply) {
      const { canvasId, threadId, changeId } = request.params;
      try {
        const reverted = await revertChangeOnServer({
          canvasId,
          threadId,
          changeId,
          originator: { source: 'ui' },
        });
        if (!reverted.removed) {
          return reply.send({ removed: false });
        }
      } catch (err) {
        if (err instanceof CanvasNotFoundError) {
          return reply.code(404).send({ message: 'Canvas not found' });
        }
        request.log.error(
          { canvasId, changeId, err },
          'Failed to revert change',
        );
        return reply.code(500).send({ message: 'Failed to revert change' });
      }
      return reply.send({ removed: true });
    },
  );

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
        request.log.warn(
          { canvasId, issues: parsed.error.issues },
          'Invalid canvas events request body',
        );
        return reply.code(400).send({
          message: parsed.error.issues[0]?.message ?? 'Invalid request body',
        });
      }

      const handle = getStructuredStore().space(canvasId);
      if (!(await handle.record.read())) {
        return reply.code(404).send({ message: 'Canvas not found' });
      }

      try {
        await handle.events.append(parsed.data.events);
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

      // Op-counter bookkeeping is centralised in the global Fastify
      // hook — see `modules/agent/memory/op-counter-hook.ts`. It picks
      // this endpoint up automatically and weights the bump by
      // `parsed.data.events.length` so node-level granularity is
      // preserved.

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

    const handle = getStructuredStore().space(canvasId);
    if (!(await handle.record.read())) {
      return reply.code(404).send({ message: 'Canvas not found' });
    }

    const limit = parsedQuery.data.limit ?? DEFAULT_EVENTS_LIMIT;
    const since = parsedQuery.data.since;
    // The Phase-2 consumer slice: this read goes through the structured port
    // rather than the compatibility facade, so the repository contract has a
    // real caller before it is frozen. See
    // docs/proposals/multi-backend-storage.md §12.2.8.
    //
    // Resolve existence and events through one handle so malformed or
    // unreadable durable state cannot be collapsed into a false 404 by the
    // compatibility facade's intentionally lenient legacy reader.
    const events = await handle.events.read(limit);
    const filtered =
      since != null ? events.filter((e) => e.ts >= since) : events;
    const trimmed = filtered.length > limit ? filtered.slice(-limit) : filtered;

    return reply.send({ events: trimmed });
  });

  // --- Export Canvas (zip) ---

  /**
   * Stream the entire `<canvasId>/` directory as a `.huabu.zip` archive.
   *
   * The zip mirrors the complete Space layout, with a root manifest identifying
   * the export version and source canvas id.
   */
  /**
   * Open the canvas's `nodes/` folder in the host file manager so the
   * user can resolve a duplicate-markdown collision by hand (keep one
   * file, delete the rest). Desktop-first: the server runs on the same
   * machine as the UI, so it owns the only reliable filesystem path.
   * The folder is sandboxed to the workspace via {@link nodesDir}.
   */
  fastify.post<{
    Params: { canvasId: string };
    Reply: ApiResult<RevealNodesFolderResponse>;
  }>('/:canvasId/reveal-nodes', async function (request, reply) {
    const { canvasId } = request.params;
    const store = getCanvasStore(canvasId);
    if (!store.read()) {
      return reply.code(404).send({ message: 'Canvas not found' });
    }
    const dir = nodesDir(canvasId);
    if (!existsSync(dir)) {
      return reply.code(404).send({ message: 'Nodes folder not found' });
    }
    // Fire-and-forget: `openInFileManager` is best-effort and never
    // throws (spawn surfaces a missing binary asynchronously, which it
    // swallows). There's no reliable synchronous success signal to gate
    // a 500 on, so we always report success once the spawn is issued.
    openInFileManager(dir);
    return reply.send({ success: true });
  });

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

    const rawName = `${canvas.title ?? canvasId}.huabu.zip`;
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

        // `@fastify/multipart` silently *truncates* the file stream once it
        // exceeds the configured `fileSize` limit rather than throwing. A
        // truncated bundle is a corrupt zip, which surfaces downstream as a
        // cryptic "End of central directory record" yauzl error. Detect it
        // here and return an actionable 413 instead.
        if (file.file.truncated) {
          await unlink(tmpZip).catch(() => {});
          return reply.code(413).send({
            message: `Bundle exceeds the maximum upload size of ${Math.floor(
              MAX_UPLOAD_BYTES / (1024 * 1024),
            )}MB`,
          });
        }

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

        // Rewrite the topology file so canvasId matches the new directory.
        // New bundles carry `space.json`; still accept legacy `canvas.json`
        // exports and normalise them to the new name on the way in.
        const stagedJsonPath = path.join(stagingDir, SPACE_JSON_FILENAME);
        const legacyJsonPath = path.join(stagingDir, 'canvas.json');
        const sourceJsonPath = existsSync(stagedJsonPath)
          ? stagedJsonPath
          : existsSync(legacyJsonPath)
            ? legacyJsonPath
            : null;
        if (!sourceJsonPath) {
          await rm(stagingDir, { recursive: true, force: true });
          stagingCleanedUp = true;
          return reply.code(400).send({
            message: 'Invalid bundle: missing space.json',
          });
        }
        const raw = await readFile(sourceJsonPath, 'utf-8');
        const parsed = JSON.parse(raw) as CanvasFile;
        const sourceCanvasId = parsed.canvasId;
        const importedManifest = manifest as ImportManifest | null;
        const targetTitle =
          importedManifest?.title ?? parsed.title ?? 'Imported canvas';
        const finalDirName = suggestCanvasDir(targetTitle, targetCanvasId);
        const safeFromTitle = toSafeFilename(targetTitle, targetCanvasId);
        const dedupeSuffix =
          finalDirName === safeFromTitle
            ? ''
            : finalDirName.slice(safeFromTitle.length);
        const resolvedTitle =
          dedupeSuffix === '' ? targetTitle : targetTitle + dedupeSuffix;

        const remapped: CanvasFile = {
          ...parsed,
          canvasId: targetCanvasId,
          title: resolvedTitle,
          state: rewriteCanvasArtifactUrls(
            parsed.state,
            sourceCanvasId,
            targetCanvasId,
          ),
        };
        // Always persist under the new name so the storage layer (which
        // addresses `space.json`) can find it; drop a legacy source file.
        await writeFile(stagedJsonPath, JSON.stringify(remapped));
        if (sourceJsonPath !== stagedJsonPath) {
          await rm(sourceJsonPath, { force: true });
        }

        // Move the staged dir into its final, title-derived location so
        // the on-disk basename matches the title and `read()` will not
        // self-heal-overwrite the title with the staging dir basename on
        // the next access.
        const finalDir = path.join(getWorkspacePath(), finalDirName);
        renameSync(stagingDir, finalDir);
        stagingCleanedUp = true;
        registerCanvasDir(targetCanvasId, finalDirName, resolvedTitle);
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

  // --- Search canvas (NDJSON stream) ---
  //
  // Streams matches across the canvas as `application/x-ndjson` — one
  // JSON `CanvasSearchEvent` per line. Metadata-tier hits (label /
  // summary / keywords) ship first, then body-content hits, so the UI
  // can populate immediately while the heavier scan finishes. The
  // client cancels a superseded query by closing the socket
  // (`AbortController.abort()`); we mirror that into the scanner via
  // an `AbortController` so it short-circuits between nodes.
  fastify.post<{ Params: { canvasId: string } }>(
    '/:canvasId/search',
    async function (request, reply) {
      const { canvasId } = request.params;
      const parsed = canvasSearchRequestSchema.safeParse(request.body);
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

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders?.();

      const abort = new AbortController();
      let closed = false;
      const writeEvent = (event: CanvasSearchEvent): void => {
        if (closed) return;
        try {
          reply.raw.write(JSON.stringify(event) + '\n');
        } catch {
          // Socket already closed / errored. Mark closed AND abort
          // the scanner so it stops doing disk/CPU work right away —
          // otherwise we'd wait for `request.raw`'s `'close'` event,
          // which may not have fired yet (or at all, for a half-open
          // TCP connection) and would let `searchCanvas()` keep
          // streaming sidecars into a dead pipe.
          closed = true;
          abort.abort();
        }
      };

      const onClose = (): void => {
        closed = true;
        abort.abort();
      };
      request.raw.on('close', onClose);

      try {
        await searchCanvas(store, parsed.data, writeEvent, abort.signal);
      } catch (err) {
        request.log.error({ err, canvasId }, 'Canvas search failed');
        writeEvent({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        request.raw.off('close', onClose);
        if (!closed) {
          try {
            reply.raw.end();
          } catch {
            /* already closed */
          }
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
