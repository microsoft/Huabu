import { type Node, type NodeProps } from '@xyflow/react';
import { Fullscreen, ArrowUpRight } from 'lucide-react';
import { memo, useState, useEffect, useMemo } from 'react';

import { getWebPreview } from '@/api/web';

import { NodeWrapper } from './NodeWrapper.tsx';
import { PreviewCard } from './PreviewCard.tsx';
import { useNodeScale } from '../../hooks/useNodeScale.ts';
import useCanvasStore from '../../store/canvasStore.ts';
import { IconButton } from '../Common/IconButton.tsx';

import type { CanvasWebNodeData } from './types.ts';

export type WebNodeType = Node<CanvasWebNodeData, 'web'>;

export const WebNode = memo(
  ({ id, data, selected }: NodeProps<WebNodeType>) => {
    const scale = useNodeScale(id, 'web');
    const openExpanded = useCanvasStore((s) => s.openExpanded);
    const ingestion = useCanvasStore((state) => state.ingestionByNodeId[id]);

    const [refreshKey] = useState(0);

    const [preview, setPreview] = useState<Awaited<
      ReturnType<typeof getWebPreview>
    > | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);

    const src = typeof data?.src === 'string' ? data.src : '';
    const sourceId = typeof data?.sourceId === 'string' ? data.sourceId : '';

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

      if (!sourceId) {
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
          const result = await getWebPreview({ sourceId });
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
    }, [src, sourceId, refreshKey, ingestion?.status]);

    const WebToolbar = (
      <div className="flex w-full items-center justify-between gap-2">
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

        <div className="text-fg-muted flex items-center gap-1">
          <div className="bg-border h-3 w-px" />

          <IconButton
            aria-label="Open large view"
            title="Open Large View"
            onClick={(e) => {
              e.stopPropagation();
              openExpanded(id);
            }}
          >
            <Fullscreen size={14} />
          </IconButton>
        </div>
      </div>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'web'}
        selected={selected}
        toolbar={WebToolbar}
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
              <div className="bg-surface relative h-full w-full overflow-hidden rounded">
                {src ? (
                  <div className="flex h-full w-full flex-col gap-2">
                    {previewLoading ? (
                      <div className="text-fg-subtle text-base">
                        Loading preview...
                      </div>
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
                        title={preview.title || src}
                      >
                        {preview.contentHtml ? (
                          <div className="min-h-0 flex-1 overflow-hidden px-2 pb-2">
                            <div
                              className="text-fg-muted prose prose-base overflow-hidden text-base leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-base [&_h3]:font-medium [&_img]:max-w-full [&_img]:rounded [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1"
                              dangerouslySetInnerHTML={{
                                __html: preview.contentHtml,
                              }}
                            />
                          </div>
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
