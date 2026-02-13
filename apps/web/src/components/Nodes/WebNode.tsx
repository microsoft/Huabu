import { type Node, type NodeProps } from '@xyflow/react';
import { Globe, Fullscreen, ArrowUpRight } from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';

import { getWebPreview } from '@/api/web';

import { NodeWrapper } from './NodeWrapper.tsx';
import useCanvasStore from '../../store/canvasStore.ts';
import { GhostButton } from '../Common/GhostButton.tsx';

import type { NodeDataProps } from './types.ts';

type WebNodeData = NodeDataProps & {};
export type WebNodeType = Node<WebNodeData, 'web'>;

export const WebNode = ({ id, data, selected }: NodeProps<WebNodeType>) => {
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
        setPreviewError(error instanceof Error ? error.message : String(error));
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
        className="nodrag text-muted-foreground hover:text-theme-500 flex flex-1 cursor-pointer items-center gap-1 overflow-hidden text-xs font-medium transition-colors"
      >
        <Globe size={14} />
        <span className="max-w-24 truncate">{data?.src || 'Website'}</span>
        <ArrowUpRight size={14} strokeWidth={2} />
      </a>

      <div className="text-muted-foreground flex items-center gap-1">
        <div className="bg-border h-3 w-px" />

        <GhostButton
          aria-label="Open large view"
          title="Open Large View"
          onClick={(e) => {
            e.stopPropagation();
            openExpanded(id);
          }}
        >
          <Fullscreen size={14} />
        </GhostButton>
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
      onDoubleClick={(e) => {
        e.stopPropagation();
        openExpanded(id);
      }}
    >
      <div className="flex h-full flex-col">
        <div className="relative h-full w-full overflow-hidden rounded bg-white">
          {src ? (
            <div className="flex h-full w-full flex-col gap-2 p-3">
              {previewLoading ? (
                <div className="text-muted-foreground text-xs">
                  Loading preview...
                </div>
              ) : null}

              {previewError && ingestion?.status !== 'pending' ? (
                <div className="text-muted-foreground text-xs">
                  Preview unavailable
                  {hostname ? ` • ${hostname}` : ''}
                </div>
              ) : null}

              {!previewLoading && !previewError && preview ? (
                <div className="border-border flex h-full w-full flex-col overflow-hidden rounded-md border bg-white">
                  {/* Priority 2: image — visually above title, but shrinks first */}
                  {preview.image ? (
                    <img
                      src={preview.image}
                      alt=""
                      className="w-full shrink object-cover"
                      style={{ minHeight: 0 }}
                      loading="lazy"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  ) : null}

                  {/* Priority 1: favicon + site name + title — always visible */}
                  <div className="flex min-w-0 shrink-0 flex-col gap-1 p-2">
                    <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs font-medium">
                      {preview.favicon ? (
                        <img
                          src={preview.favicon}
                          alt=""
                          className="h-3.5 w-3.5 flex-none rounded-sm"
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none';
                          }}
                        />
                      ) : null}
                      <span className="truncate">
                        {(preview.siteName ?? '').trim() ||
                          hostname ||
                          'Website'}
                      </span>
                    </div>

                    <div className="text-main min-w-0 truncate text-xs font-medium">
                      {preview.title || src}
                    </div>
                  </div>

                  {/* Priority 3: content html — fills remaining space, hidden when height is tight */}
                  {preview.contentHtml ? (
                    <div className="min-h-0 flex-1 overflow-hidden px-2 pb-2">
                      <div
                        className="text-muted-foreground prose prose-xs overflow-hidden text-xs leading-relaxed [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:text-xs [&_h2]:font-semibold [&_h3]:text-xs [&_h3]:font-medium [&_img]:max-w-full [&_img]:rounded [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1"
                        dangerouslySetInnerHTML={{
                          __html: preview.contentHtml,
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="text-muted-foreground flex h-full w-full items-center justify-center text-sm">
              Invalid URL
            </div>
          )}
        </div>
      </div>
    </NodeWrapper>
  );
};
