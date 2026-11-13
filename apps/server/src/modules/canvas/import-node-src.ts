// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Node `src` normalization hook for agent-authored canvas writes.
 *
 * Agents (the built-in operate agent and out-of-band ACP agents via the
 * reachback `POST /api/canvas/:id/execute` route) may set a node's
 * `data.src` to a value the web client cannot render directly:
 *
 *   - an RFS **upload** path (`upload/foo.png` → physical `.upload/foo.png`),
 *     staged via `POST /api/rfs/:canvasId/upload/*`;
 *   - any other canvas-relative file path that lives outside `.artifacts/`;
 *   - a direct **online** media URL (`https://…/foo.png`).
 *
 * The web only serves node media from `<canvasDir>/.artifacts/` (via
 * `GET /api/canvas/:id/artifact/:key`), so any of the above renders as a
 * broken image. This hook rewrites each foreign `src` into a bare artifact
 * key by copying / downloading the bytes into `.artifacts/`. Values that are
 * already artifact keys, `/api/…` URLs, or `data:` URIs pass through
 * untouched, as do validated YouTube URLs on video nodes, so the pass is
 * idempotent and safe to run on every agent batch.
 *
 * Called from {@link import('./canvas-executor.js').executeOnServer} before
 * the shared engine sees the batch, so both agent write paths are covered by
 * one choke point.
 */

import { existsSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { imageSize } from 'image-size';

import {
  createId,
  type CanvasCommand,
  type CanvasNodeCreateInput,
} from '@huabu/shared';

import { assertCurrentCanvasNodeTypes } from './world-preview-policy.js';
import { getLogger } from '../../utils/logger.js';
import {
  safeResolve,
  isArtifactsRel,
  sandboxRoot,
  toPhysicalRel,
} from '../agent/tools/handlers/fs-sandbox.js';
import { extractYoutubeVideoId } from '../preprocessing/loaders/youtube-id.js';
import { outboundFetch } from '../security/outbound.js';
import { space } from '../storage/index.js';

const log = getLogger('canvas.import-node-src');

/** Hidden RFS scratch dir; only files here are reclaimed (move semantics). */
const UPLOAD_DIR_NAME = '.upload';

/** Hard cap on downloaded online media (defensive against runaway fetches). */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/** Abort an online fetch that stalls past this budget. */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Content-Type → extension, for downloads that lack a usable URL suffix. */
const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a',
};

/** Extensions we trust straight off a URL path (skip the MIME sniff). */
const KNOWN_MEDIA_EXT: ReadonlySet<string> = new Set(
  Object.values(EXT_BY_MIME),
);

/**
 * Node types whose `data.src` is a **local media artifact** served from
 * `.artifacts/`. Remote (`http(s)://`) srcs are downloaded and rewritten too,
 * except validated YouTube video URLs: those must remain live platform URLs
 * for embedding and provider-specific cover preprocessing.
 */
const ARTIFACT_SRC_NODE_TYPES: ReadonlySet<string> = new Set([
  'image',
  'video',
  'audio',
  'pdf',
  'office',
]);

/**
 * Node types whose `data.src` may be **either** a live remote URL **or** a
 * canvas-local file. `web` is the sole member: an agent can author a `web`
 * node from a locally-generated HTML file staged under `.upload/`, which must
 * be copied into `.artifacts/` to render, while a `web` node pointing at a
 * live site must keep that URL verbatim so the preprocessing pipeline
 * (Readability) and the live iframe can fetch it. So only the *local file*
 * case is normalized here; remote URLs are left untouched (never downloaded).
 */
const LOCAL_ONLY_ARTIFACT_SRC_NODE_TYPES: ReadonlySet<string> = new Set([
  'web',
]);

/** Local file extensions accepted as agent-authored `web` node sources. */
const WEB_LOCAL_EXTENSIONS: ReadonlySet<string> = new Set(['.html']);

/** Raster formats accepted as an agent-authored PDF cover. */
const COVER_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
]);

/** Decoded formats accepted as a cover, as `image-size` names them. */
const COVER_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'gif',
  'webp',
  'avif',
]);

/**
 * An agent-authored `coverUrl` that cannot be honoured. Unlike a failed `src`
 * import, this rejects the batch: a dangling cover would replace a working
 * first-page thumbnail with a broken image.
 */
export class NodeCoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeCoverError';
  }
}

interface SrcNormalizeMode {
  allowRemoteDownload: boolean;
  allowedLocalExtensions?: ReadonlySet<string>;
}

/**
 * Resolve how a given node type's `src` should be normalized, or `null` when
 * the type is not artifact-backed and should be left untouched.
 */
function srcNormalizeMode(type: string, src: unknown): SrcNormalizeMode | null {
  if (ARTIFACT_SRC_NODE_TYPES.has(type)) {
    return {
      allowRemoteDownload: !(
        type === 'video' &&
        typeof src === 'string' &&
        extractYoutubeVideoId(src) !== null
      ),
    };
  }
  if (LOCAL_ONLY_ARTIFACT_SRC_NODE_TYPES.has(type)) {
    return {
      allowRemoteDownload: false,
      allowedLocalExtensions: WEB_LOCAL_EXTENSIONS,
    };
  }
  return null;
}

/**
 * Rewrite every foreign `data.src` in `commands` into a bare artifact key.
 *
 * Only artifact-backed node types are touched (see {@link srcNormalizeMode}).
 * Returns a new command array; unaffected commands are passed through by
 * reference. Import failures are logged and swallowed — the original `src` is
 * preserved so a single unreachable URL never fails the whole batch.
 */
export interface ImportNodeSourcesOptions {
  /**
   * Resolve and validate `coverUrl` under the agent command contract (PDF
   * only, an existing raster image). Off by default: callers that predate
   * that contract keep storing whatever cover string they send.
   */
  agentCovers?: boolean;
  /**
   * Receives the staged uploads consumed as covers instead of having them
   * reclaimed here, so the caller can keep them until its batch is accepted.
   */
  stagedCoverUploads?: string[];
}

/** Remove staged uploads whose bytes are already stored as artifacts. */
export async function reclaimStagedUploads(
  absPaths: readonly string[],
): Promise<void> {
  await Promise.all(
    absPaths.map((absPath) => rm(absPath, { force: true }).catch(noop)),
  );
}

export async function importForeignNodeSources(
  canvasId: string,
  commands: readonly CanvasCommand[],
  options: ImportNodeSourcesOptions = {},
): Promise<CanvasCommand[]> {
  // Validate all creates before importing any bytes from the batch.
  assertCurrentCanvasNodeTypes(
    commands.flatMap((cmd) =>
      cmd.type === 'CREATE_NODES'
        ? cmd.nodes.map((node) => ({ type: node.nodeType, data: node.data }))
        : [],
    ),
  );
  // Lazily built nodeId → nodeType map, needed only to gate MERGE_NODE_DATA
  // patches (CREATE_NODES carries `nodeType` inline). Node type is immutable,
  // so reading the pre-batch snapshot here is race-free.
  let typeByIdPromise: Promise<Map<string, string>> | null = null;
  const nodeType = async (nodeId: string): Promise<string> => {
    if (!typeByIdPromise) {
      typeByIdPromise = (async () => {
        const byId = new Map<string, string>();
        const canvas = await space(canvasId).read();
        for (const raw of canvas?.state.nodes ?? []) {
          const n = raw as { id?: unknown; type?: unknown };
          if (typeof n.id === 'string' && typeof n.type === 'string') {
            byId.set(n.id, n.type);
          }
        }
        return byId;
      })();
    }
    return (await typeByIdPromise).get(nodeId) ?? '';
  };

  // Covers are validated for the whole batch before any `src` bytes move, so
  // a rejected cover never leaves half-imported sources behind.
  const stagedCoverUploads = options.stagedCoverUploads ?? [];
  const covers = options.agentCovers
    ? await resolveCovers(canvasId, commands, nodeType, stagedCoverUploads)
    : new Map<object, string | null>();

  const out: CanvasCommand[] = [];
  for (const cmd of commands) {
    if (cmd.type === 'CREATE_NODES') {
      const nodes = await Promise.all(
        cmd.nodes.map(async (original) => {
          const node = withCover(original, covers);
          const data = node.data as Record<string, unknown> | undefined;
          const mode = srcNormalizeMode(node.nodeType, data?.['src']);
          if (!mode) return node;
          const key = await resolveImportedSrc(
            canvasId,
            data?.['src'],
            mode.allowRemoteDownload,
            mode.allowedLocalExtensions,
            undefined,
            stagedCoverUploads,
          );
          if (key === null) return node;
          // Cast back to the discriminated create-input union — the engine
          // treats `data` structurally, but the static type is per-nodeType.
          return {
            ...node,
            data: { ...data, src: key },
          } as CanvasNodeCreateInput;
        }),
      );
      out.push({ ...cmd, nodes });
      continue;
    }
    if (cmd.type === 'MERGE_NODE_DATA') {
      const patches = await Promise.all(
        cmd.patches.map(async (original) => {
          const entry = covers.has(original)
            ? {
                ...original,
                patch: { ...original.patch, coverUrl: covers.get(original) },
              }
            : original;
          const mode = srcNormalizeMode(
            await nodeType(entry.nodeId),
            entry.patch?.['src'],
          );
          if (!mode) return entry;
          const key = await resolveImportedSrc(
            canvasId,
            entry.patch?.['src'],
            mode.allowRemoteDownload,
            mode.allowedLocalExtensions,
            undefined,
            stagedCoverUploads,
          );
          if (key === null) return entry;
          return { ...entry, patch: { ...entry.patch, src: key } };
        }),
      );
      out.push({ ...cmd, patches });
      continue;
    }
    out.push(cmd);
  }
  // After source normalization, which may have wanted the same upload.
  if (!options.stagedCoverUploads)
    await reclaimStagedUploads(stagedCoverUploads);
  return out;
}

/** Apply a resolved cover to a create input; a cleared cover is simply absent. */
function withCover(
  node: CanvasNodeCreateInput,
  covers: ReadonlyMap<object, string | null>,
): CanvasNodeCreateInput {
  if (!covers.has(node)) return node;
  const { coverUrl: _replaced, ...data } = (node.data ?? {}) as Record<
    string,
    unknown
  >;
  const cover = covers.get(node);
  return {
    ...node,
    data: cover === null ? data : { ...data, coverUrl: cover },
  } as CanvasNodeCreateInput;
}

/**
 * Resolve every agent-authored `coverUrl` in the batch to an existing image
 * artifact key (or `null` to clear), keyed by its create input / patch entry.
 * Throws {@link NodeCoverError} for a non-PDF target or an unusable image.
 */
async function resolveCovers(
  canvasId: string,
  commands: readonly CanvasCommand[],
  storedNodeType: (nodeId: string) => Promise<string>,
  stagedUploads: string[],
): Promise<Map<object, string | null>> {
  const covers = new Map<object, string | null>();
  // Nodes created earlier in this batch are not in the stored snapshot yet.
  const createdTypes = new Map<string, string>();
  // One import per distinct value, so two PDFs may share a staged upload.
  const keyByValue = new Map<string, string>();
  // Staged uploads are only recorded here, never removed: a rejected batch
  // must leave them for the retry, and the same upload may still be wanted as
  // a node `src` later in this batch.
  const resolve = async (owner: object, type: string, raw: unknown) => {
    if (type !== 'pdf')
      throw new NodeCoverError('coverUrl is supported only on PDF nodes');
    if (raw === null) {
      covers.set(owner, null);
      return;
    }
    const value = raw as string;
    // The contract offers HTTPS only; node `src` imports are more lenient,
    // but nothing obliges a cover to be fetched in the clear.
    if (/^http:\/\//i.test(value))
      throw new NodeCoverError(
        `PDF cover ${JSON.stringify(raw)} must use HTTPS, a staged upload path, or an existing artifact key`,
      );
    let key = keyByValue.get(value);
    if (key === undefined) {
      key =
        (await resolveImportedSrc(
          canvasId,
          value,
          true,
          COVER_EXTENSIONS,
          stagedUploads,
        )) ?? value;
      if (!(await isCoverImage(canvasId, key)))
        throw new NodeCoverError(
          `PDF cover ${JSON.stringify(raw)} is not an available image: use a staged upload path, an existing artifact key, or an HTTPS image URL`,
        );
      keyByValue.set(value, key);
    }
    covers.set(owner, key);
  };

  for (const cmd of commands) {
    if (cmd.type === 'CREATE_NODES') {
      for (const node of cmd.nodes) {
        if (node.id) createdTypes.set(node.id, node.nodeType);
        const data = node.data as Record<string, unknown> | undefined;
        if (data?.['coverUrl'] !== undefined)
          await resolve(node, node.nodeType, data['coverUrl']);
      }
    } else if (cmd.type === 'MERGE_NODE_DATA') {
      for (const entry of cmd.patches) {
        const raw = (entry.patch as Record<string, unknown>)['coverUrl'];
        if (raw === undefined) continue;
        const type =
          createdTypes.get(entry.nodeId) ??
          (await storedNodeType(entry.nodeId));
        // An unknown target is the engine's to reject, not a cover problem.
        if (type) await resolve(entry, type, raw);
      }
    }
  }
  return covers;
}

function noop(): void {
  /* best-effort cleanup — the copy already succeeded */
}

/**
 * Whether `key` names a stored artifact whose bytes are a supported raster
 * image. The extension alone proves nothing: a `.png` URL can answer with an
 * HTML error page, and a broken cover would replace a working thumbnail.
 */
async function isCoverImage(canvasId: string, key: string): Promise<boolean> {
  if (
    path.basename(key) !== key ||
    !COVER_EXTENSIONS.has(path.extname(key).toLowerCase())
  )
    return false;
  const bytes = await space(canvasId).artifacts.read(key);
  if (!bytes) return false;
  try {
    const image = imageSize(bytes);
    return (
      !!image.width && !!image.height && COVER_IMAGE_TYPES.has(image.type ?? '')
    );
  } catch {
    return false;
  }
}

/**
 * Classify a `src` value and, when it points at a foreign resource, pull the
 * bytes into `.artifacts/` and return the new bare key. Returns `null` when
 * the value is already renderable (or cannot be safely imported), signalling
 * the caller to leave it unchanged.
 *
 * `allowRemoteDownload` gates the `http(s)://` branch: media node types
 * download and fix up remote srcs, but validated YouTube video URLs and
 * live `web` URLs stay verbatim (see {@link srcNormalizeMode}). When
 * `allowedLocalExtensions` is present, local files outside that allowlist are
 * preserved in place and left unchanged.
 */
async function resolveImportedSrc(
  canvasId: string,
  raw: unknown,
  allowRemoteDownload: boolean,
  allowedLocalExtensions?: ReadonlySet<string>,
  deferredUploads?: string[],
  keptUploads?: readonly string[],
): Promise<string | null> {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const src = raw;
  if (src.startsWith('data:')) return null;

  // Online address — download unless it is already an app artifact URL the
  // web client re-bases itself, or this node type keeps live URLs verbatim.
  if (/^https?:\/\//i.test(src)) {
    if (!allowRemoteDownload) return null;
    let pathname: string;
    try {
      pathname = new URL(src).pathname;
    } catch {
      return null;
    }
    if (
      pathname.startsWith('/api/canvas/') ||
      pathname.startsWith('/api/artifact/')
    ) {
      return null;
    }
    return await downloadToArtifact(canvasId, src, pathname);
  }

  // Already an in-app API path — leave it for the web resolver.
  if (src.startsWith('/api/')) return null;

  // Relative / local path. Map RFS virtual prefixes (`upload/`, `artifacts/`)
  // onto their physical `.`-dirs, then resolve within the canvas sandbox.
  const physicalRel = toPhysicalRel(src);
  let absPath: string;
  try {
    absPath = safeResolve(canvasId, physicalRel);
  } catch {
    // Escapes the canvas root (or an absolute path elsewhere) — refuse to
    // touch it; the user explicitly asked to only relocate non-absolute refs.
    return null;
  }

  // A direct artifact child needs no copy, but it still needs the canonical
  // bare-key spelling the web resolver serves. Classify the path after
  // sandbox resolution so a ref that leaves and re-enters the current Space
  // is judged by where it actually lands, while the helper still owns the
  // virtual/physical `.artifacts` vocabulary. A nested path is not a blob key,
  // so it falls through and is copied into the artifact root below.
  const resolvedPhysicalRel = path.relative(sandboxRoot(canvasId), absPath);
  if (isArtifactsRel(resolvedPhysicalRel)) {
    const key = path.basename(absPath);
    const canonicalPath = safeResolve(
      canvasId,
      toPhysicalRel(`artifacts/${key}`),
    );
    if (absPath === canonicalPath) return key;
  }

  // A bare key like `art_abc.png` resolves under the canvas root but has no
  // file on disk there — leave it so the web resolver builds the artifact URL.
  if (!existsSync(absPath) || !statSync(absPath).isFile()) return null;

  const localExt = path.extname(absPath).toLowerCase();
  if (allowedLocalExtensions && !allowedLocalExtensions.has(localExt)) {
    log.warn(
      { src, localExt, allowedLocalExtensions: [...allowedLocalExtensions] },
      'Local node src has an unsupported extension; skipped',
    );
    return null;
  }

  return await copyToArtifact(
    canvasId,
    absPath,
    physicalRel,
    deferredUploads,
    keptUploads,
  );
}

/** Copy a canvas-local file into blob storage, returning the new key. */
async function copyToArtifact(
  canvasId: string,
  absPath: string,
  physicalRel: string,
  deferredUploads?: string[],
  keptUploads?: readonly string[],
): Promise<string | null> {
  try {
    const ext = path.extname(absPath) || '.bin';
    const id = createId('artifact');
    const key = `${id}${ext}`;
    const buffer = await readFile(absPath);
    await space(canvasId).artifacts.put(key, buffer);

    // Move semantics: reclaim RFS scratch uploads once they are safely
    // stored. Never delete user node files or other canvas content —
    // only the hidden `.upload/` staging dir is fair game.
    const normalized = physicalRel.split(path.sep).join('/');
    if (!normalized.startsWith(UPLOAD_DIR_NAME + '/')) return key;
    // A caller that may still reject the batch reclaims the upload itself.
    if (deferredUploads) deferredUploads.push(absPath);
    // Already owed to a cover in this batch: its owner decides when it goes.
    else if (!keptUploads?.includes(absPath)) {
      try {
        await rm(absPath, { force: true });
      } catch {
        /* best-effort cleanup — the copy already succeeded */
      }
    }
    return key;
  } catch (err) {
    log.warn(
      { err, absPath },
      'Failed to import local node src into artifacts',
    );
    return null;
  }
}

/** Download an online resource into `.artifacts/`, returning the new key. */
async function downloadToArtifact(
  canvasId: string,
  url: string,
  pathname: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await outboundFetch(url, {
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      log.warn({ url, status: res.status }, 'Online src download failed');
      return null;
    }
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      log.warn({ url, declared }, 'Online src exceeds size cap; skipped');
      return null;
    }
    const contentType = (res.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_DOWNLOAD_BYTES) {
      log.warn({ url, size: buffer.length }, 'Online src empty / oversized');
      return null;
    }
    const ext = pickDownloadExt(pathname, contentType);
    const key = `${createId('artifact')}${ext}`;
    await space(canvasId).artifacts.put(key, buffer);
    return key;
  } catch (err) {
    log.warn({ err, url }, 'Failed to download online node src into artifacts');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Pick an extension for a downloaded file from its URL suffix or MIME type. */
function pickDownloadExt(pathname: string, contentType: string): string {
  const urlExt = path.extname(pathname).toLowerCase();
  if (urlExt && KNOWN_MEDIA_EXT.has(urlExt)) return urlExt;
  const fromMime = EXT_BY_MIME[contentType];
  if (fromMime) return fromMime;
  return urlExt || '.bin';
}
