// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { clsx } from 'clsx';
import { Download, Fullscreen } from 'lucide-react';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveAccent } from '@huabu/shared';

import { resolveArtifactUrl } from '@/api/artifact';
import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { OFFICE_FORMAT_ICON } from '@/config/nodeIcons';
import { useNodeScale } from '@/hooks/useNodeScale';
import useCanvasStore from '@/store/canvasStore';
import { openPreviewNode } from '@/store/previewWorkspace/actions';

import { getAccentTokens } from '../accentTokens';
import { getMissingFileKind, MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper';

import type { CanvasOfficeNodeData } from '../types';
import type { OfficeFormat } from '@huabu/shared';
import type { Node, NodeProps } from '@xyflow/react';
import type { LucideIcon } from 'lucide-react';

export type OfficeNodeType = Node<CanvasOfficeNodeData, 'office'>;

interface FormatMeta {
  /** Lucide icon used on the canvas card + floating toolbar. */
  icon: LucideIcon;
  /** Short human label rendered under the icon when no title is set. */
  label: string;
  /** Default download filename when `data.label` is missing. */
  fallbackName: string;
  /** Default file extension for the download link. */
  ext: string;
}

// The `icon` field is sourced from {@link OFFICE_FORMAT_ICON} so the
// canvas card and every other surface that calls `getNodeIcon('office',
// data)` (layer panel sidebar, expanded preview breadcrumb, …) resolve
// to the same Lucide component. The label / fallbackName / ext pieces
// are UI-text specifics that only this card uses, so they stay local.
const FORMAT_META: Record<OfficeFormat, FormatMeta> = {
  docx: {
    icon: OFFICE_FORMAT_ICON.docx,
    label: 'Word',
    fallbackName: 'document.docx',
    ext: '.docx',
  },
  pptx: {
    icon: OFFICE_FORMAT_ICON.pptx,
    label: 'PowerPoint',
    fallbackName: 'presentation.pptx',
    ext: '.pptx',
  },
  xlsx: {
    icon: OFFICE_FORMAT_ICON.xlsx,
    label: 'Excel',
    fallbackName: 'workbook.xlsx',
    ext: '.xlsx',
  },
};

function getFormatMeta(format: OfficeFormat | undefined): FormatMeta {
  return FORMAT_META[format ?? 'docx'] ?? FORMAT_META.docx;
}

/**
 * Office node (Word / PowerPoint / Excel).
 *
 * The canvas card is text-only by design: we render a large
 * format-specific icon over an accent-tinted background plus the file
 * label and AI-generated summary. The full extracted markdown body
 * lives behind the expand button and is rendered by `OfficePreview`.
 */
export const OfficeNode = memo(
  ({ id, data, selected }: NodeProps<OfficeNodeType>) => {
    const { t } = useTranslation();
    const scale = useNodeScale(id, 'office');
    const canvasId = useCanvasStore((s) => s.canvasId);

    const src = typeof data.src === 'string' ? data.src : '';
    const missingFileKind = getMissingFileKind(data);
    const summary =
      typeof (data as { summary?: unknown }).summary === 'string'
        ? ((data as { summary?: string }).summary as string)
        : '';

    const format = (data.format as OfficeFormat | undefined) ?? 'docx';
    const meta = getFormatMeta(format);
    const FormatIcon = meta.icon;

    // Accent tokens — mirror PreviewCard so the office card sits
    // visually consistent next to the rest of the node types.
    const resolvedAccent = resolveAccent(data.style?.accent ?? null);
    const accentTokens = resolvedAccent
      ? getAccentTokens(resolvedAccent)
      : null;
    const coverBg = accentTokens?.softBg ?? 'var(--surface)';
    const iconColor = accentTokens?.fg ?? 'var(--fg-muted)';
    const borderColor = accentTokens?.divider ?? 'var(--edge-default)';

    const handleDownload = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!src) return;
        const link = document.createElement('a');
        link.href = resolveArtifactUrl(src, canvasId);
        link.download =
          (data.label as string) || src.split('/').pop() || meta.fallbackName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      },
      [src, data.label, canvasId, meta.fallbackName],
    );

    const OfficeActions = (
      <>
        <FloatingToolbar.ActionButton
          title={t('node.openLargeView')}
          onClick={(e) => {
            e.stopPropagation();
            openPreviewNode(id);
          }}
        >
          <Fullscreen />
        </FloatingToolbar.ActionButton>
        <FloatingToolbar.ActionButton
          title={t('node.download')}
          onClick={handleDownload}
        >
          <Download />
        </FloatingToolbar.ActionButton>
      </>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'office'}
        selected={selected}
        actions={missingFileKind ? undefined : OfficeActions}
        resizable
        keepAspectRatio={false}
        className={clsx(
          !missingFileKind && 'bg-surface',
          'transition-all duration-300 ease-in-out',
        )}
      >
        {missingFileKind ? (
          <MissingFileBanner nodeId={id} />
        ) : (
          <div className="relative flex h-full w-full flex-col overflow-hidden rounded-lg">
            <div
              style={{
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                width: `${100 / scale}%`,
                height: `${100 / scale}%`,
              }}
            >
              {src ? (
                <div className="bg-surface relative flex h-full w-full flex-col overflow-hidden">
                  {/* Cover area: large centered format icon over an
                    accent-tinted background. Acts as the visual
                    counterpart to PreviewCard's image slot for nodes
                    that don't have a render-time thumbnail. */}
                  <div
                    className="flex min-h-0 flex-1 items-center justify-center"
                    style={{ background: coverBg }}
                  >
                    <div
                      className="flex flex-col items-center gap-2"
                      style={{ color: iconColor }}
                    >
                      <FormatIcon
                        size={72}
                        strokeWidth={1.4}
                        aria-hidden="true"
                      />
                      <span className="text-fg-muted text-xs font-medium tracking-wide uppercase">
                        {meta.label}
                      </span>
                    </div>
                  </div>

                  {/* Info footer mirrors PreviewCard's layout. */}
                  <div
                    className="flex flex-col px-4 pt-2 pb-2"
                    style={{
                      borderTop: `2px solid ${borderColor}`,
                      background: accentTokens?.softBg ?? 'transparent',
                    }}
                  >
                    <div className="min-w-0 shrink-0">
                      <div
                        className="float-left mr-2 flex translate-y-1.75 items-center"
                        style={{ color: iconColor }}
                      >
                        <FormatIcon size={16} />
                      </div>
                      <span
                        className="min-w-0 text-lg font-medium wrap-break-word"
                        style={{ color: iconColor }}
                      >
                        {(data.label as string) ||
                          t('node.untitledTypedDocument', {
                            label: meta.label,
                          })}
                      </span>
                    </div>
                    {summary ? (
                      <p className="text-fg-muted mt-1 line-clamp-5 text-base leading-relaxed">
                        {summary}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="text-fg-subtle flex h-full w-full items-center justify-center text-sm">
                  {t('node.noOfficeSource')}
                </div>
              )}
            </div>
          </div>
        )}
      </NodeWrapper>
    );
  },
);
