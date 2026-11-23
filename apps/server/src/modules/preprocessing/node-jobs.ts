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
 * A job runs in the call that committed the write, so the Utility Agent,
 * credentials and network restrictions it uses are that caller's: the
 * member whose page or Agent run made the change, or the deployment's for a
 * machine credential.
 */

import {
  buildPreprocessSnapshot,
  isLabelProtected,
  type CanvasCommand,
  type PreprocessNodeRequest,
} from '@huabu/shared';

import { getLogger } from '../../utils/logger.js';
import { executeOnServer } from '../canvas/canvas-executor.js';
import { publishCanvasUpdate } from '../canvas/canvas-sync.js';
import { updateNode } from '../canvas/write-coordinator.js';
import { callerAccess } from '../identity/personal-settings.js';
import { space } from '../storage/index.js';
import { getWorkspaceKey } from '../workspace.js';
import {
  selectAfterContentSave,
  selectNodesToPreprocess,
  type PreprocessCandidate,
} from './commit-trigger.js';

import { getPreprocessDispatcher } from './index.js';

import type { PreprocessNodeResult } from './types.js';
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
  next?: PreprocessCandidate;
}

const jobs = new Map<string, Job>();

const jobKey = (canvasId: string, nodeId: string): string =>
  JSON.stringify([getWorkspaceKey(), canvasId, nodeId]);

/** Resolves when no job is running; for tests and orderly shutdown. */
export async function waitForNodePreprocessing(): Promise<void> {
  while (jobs.size > 0)
    await Promise.all([...jobs.values()].map((job) => job.running));
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
        void frameCandidate(save, frame.id)
          .then((candidate) => {
            if (candidate) startNodePreprocessing(save.canvasId, [candidate]);
          })
          .catch((error: unknown) =>
            log.warn(
              {
                canvasId: save.canvasId,
                frameId: frame.id,
                err: String(error),
              },
              'could not prepare Frame preprocessing',
            ),
          );
    };
  },
};

/** A Frame whose child was just given another title, as a candidate. */
async function frameCandidate(
  save: NodeContentSave,
  frameId: string,
): Promise<PreprocessCandidate | undefined> {
  const records = await space(save.canvasId).nodes.list();
  const frameRecord = records.get(frameId)?.record;
  if (!frameRecord) return undefined;
  const labels = (titleOfSaved: string | null | undefined): string[] =>
    save.storedNodes
      .filter((node) => node.parentId === frameId)
      .map((node) =>
        node.id === save.nodeId
          ? titleOfSaved
          : records.get(node.id)?.record.label,
      )
      .map((label) => (typeof label === 'string' ? label.trim() : ''))
      .filter((label) => label.length > 0);
  const base = {
    title: frameRecord.label || undefined,
    labelSource: (frameRecord.labelSource as string) || undefined,
  };
  return {
    node: { id: frameId, type: 'frame' } as CanvasNode,
    snapshot: { ...base, childLabels: labels(save.after.label) },
    previousSnapshot: { ...base, childLabels: labels(save.before.label) },
  };
}

/**
 * Start preprocessing for the nodes a committed write selected. Returns at
 * once; a node that is already being processed is processed again when that
 * run ends, with the input of the earliest write still waiting as "before".
 */
export function startNodePreprocessing(
  canvasId: string,
  candidates: readonly PreprocessCandidate[],
): void {
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
        ...candidate,
        // What the pipeline last saw is the first waiting write's "before".
        ...(active.next
          ? { previousSnapshot: active.next.previousSnapshot }
          : {}),
      };
      continue;
    }
    const job: Job = {
      running: Promise.resolve(),
      current: candidate.snapshot,
    };
    jobs.set(key, job);
    job.running = (async () => {
      let current: PreprocessCandidate | undefined = candidate;
      while (current) {
        job.current = current.snapshot;
        await runJob(canvasId, current);
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
  let error: string | undefined;
  publishCanvasUpdate(canvasId, {
    type: 'preprocess',
    data: { nodeId, status: 'pending' },
  });
  try {
    const result = await getPreprocessDispatcher().preprocess({
      canvasId,
      nodeId,
      nodeType: node.type as PreprocessNodeRequest['nodeType'],
      trigger: previousSnapshot ? 'node_updated' : 'node_inserted',
      snapshot,
      ...(previousSnapshot ? { previousSnapshot } : {}),
      options: { allowLLM: true, allowPersistence: true, force: false },
      // As the request route does for a restricted caller.
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

  let wrote = false;
  const outcome = await updateNode(handle.nodes, nodeId, {
    apply: (existing) => {
      // Never create a sidecar: a node deleted meanwhile stays deleted.
      if (!existing) return null;
      const next: NodeContent = { ...existing };
      // A title a person or an Agent gave meanwhile is theirs.
      if (label && !isLabelProtected(existing.labelSource, existing.label)) {
        next.label = label;
        next.labelSource = 'auto';
      }
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
