// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Preprocessing the server starts itself after a write.
 *
 * One job per node. It runs the pipeline with the node as the write left it
 * and the input it had before, writes what the pipeline derived back to the
 * node, and tells every page: `preprocess` events carry the status
 * (`pending`, then `done` or `error`), and the result reaches pages the way
 * any saved node content does (`invalidate`, or an `update` for the fields
 * kept with the Space's structure).
 *
 * A run is made as the caller whose write it follows, so the Utility Agent,
 * credentials, access and network restrictions it uses are that caller's:
 * the member whose page or Agent run made the change, or the deployment's
 * for a machine credential. That holds for a run that waited behind another
 * member's, too.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  buildPreprocessSnapshot,
  isLabelProtected,
  type CanvasCommand,
  type CanvasNodeType,
} from '@huabu/shared';

import { getLogger } from '../../utils/logger.js';
import { executeOnServer } from '../canvas/canvas-executor.js';
import { publishCanvasUpdate } from '../canvas/canvas-sync.js';
import { updateNode, withCanvasMutex } from '../canvas/write-coordinator.js';
import { callerAccess } from '../identity/personal-settings.js';
import { space } from '../storage/index.js';
import { getWorkspaceKey } from '../workspace.js';
import {
  selectAfterContentSave,
  selectNodesToPreprocess,
  type PreprocessCandidate,
} from './commit-trigger.js';

import { getPreprocessDispatcher, getProfile } from './index.js';

import type { PreprocessableNodeType, PreprocessNodeResult } from './types.js';
import type {
  CommitReactions,
  NodeContentSave,
} from '../canvas/commit-follow-up.js';
import type { NodeContent } from '../storage/index.js';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

const log = getLogger('preprocessing.jobs');

interface Job {
  running: Promise<void>;
  /** The input of the run under way. */
  current: Record<string, unknown>;
  /** A later write to the same node, to run once this one has finished. */
  next?: Waiting;
}

/** A candidate with the caller whose write selected it. */
interface Waiting {
  candidate: PreprocessCandidate;
  /**
   * Runs a function as that caller: a run uses the settings and the access
   * of the member whose write it follows, not of whoever's write happened to
   * start the job it waited behind.
   */
  asCaller: <T>(fn: () => T) => T;
}

const jobs = new Map<string, Job>();

const jobKey = (canvasId: string, nodeId: string): string =>
  JSON.stringify([getWorkspaceKey(), canvasId, nodeId]);

/** Frames being read to see whether a child's new title is their input. */
const preparing = new Set<Promise<void>>();

/** Resolves when nothing is running or about to; for orderly shutdown. */
export async function waitForNodePreprocessing(): Promise<void> {
  while (jobs.size > 0 || preparing.size > 0)
    await Promise.all([
      ...[...jobs.values()].map((job) => job.running),
      ...preparing,
    ]);
}

/**
 * The reactions to committed writes: preprocess the nodes a write created or
 * whose preprocessing input it changed. Installed with `setCommitReactions`
 * where the server is assembled.
 */
export const preprocessAfterWrites: CommitReactions = {
  batch(commit) {
    const candidates = selectNodesToPreprocess(commit);
    if (candidates.length === 0) return undefined;
    return () => startNodePreprocessing(commit.canvasId, candidates);
  },

  agentNodeRestored(canvasId, node) {
    return () =>
      startNodePreprocessing(canvasId, [
        { node, snapshot: buildPreprocessSnapshot(node, () => []) },
      ]);
  },

  contentSave(save) {
    const selected = selectAfterContentSave(save);
    const parentId = selected.titleChanged
      ? save.storedNodes.find((node) => node.id === save.nodeId)?.parentId
      : undefined;
    const frame = parentId
      ? save.storedNodes.find(
          (node) => node.id === parentId && node.type === 'frame',
        )
      : undefined;
    if (!selected.node && !frame) return undefined;
    return () => {
      if (selected.node)
        startNodePreprocessing(save.canvasId, [
          {
            node: { id: save.nodeId, type: save.nodeType } as CanvasNode,
            ...selected.node,
          },
        ]);
      if (frame)
        startFrameAfterChildTitle({
          canvasId: save.canvasId,
          frameId: frame.id,
          childId: save.nodeId,
          before: save.before.label,
          after: save.after.label,
          storedNodes: save.storedNodes,
        });
    };
  },
};

/** A child's title before and after a write, and the Frame holding it. */
interface ChildTitleChange {
  canvasId: string;
  frameId: string;
  childId: string;
  before: string | null | undefined;
  after: string | null | undefined;
  /** The Space's nodes as stored: structure only. */
  storedNodes: NodeContentSave['storedNodes'];
}

/**
 * Preprocess a Frame whose child was just given another title: by a page's
 * save, or by a run that derived one. Returns at once.
 */
function startFrameAfterChildTitle(change: ChildTitleChange): void {
  const prepared = frameCandidate(change)
    .then((candidate) => {
      if (candidate) startNodePreprocessing(change.canvasId, [candidate]);
    })
    .catch((error: unknown) =>
      log.warn(
        {
          canvasId: change.canvasId,
          frameId: change.frameId,
          err: String(error),
        },
        'could not prepare Frame preprocessing',
      ),
    )
    .finally(() => preparing.delete(prepared));
  preparing.add(prepared);
}

async function frameCandidate(
  change: ChildTitleChange,
): Promise<PreprocessCandidate | undefined> {
  const { frameId } = change;
  const children = change.storedNodes.filter(
    (node) => node.parentId === frameId,
  );
  // The Frame's record and its children's, not the Space's. Under the
  // Space's write lock: a run that is renaming a child's record (a new
  // title is a new file name) would otherwise be met half-way.
  const { nodes } = space(change.canvasId);
  const [frameRecord, ...childRecords] = await withCanvasMutex(
    change.canvasId,
    () =>
      Promise.all(
        [frameId, ...children.map((node) => node.id)].map(async (id) =>
          id === change.childId ? undefined : (await nodes.read(id))?.record,
        ),
      ),
  );
  if (!frameRecord) return undefined;
  const labels = (titleOfChild: string | null | undefined): string[] =>
    children
      .map((node, index) =>
        node.id === change.childId ? titleOfChild : childRecords[index]?.label,
      )
      .map((label) => (typeof label === 'string' ? label.trim() : ''))
      .filter((label) => label.length > 0);
  const base = {
    title: frameRecord.label || undefined,
    labelSource: (frameRecord.labelSource as string) || undefined,
  };
  return {
    node: { id: frameId, type: 'frame' } as CanvasNode,
    snapshot: { ...base, childLabels: labels(change.after) },
    previousSnapshot: { ...base, childLabels: labels(change.before) },
  };
}

/**
 * Start preprocessing for the nodes a committed write selected. Returns at
 * once; a node that is already being processed is processed again when that
 * run ends, with the input of the earliest write still waiting as "before".
 */
function startNodePreprocessing(
  canvasId: string,
  candidates: readonly PreprocessCandidate[],
): void {
  const asCaller = AsyncLocalStorage.snapshot();
  for (const candidate of candidates) {
    const key = jobKey(canvasId, candidate.node.id);
    const active = jobs.get(key);
    if (active) {
      // The same input as the run under way, with nothing waiting: that
      // run is this request.
      if (
        !active.next &&
        JSON.stringify(active.current) === JSON.stringify(candidate.snapshot)
      )
        continue;
      active.next = {
        candidate: {
          ...candidate,
          // What the pipeline last saw is the first waiting write's "before".
          ...(active.next
            ? { previousSnapshot: active.next.candidate.previousSnapshot }
            : {}),
        },
        asCaller,
      };
      continue;
    }
    const job: Job = {
      running: Promise.resolve(),
      current: candidate.snapshot,
    };
    jobs.set(key, job);
    job.running = (async () => {
      let current: Waiting | undefined = { candidate, asCaller };
      while (current) {
        const { candidate: next } = current;
        job.current = next.snapshot;
        await current.asCaller(() => runJob(canvasId, next));
        current = job.next;
        job.next = undefined;
      }
    })().finally(() => jobs.delete(key));
  }
}

async function runJob(
  canvasId: string,
  { node, snapshot, previousSnapshot }: PreprocessCandidate,
): Promise<void> {
  const nodeId = node.id;
  // A node whose record is gone (deleted meanwhile, or its file is missing)
  // is not processed: the pipeline would write a record for it. A record
  // that cannot be read is skipped the same way; the next write tries again.
  try {
    // Read under the Space's write lock, so a record that is being renamed
    // is not taken for a missing one.
    const record = await withCanvasMutex(canvasId, () =>
      space(canvasId).nodes.read(nodeId),
    );
    if (!record) return;
  } catch (cause) {
    log.warn(
      { canvasId, nodeId, err: String(cause) },
      'node record unreadable',
    );
    return;
  }
  let error: string | undefined;
  publishCanvasUpdate(canvasId, {
    type: 'preprocess',
    data: { nodeId, status: 'pending' },
  });
  try {
    const result = await getPreprocessDispatcher().preprocess({
      canvasId,
      nodeId,
      nodeType: node.type as PreprocessableNodeType,
      snapshot,
      ...(previousSnapshot ? { previousSnapshot } : {}),
      // A restricted caller's URLs must not reach the Server's own network.
      ...(callerAccess() !== null ? { publicNetworkOnly: true } : {}),
    });
    await writeBack(canvasId, node.type ?? '', nodeId, snapshot, result);
    error =
      result.success ||
      result.diagnostics.some((d) => d.code.includes('EMPTY_CONTENT'))
        ? undefined
        : result.diagnostics
            .filter((d) => d.level === 'error')
            .map((d) => `${d.code}: ${d.message}`)
            .join('; ') || 'Unknown preprocessing error';
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    log.warn({ canvasId, nodeId, err: error }, 'node preprocessing failed');
  }
  publishCanvasUpdate(canvasId, {
    type: 'preprocess',
    data: {
      nodeId,
      status: error ? 'error' : 'done',
      ...(error ? { error } : {}),
    },
  });
}

/**
 * Store what the pipeline derived and did not persist itself, and announce
 * it. The pipeline writes the extracted body; a suggested title, its `auto`
 * ownership, a canonical source, summary and keywords were returned to the
 * requesting page, which saved them. Here the server saves them.
 */
async function writeBack(
  canvasId: string,
  nodeType: string,
  nodeId: string,
  snapshot: Record<string, unknown>,
  result: PreprocessNodeResult,
): Promise<void> {
  const handle = space(canvasId);
  const label =
    typeof result.patch.label === 'string' ? result.patch.label : undefined;
  const src =
    typeof result.patch.src === 'string' ? result.patch.src : undefined;
  const summary = result.enriched?.summary;
  const keywords = result.enriched?.keywords;

  // A body a person writes can have moved on while the run was under way.
  // What was derived from the earlier one is not this body's.
  const authoredBody =
    getProfile(nodeType as CanvasNodeType)?.bodyOwnership === 'authored' &&
    typeof snapshot.content === 'string'
      ? snapshot.content
      : undefined;

  let wrote = false;
  let titleNow: string | null | undefined;
  const outcome = await updateNode(handle.nodes, nodeId, {
    apply: (existing) => {
      // Never create a sidecar: a node deleted meanwhile stays deleted.
      if (!existing) return null;
      titleNow = existing.label;
      if (authoredBody !== undefined && existing.content !== authoredBody)
        return null;
      const next: NodeContent = { ...existing };
      // A title a person or an Agent gave meanwhile is theirs.
      if (label && !isLabelProtected(existing.labelSource, existing.label)) {
        next.label = label;
        next.labelSource = 'auto';
      }
      titleNow = next.label;
      if (src) next.src = src;
      if (typeof summary === 'string' && summary.length > 0)
        next.summary = summary;
      if (Array.isArray(keywords) && keywords.length > 0)
        next.keywords = keywords;
      if (JSON.stringify(next) === JSON.stringify(existing)) return null;
      wrote = true;
      return next;
    },
  });
  if (outcome.status !== 'ok' && outcome.status !== 'noop')
    log.warn({ canvasId, nodeId, status: outcome.status }, 'result not stored');

  // The pipeline may have rewritten the body or the source even when
  // nothing was left for the write above; pages fetch the node either way.
  if (wrote || result.persistence?.contentChanged || result.success)
    publishCanvasUpdate(canvasId, {
      type: 'invalidate',
      data: { nodeIds: [nodeId] },
    });

  // The title this run started from is the Frame's input no longer: the
  // Frame holding the node is processed too, also when the node is itself
  // a Frame. Compared with the run's input
  // and not with the record before the write above, because the pipeline
  // stores some titles itself.
  const titleBefore =
    typeof snapshot.title === 'string' ? snapshot.title : undefined;
  if ((titleNow ?? '') !== (titleBefore ?? '')) {
    const storedNodes = ((await handle.read())?.state.nodes ??
      []) as NodeContentSave['storedNodes'];
    const parentId = storedNodes.find((node) => node.id === nodeId)?.parentId;
    const frame = parentId
      ? storedNodes.find(
          (node) => node.id === parentId && node.type === 'frame',
        )
      : undefined;
    if (frame)
      startFrameAfterChildTitle({
        canvasId,
        frameId: frame.id,
        childId: nodeId,
        before: titleBefore,
        after: titleNow,
        storedNodes,
      });
  }

  if (nodeType !== 'video') return;
  // A video's cover is kept with the Space's structure. It is accepted only
  // for the source it was made from.
  const { coverUrl, coverSourceSrc } = result.patch;
  let patch: Record<string, unknown> | undefined;
  let unset: string[] | undefined;
  if (coverUrl === null && coverSourceSrc === null) {
    unset = ['coverUrl', 'coverSourceSrc'];
    patch = {};
  } else if (
    typeof coverUrl === 'string' &&
    coverSourceSrc === (src ?? snapshot.src)
  ) {
    patch = { coverUrl, coverSourceSrc };
  }
  if (!patch) return;
  await executeOnServer({
    canvasId,
    commands: [
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId, patch, ...(unset ? { unset } : {}) }],
      } as CanvasCommand,
    ],
    // As when a page stored it: no page records it for undo, and it is not
    // an Agent change to review.
    originator: { source: 'ui' },
  });
}
