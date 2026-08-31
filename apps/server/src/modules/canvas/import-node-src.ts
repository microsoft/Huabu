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
 *   - an **online** URL (`https://…/foo.png`).
 *
 * The web only serves node media from `<canvasDir>/.artifacts/` (via
 * `GET /api/canvas/:id/artifact/:key`), so any of the above renders as a
 * broken image. This hook rewrites each foreign `src` into a bare artifact
 * key by copying / downloading the bytes into `.artifacts/`. Values that are
 * already artifact keys, `/api/…` URLs, or `data:` URIs pass through
 * untouched, so the pass is idempotent and safe to run on every agent batch.
 *
 * Called from {@link import('./canvas-executor.js').executeOnServer} before
 * the shared engine sees the batch, so both agent write paths are covered by
 * one choke point.
 */

import { existsSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  createId,
  type CanvasCommand,
  type CanvasNodeCreateInput,
} from '@huabu/shared';

import { getLogger } from '../../utils/logger.js';
import {
  safeResolve,
  isArtifactsRel,
  sandboxRoot,
  toPhysicalRel,
} from '../agent/tools/handlers/fs-sandbox.js';
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
 * because these node types never carry a *live* URL — the web client only ever
 * renders their bytes from the artifact store.
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

interface SrcNormalizeMode {
  allowRemoteDownload: boolean;
  allowedLocalExtensions?: ReadonlySet<string>;
}

/**
 * Resolve how a given node type's `src` should be normalized, or `null` when
 * the type is not artifact-backed and should be left untouched.
 */
function srcNormalizeMode(type: string): SrcNormalizeMode | null {
  if (ARTIFACT_SRC_NODE_TYPES.has(type)) return { allowRemoteDownload: true };
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
export async function importForeignNodeSources(
  canvasId: string,
  commands: readonly CanvasCommand[],
): Promise<CanvasCommand[]> {
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

  const out: CanvasCommand[] = [];
  for (const cmd of commands) {
    if (cmd.type === 'CREATE_NODES') {
      const nodes = await Promise.all(
        cmd.nodes.map(async (node) => {
          const mode = srcNormalizeMode(node.nodeType);
          if (!mode) return node;
          const data = node.data as Record<string, unknown> | undefined;
          const key = await resolveImportedSrc(
            canvasId,
            data?.['src'],
            mode.allowRemoteDownload,
            mode.allowedLocalExtensions,
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
        cmd.patches.map(async (entry) => {
          const mode = srcNormalizeMode(await nodeType(entry.nodeId));
          if (!mode) return entry;
          const key = await resolveImportedSrc(
            canvasId,
            entry.patch?.['src'],
            mode.allowRemoteDownload,
            mode.allowedLocalExtensions,
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
  return out;
}

/**
 * Classify a `src` value and, when it points at a foreign resource, pull the
 * bytes into `.artifacts/` and return the new bare key. Returns `null` when
 * the value is already renderable (or cannot be safely imported), signalling
 * the caller to leave it unchanged.
 *
 * `allowRemoteDownload` gates the `http(s)://` branch: media node types
 * download and fix up remote srcs, but `web` nodes must keep a live URL
 * verbatim (see {@link LOCAL_ONLY_ARTIFACT_SRC_NODE_TYPES}). When
 * `allowedLocalExtensions` is present, local files outside that allowlist are
 * preserved in place and left unchanged.
 */
async function resolveImportedSrc(
  canvasId: string,
  raw: unknown,
  allowRemoteDownload: boolean,
  allowedLocalExtensions?: ReadonlySet<string>,
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

  return await copyToArtifact(canvasId, absPath, physicalRel);
}

/** Copy a canvas-local file into blob storage, returning the new key. */
async function copyToArtifact(
  canvasId: string,
  absPath: string,
  physicalRel: string,
): Promise<string | null> {
  try {
    const ext = path.extname(absPath) || '.bin';
    const id = createId('artifact');
    const key = `${id}${ext}`;
    const buffer = await readFile(absPath);
    await space(canvasId).blobs.put(key, buffer);

    // Move semantics: reclaim RFS scratch uploads once they are safely
    // stored. Never delete user node files or other canvas content —
    // only the hidden `.upload/` staging dir is fair game.
    const normalized = physicalRel.split(path.sep).join('/');
    if (normalized.startsWith(UPLOAD_DIR_NAME + '/')) {
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
    const res = await fetch(url, {
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
    await space(canvasId).blobs.put(key, buffer);
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
