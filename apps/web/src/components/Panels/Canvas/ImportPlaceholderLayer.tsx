// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ViewportPortal } from '@xyflow/react';
import { RefreshCw, X } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/components/Common/cn';
import { Loading } from '@/components/Common/Loading';
import { nodeMetricsForSize } from '@/components/Nodes/design/nodeDesign';
import { NodeNotice } from '@/components/Nodes/NodeNotice';
import { getNodeIcon } from '@/config/nodeIcons';
import {
  useImportPlaceholderStore,
  type ImportPlaceholder,
} from '@/store/importPlaceholderStore';

/** Above every node, so a card dropped onto a frame is not hidden by it. */
const PLACEHOLDER_Z_INDEX = 2_000_000_000;
/** Below this height a card has room for one row only (an audio node). */
const COMPACT_MAX_HEIGHT = 120;

function UploadingContent({
  item,
  compact,
}: {
  item: ImportPlaceholder;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const Icon = getNodeIcon(item.nodeType);
  return (
    <>
      {item.previewUrl ? (
        <img
          src={item.previewUrl}
          alt=""
          draggable={false}
          className="h-full w-full object-cover opacity-50"
        />
      ) : (
        <div
          className={cn(
            'text-fg-muted flex h-full w-full items-center justify-center px-4',
            compact ? 'gap-2' : 'flex-col gap-3',
          )}
        >
          <Icon
            className={cn(
              'text-fg-subtle shrink-0',
              compact ? 'h-4 w-4' : 'h-8 w-8',
            )}
          />
          <span
            className="max-w-full min-w-0 truncate text-sm"
            title={item.name}
          >
            {item.name}
          </span>
        </div>
      )}
      <div className="absolute right-2 bottom-2">
        <Loading layout="inline" size="xs" className="text-fg-subtle" />
        <span className="sr-only">
          {t('node.uploadingFile', { name: item.name })}
        </span>
      </div>
    </>
  );
}

function FailedContent({ item }: { item: ImportPlaceholder }) {
  const { t } = useTranslation();
  const remove = useImportPlaceholderStore((s) => s.remove);
  return (
    // The file is the title and the reason sits under it; "upload failed"
    // above a reason such as "Failed to save file" would say it twice.
    <NodeNotice
      className="rounded-[inherit]"
      tone="danger"
      title={item.name}
      description={item.error ?? t('node.uploadFailed')}
      actions={[
        {
          label: t('node.retryUpload'),
          icon: RefreshCw,
          onClick: () => item.retry?.(),
        },
        {
          label: t('node.removeUpload'),
          icon: X,
          onClick: () => remove(item.id),
        },
      ]}
    />
  );
}

function ImportPlaceholderCard({ item }: { item: ImportPlaceholder }) {
  return (
    <div
      data-import-placeholder={item.error ? 'failed' : 'uploading'}
      role="status"
      // The viewport ignores the pointer; only a failed card needs it, for
      // its buttons. An uploading card lets a pan or a click pass through.
      className={cn(
        'nodrag nopan absolute overflow-hidden',
        item.error
          ? 'pointer-events-auto'
          : 'bg-surface border-edge-default border',
      )}
      style={{
        left: item.x,
        top: item.y,
        width: item.width,
        height: item.height,
        borderRadius: nodeMetricsForSize(item.width, item.height).radius,
        zIndex: PLACEHOLDER_Z_INDEX,
      }}
    >
      {item.error ? (
        <FailedContent item={item} />
      ) : (
        <UploadingContent
          item={item}
          compact={item.height < COMPACT_MAX_HEIGHT}
        />
      )}
    </div>
  );
}

/** Cards for files that are still uploading into this Space. */
export const ImportPlaceholderLayer = memo(function ImportPlaceholderLayer({
  canvasId,
}: {
  canvasId: string | undefined;
}) {
  const placeholders = useImportPlaceholderStore((s) => s.placeholders);
  const visible = placeholders.filter((item) => item.canvasId === canvasId);
  if (visible.length === 0) return null;
  return (
    <ViewportPortal>
      <div data-canvas-grounding-exclude className="contents">
        {visible.map((item) => (
          <ImportPlaceholderCard key={item.id} item={item} />
        ))}
      </div>
    </ViewportPortal>
  );
});
