// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Maximize2, ArrowUpRight } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getWebPreview } from '@/api/web';
import { DropdownMenuLink } from '@/components/Common/DropdownMenu';
import { useNodePresentation } from '@/hooks/useNodePresentation';

import { WebReadingView } from './WebReadingView';
import useCanvasStore from '../../../store/canvasStore.ts';
import { openPreviewNode } from '../../../store/previewWorkspace/actions.ts';
import { FloatingToolbar } from '../../Common/FloatingToolbar.tsx';
import { getMissingFileKind, MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper.tsx';
import {
  ViewportPreviewCard,
  usePreviewCardSize,
} from '../previewCard/PreviewCard';
import { useDeferredHydration } from '../shared/nodeHydrationScheduler.ts';

import type { CanvasWebNodeData } from '../types.ts';
import type { Node, NodeProps } from '@xyflow/react';

export type WebNodeType = Node<CanvasWebNodeData, 'web'>;

const REMOTE_URL_RE = /^https?:\/\//i;

function shortenForToolbar(src: string): string {
  if (!src) return 'Website';
  if (!REMOTE_URL_RE.test(src)) return src; // artifact key like `art_xxx.html`
  try {
    return new URL(src).hostname;
  } catch {
    return src;
  }
}

export const WebNode = memo(
  ({ id, data, selected, width, height }: NodeProps<WebNodeType>) => {
    const { t } = useTranslation();
    const cardSize = usePreviewCardSize(id, 'web', width, height);
    const presentation = useNodePresentation(id, 'web', 'reading');
    const isMinimalLOD = presentation.mode === 'minimal';
    const canvasId = useCanvasStore((s) => s.canvasId);
    const ingestion = useCanvasStore((state) => state.ingestionByNodeId[id]);

    const [preview, setPreview] = useState<Awaited<
      ReturnType<typeof getWebPreview>
    > | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [retryAttempt, setRetryAttempt] = useState(0);

    const handleRetry = useCallback(() => {
      setPreviewError(null);
      setPreviewLoading(true);
      setRetryAttempt((attempt) => attempt + 1);
    }, []);

    // Defer the per-node preview fetch through the shared per-frame
    // hydration scheduler. Without this, every WebNode on a freshly-
    // opened canvas would fire its `/api/web/preview` request in the
    // same tick and trigger a setState storm as each result lands
    // ~simultaneously. Minimal LOD skips the queue entirely; once the node
    // returns to full LOD, the hook grants one node per frame so requests +
    // paints stream in. See `../shared/nodeHydrationScheduler`.
    const webHydrated = useDeferredHydration(isMinimalLOD);

    const src = typeof data?.src === 'string' ? data.src : '';
    const missingFileKind = getMissingFileKind(data);
    const isRemoteUrl = REMOTE_URL_RE.test(src);
    const isInteractiveView =
      data.interactiveView !== null && typeof data.interactiveView === 'object';
    const showReading =
      !!src &&
      presentation.mode === 'reading' &&
      presentation.isVisible &&
      !isInteractiveView;

    // URL surfaced as the "open externally" link in the floating toolbar.
    // Only remote http(s) URLs have a meaningful destination — uploaded
    // HTML artifacts live under our same-origin `/api/canvas/...` path
    // and `data:` URLs are self-contained, so there's no point opening
    // either in the system browser.
    const externalHref = useMemo(
      () => (isRemoteUrl ? src : ''),
      [isRemoteUrl, src],
    );

    useEffect(() => {
      if (ingestion?.status === 'pending') {
        setPreview(null);
        setPreviewError(null);
        setPreviewLoading(false);
        return;
      }

      if (!src || !canvasId) {
        setPreview(null);
        setPreviewError(null);
        setPreviewLoading(false);
        return;
      }

      // Stagger the preview fetch through the shared hydration
      // scheduler so a canvas full of web nodes doesn't fire N
      // /api/web/preview requests + N React setState bursts in the
      // same frame on first mount. The hook returns `true` once this
      // node is granted a slot; subsequent re-runs (ingestion status
      // changes, src updates) re-enter this effect with `webHydrated`
      // already true, so the staggering cost is paid exactly once per
      // node lifetime. Minimal LOD also suppresses the request; entering it
      // while a request is in flight runs this effect's cleanup and ignores
      // the eventual result.
      if (isMinimalLOD) return;
      if (!webHydrated) return;

      let cancelled = false;
      setPreviewLoading(true);
      setPreviewError(null);

      void (async () => {
        try {
          const result = await getWebPreview({ canvasId, nodeId: id });
          if (cancelled) return;
          setPreview(result);
        } catch (error) {
          if (cancelled) return;
          // 404 here is normal — happens when the node markdown hasn't
          // been written yet (first render before preprocessing has
          // persisted anything). The next effect run (when ingestion
          // transitions out of pending) will retry.
          setPreview(null);
          setPreviewError(
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          if (!cancelled) setPreviewLoading(false);
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [
      src,
      canvasId,
      ingestion?.status,
      id,
      isMinimalLOD,
      webHydrated,
      retryAttempt,
    ]);

    const summary =
      preview?.summary ??
      (typeof data.summary === 'string' ? data.summary : undefined);
    const title = preview?.label || data?.label || src;
    const favicon = preview?.favicon;
    const fallbackImage = preview?.image;
    const siteName = preview?.siteName;

    const WebActions = (
      <>
        <FloatingToolbar.ActionButton
          title={t('node.openLargeView')}
          onClick={(e) => {
            e.stopPropagation();
            openPreviewNode(id);
          }}
        >
          <Maximize2 />
        </FloatingToolbar.ActionButton>
      </>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'web'}
        selected={selected}
        actions={missingFileKind ? undefined : WebActions}
        overflow={
          !missingFileKind && externalHref ? (
            <DropdownMenuLink
              to={externalHref}
              target="_blank"
              rel="noopener noreferrer"
              icon={<ArrowUpRight />}
            >
              {t('toolbar.openOriginalUrl')}
            </DropdownMenuLink>
          ) : undefined
        }
        resizable
        keepAspectRatio={false}
      >
        {missingFileKind ? (
          <MissingFileBanner nodeId={id} />
        ) : showReading ? (
          <WebReadingView
            key={`${canvasId}:${id}:${src}`}
            nodeId={id}
            canvasId={canvasId}
            src={src}
            interactive={presentation.isSoleSelected}
            zoom={presentation.zoom}
          />
        ) : (
          <div className="bg-surface relative flex h-full w-full flex-col rounded-[inherit]">
            {!src ? (
              <div className="text-fg-subtle flex h-full w-full items-center justify-center text-base">
                {t('node.invalidUrl')}
              </div>
            ) : (
              <ViewportPreviewCard
                {...cardSize}
                accent={data.style?.accent}
                minimal={isMinimalLOD}
                image={fallbackImage}
                imageAlt={title}
                nodeType="web"
                favicon={favicon}
                source={
                  isRemoteUrl ? shortenForToolbar(src) : siteName || 'HTML'
                }
                title={title}
                summary={summary}
                loading={
                  !isMinimalLOD &&
                  (ingestion?.status === 'pending' ||
                    previewLoading ||
                    (!webHydrated && !preview && !previewError))
                }
                error={previewError}
                onRetry={handleRetry}
              />
            )}
          </div>
        )}
      </NodeWrapper>
    );
  },
);
