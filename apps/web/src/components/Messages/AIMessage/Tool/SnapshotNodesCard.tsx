// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * SnapshotNodesCard — disclosure-shaped renderer for the
 * `snapshot_nodes` tool. The collapsed row shows a single self-describing
 * line ("Snapshotted 3 nodes → 2 images"); the expanded body shows
 * each produced PNG as a thumbnail with the originating node refs
 * directly below it — so a user can verify that the AI's vision
 * input matches what they expected (the #1 reason this card exists:
 * snapshots are auto-run on selected sketches before the model's
 * first turn, and there's otherwise no way to inspect them).
 */

import { Camera, X as XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { partIsExecuting } from './helpers';
import { resolveArtifactUrl } from '../../../../api/artifact';
import useCanvasStore from '../../../../store/canvasStore';
import { Loading } from '../../../Common/Loading';
import { NodeRef } from '../../../Common/NodeRef';
import { AssistantDisclosure } from '../../AssistantDisclosure';

import type { SnapshotEntry, SnapshotNodesToolPart } from '@huabu/shared';

interface SnapshotNodesCardProps {
  part: SnapshotNodesToolPart;
}

function pickDataFields(part: SnapshotNodesToolPart): {
  nodeIds: string[];
  snapshots: SnapshotEntry[];
  error: string | undefined;
} {
  const env = part.data;
  if (!env) return { nodeIds: [], snapshots: [], error: undefined };
  if (env.status === 'success') {
    const merged = (env.data ?? {}) as Record<string, unknown>;
    const nodeIds = Array.isArray(merged.nodeIds)
      ? (merged.nodeIds as string[])
      : [];
    const snapshots = Array.isArray(merged.snapshots)
      ? (merged.snapshots as SnapshotEntry[])
      : [];
    return { nodeIds, snapshots, error: undefined };
  }
  return {
    nodeIds: [],
    snapshots: [],
    error: typeof env.error === 'string' ? env.error : undefined,
  };
}

export function SnapshotNodesCard({ part }: SnapshotNodesCardProps) {
  const { t } = useTranslation();
  const canvasId = useCanvasStore((s) => s.canvasId);
  const { nodeIds, snapshots, error: rawError } = pickDataFields(part);
  const executing = partIsExecuting(part);
  const failed = part.status === 'failed' || rawError !== undefined;
  const error = rawError ?? (failed ? t('messages.snapshotFailed') : undefined);

  // ── Title ──────────────────────────────────────────────────────────
  const nodeCount = nodeIds.length;
  const imageCount = snapshots.length;
  const nodesLabel = t('messages.node', { count: nodeCount });
  const imagesLabel = t('messages.image', { count: imageCount });

  let title: string;
  if (executing) {
    title =
      nodeCount > 0
        ? t('messages.snapshottingNodesCount', { count: nodeCount })
        : t('messages.snapshottingNodes');
  } else if (failed) {
    title = t('messages.snapshotFailed');
  } else if (imageCount === nodeCount) {
    // 1:1 mapping (typical for pure image nodes / single-stroke sketches)
    title = t('messages.snapshottedNodes', { count: nodeCount });
  } else {
    title = t('messages.snapshottedNodesImages', {
      nodes: nodeCount,
      nodeLabel: nodesLabel,
      images: imageCount,
      imageLabel: imagesLabel,
    });
  }

  // ── Icon ───────────────────────────────────────────────────────────
  const icon = executing ? (
    <Loading layout="inline" size="xs" className="text-info" />
  ) : failed ? (
    <XIcon size={12} className="text-danger" />
  ) : (
    <Camera size={12} className="text-fg-muted/60" />
  );

  // ── Body ───────────────────────────────────────────────────────────
  const body =
    snapshots.length > 0 || error ? (
      <div className="border-edge-default/40 ml-4 flex flex-col gap-2 border-l py-2 pl-3">
        {error ? (
          <div className="text-danger bg-bg-default rounded-sm px-2 py-1 text-xs whitespace-pre-wrap">
            {error}
          </div>
        ) : null}

        {snapshots.length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {snapshots.map((snap, i) => {
              const url = resolveArtifactUrl(snap.src, canvasId);
              const dims =
                snap.width > 0 && snap.height > 0
                  ? `${snap.width}×${snap.height}`
                  : undefined;
              return (
                <div
                  key={`${snap.src}-${i}`}
                  className="flex w-32 flex-col gap-1"
                >
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t('messages.openSnapshot', { src: snap.src })}
                    className="border-edge-default bg-bg-default block h-24 overflow-hidden rounded-md border"
                  >
                    <img
                      src={url}
                      alt={t('messages.snapshotAlt', { count: i + 1 })}
                      className="size-full object-contain"
                      loading="lazy"
                    />
                  </a>
                  {dims ? (
                    <div className="text-fg-subtle text-xs">{dims}</div>
                  ) : null}
                  {snap.originNodeIds.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {snap.originNodeIds.map((nid) => (
                        <NodeRef key={nid} nodeId={nid} />
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    ) : undefined;

  return (
    <AssistantDisclosure icon={icon} title={title} collapseSignal={!executing}>
      {body}
    </AssistantDisclosure>
  );
}
