import { Fullscreen, ArrowUpRight } from 'lucide-react';
import { memo, useState, useEffect, useMemo } from 'react';

import { getWebPreview } from '@/api/web';

import { useNodeScale } from '../../../hooks/useNodeScale.ts';
import useCanvasStore from '../../../store/canvasStore.ts';
import { FloatingToolbar } from '../../Common/FloatingToolbar.tsx';
import { LoadingState } from '../../Common/LoadingState.tsx';
import { NodeWrapper } from '../NodeWrapper.tsx';
import { PreviewCard } from '../PreviewCard.tsx';

import type { CanvasWebNodeData } from '../types.ts';
import type { Node, NodeProps } from '@xyflow/react';

export type WebNodeType = Node<CanvasWebNodeData, 'web'>;

export const WebNode = memo(
  ({ id, data, selected }: NodeProps<WebNodeType>) => {
    const scale = useNodeScale(id, 'web');
    const openExpanded = useCanvasStore((s) => s.openExpanded);
    const canvasId = useCanvasStore((s) => s.canvasId);
    const ingestion = useCanvasStore((state) => state.ingestionByNodeId[id]);

    const [refreshKey] = useState(0);

    const [preview, setPreview] = useState<Awaited<
      ReturnType<typeof getWebPreview>
    > | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);

    const src = typeof data?.src === 'string' ? data.src : '';
    // Preview artifact only exists after preprocessing has persisted it.
    // `data.content` is hydrated from the per-node .md so its presence
    // is a reliable "web preview is ready" signal.
    const hasIngestedContent =
      typeof data?.content === 'string' && data.content.length > 0;

    const hostname = useMemo(() => {
      if (!src) return '';
      try {
        return new URL(src).hostname;
      } catch {
        return '';
      }
    }, [src]);

    useEffect(() => {
      if (ingestion?.status === 'pending') {
        setPreview(null);
        setPreviewError(null);
        setPreviewLoading(false);
        return;
      }

      if (!src) {
        setPreview(null);
        setPreviewError(null);
        setPreviewLoading(false);
        return;
      }

      if (!hasIngestedContent) {
        setPreview(null);
        setPreviewError(null);
        setPreviewLoading(false);
        return;
      }

      if (!canvasId) {
        setPreview(null);
        setPreviewError(null);
        setPreviewLoading(false);
        return;
      }

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
    }, [src, hasIngestedContent, canvasId, refreshKey, ingestion?.status, id]);

    const WebActions = (
      <>
        <a
          href={data?.src}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="nodrag text-fg-muted hover:text-info flex flex-1 cursor-pointer items-center gap-1 overflow-hidden text-xs font-medium transition-colors"
        >
          <span className="max-w-24 truncate">{data?.src || 'Website'}</span>
          <ArrowUpRight size={14} strokeWidth={2} />
        </a>
        <FloatingToolbar.ActionButton
          title="Open Large View"
          onClick={(e) => {
            e.stopPropagation();
            openExpanded(id);
          }}
        >
          <Fullscreen />
        </FloatingToolbar.ActionButton>
      </>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'web'}
        selected={selected}
        actions={WebActions}
        keepAspectRatio={false}
      >
        <div className="h-full w-full overflow-hidden">
          <div
            style={{
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              width: `${100 / scale}%`,
              height: `${100 / scale}%`,
            }}
          >
            <div className="flex h-full flex-col">
              <div className="bg-surface relative h-full w-full overflow-hidden rounded-lg">
                {src ? (
                  <div className="flex h-full w-full flex-col gap-2">
                    {previewLoading ? (
                      <LoadingState message="Loading preview..." />
                    ) : null}

                    {previewError && ingestion?.status !== 'pending' ? (
                      <div className="text-fg-subtle text-base">
                        Preview unavailable
                        {hostname ? ` • ${hostname}` : ''}
                      </div>
                    ) : null}

                    {!previewLoading && !previewError && preview ? (
                      <PreviewCard
                        image={preview.image}
                        nodeType="web"
                        favicon={preview.favicon}
                        title={preview.label || data?.label || src}
                        accentColor={data.style?.accent}
                      >
                        {preview.summary ? (
                          <p className="text-fg-muted line-clamp-5 text-base leading-relaxed">
                            {preview.summary}
                          </p>
                        ) : preview.contentHtml ? (
                          <div
                            className="text-fg-muted prose prose-base line-clamp-5 text-base leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-base [&_h3]:font-medium [&_img]:max-w-full [&_img]:rounded [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1"
                            dangerouslySetInnerHTML={{
                              __html: preview.contentHtml,
                            }}
                          />
                        ) : null}
                      </PreviewCard>
                    ) : null}
                  </div>
                ) : (
                  <div className="text-fg-subtle flex h-full w-full items-center justify-center text-base">
                    Invalid URL
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </NodeWrapper>
    );
  },
);
