// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useStore } from '@xyflow/react';
import { memo, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getNodeDefaultSize } from '@huabu/shared/canvas-engine';

import { Button } from '@/components/Common/Button';
import { Loading } from '@/components/Common/Loading';
import { getNodeIcon } from '@/config/nodeIcons';
import { handleCanvasNavigationKey } from '@/hooks/shortcuts/handleCanvasNavigationKey';

import { previewCardMetricsForSize } from './previewCardDesign';
import { FAR_ZOOM_DESIGN } from '../design/farZoomDesign';
import { resolveNodeAccent } from '../design/nodeAccentPolicy';
import { NODE_BORDER_WIDTH } from '../design/nodeBoundary';
import { NODE_TYPOGRAPHY } from '../design/nodeTypography';
import { noteSurfaceStyle } from '../note/noteDesign';

import type { CSSProperties } from 'react';

import './PreviewCard.css';

/** Match the shell's live canvas geometry during resize, before props settle. */
export function usePreviewCardSize(
  id: string,
  nodeType: 'pdf' | 'web',
  width?: number,
  height?: number,
) {
  const defaults = getNodeDefaultSize(nodeType);
  const liveWidth = useStore((state) => {
    const node = state.nodeLookup.get(id);
    return (
      (node?.style?.width as number) ||
      node?.measured?.width ||
      width ||
      defaults.width
    );
  });
  const liveHeight = useStore((state) => {
    const node = state.nodeLookup.get(id);
    return (
      (node?.style?.height as number) ||
      node?.measured?.height ||
      height ||
      defaults.height ||
      0
    );
  });
  return { width: liveWidth, height: liveHeight };
}

/** Shared, canvas-space cover and information layout for PDF and Web nodes. */
export interface PreviewCardProps {
  width: number;
  height: number;
  image?: string;
  imageAlt?: string;
  /** Covers fill their region; generated document pages stay fully visible. */
  imageFit?: 'cover' | 'contain';
  nodeType: string;
  favicon?: string;
  source: string;
  title: string;
  /** Tint information and its surrounding padding, never the media surface. */
  accent?: string | null;
  summary?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Lay out in screen pixels and counter-scale the card, not its font metrics. */
  farZoom?: number;
}

/** Only the far card subscribes to continuous zoom; node owners stay derived. */
export const ViewportPreviewCard = memo(function ViewportPreviewCard({
  minimal,
  ...props
}: PreviewCardProps & { minimal: boolean }) {
  const zoom = useStore((state) => (minimal ? state.transform[2] : 1));
  return <PreviewCard {...props} farZoom={minimal ? zoom : undefined} />;
});

export function PreviewMark({
  favicon,
  nodeType,
  size,
}: {
  favicon?: string;
  nodeType: string;
  size: number;
}) {
  const [failed, setFailed] = useState(false);
  const NodeTypeIcon = getNodeIcon(nodeType);
  return favicon && !failed ? (
    <img
      src={favicon}
      alt=""
      width={size}
      height={size}
      className="shrink-0 object-contain"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  ) : (
    <NodeTypeIcon size={size} className="shrink-0" aria-hidden />
  );
}

export function PreviewCard(props: PreviewCardProps) {
  return (
    <PreviewCardContent
      key={`${props.image ?? ''}\0${props.source}`}
      {...props}
    />
  );
}

function PreviewCardContent({
  width,
  height,
  image,
  imageAlt = '',
  imageFit = 'cover',
  nodeType,
  favicon,
  source,
  title,
  accent,
  summary,
  loading = false,
  error,
  onRetry,
  farZoom,
}: PreviewCardProps) {
  const { t } = useTranslation();
  const [imageState, setImageState] = useState<'loading' | 'loaded' | 'failed'>(
    'loading',
  );
  const [attempt, setAttempt] = useState(0);
  const failed = imageState === 'failed' || !!error;
  const textOnly = failed || (!image && !loading);
  const busy = !failed && (image ? imageState === 'loading' : loading);
  const infoRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [titleFits, setTitleFits] = useState(true);
  const [summaryLines, setSummaryLines] = useState(6);
  const baseMetrics = previewCardMetricsForSize(width, height);
  const far = farZoom !== undefined;
  const scale = farZoom ?? 1;
  // Preserve authored orientation and proportional media/spacing. Only far
  // typography uses screen units, shared with the Note label.
  const metrics = {
    ...baseMetrics,
    padding: baseMetrics.padding * scale,
    imageTextGap: baseMetrics.imageTextGap * scale,
    imageWidth: baseMetrics.imageWidth * scale,
    gap: baseMetrics.gap * scale,
    badgePadding: baseMetrics.badgePadding * scale,
    mark: baseMetrics.mark * scale,
    meta: baseMetrics.meta * scale,
    metaLine: baseMetrics.metaLine * scale,
    title: far ? FAR_ZOOM_DESIGN.labelFont : baseMetrics.title,
    titleLine: far ? FAR_ZOOM_DESIGN.labelLine : baseMetrics.titleLine,
    description: far
      ? FAR_ZOOM_DESIGN.descriptionFont
      : baseMetrics.description,
    descriptionLine: far
      ? FAR_ZOOM_DESIGN.descriptionLine
      : baseMetrics.descriptionLine,
    descriptionGap: far
      ? FAR_ZOOM_DESIGN.descriptionGap
      : baseMetrics.descriptionGap,
  };
  const fitSummaryToHeight = textOnly || metrics.horizontal;
  const maxSummaryLines = textOnly ? 6 : Infinity;
  const minSummaryLines = far ? FAR_ZOOM_DESIGN.descriptionMinLines : 1;

  useLayoutEffect(() => {
    const info = infoRef.current;
    const card = info?.parentElement;
    if (!info || !card) return;
    const coverBudget =
      far && !fitSummaryToHeight
        ? baseMetrics.verticalCoverMinHeight * scale
        : 0;
    let active = true;
    const measure = () => {
      if (!active || !info.clientHeight) return;
      const heading = titleRef.current;
      if (heading) {
        if (far || (!textOnly && metrics.horizontal)) {
          // Allocate the title before measuring the summary, independently of
          // the previous clamp or whether the summary is currently visible.
          const infoStyle = getComputedStyle(info);
          const headingStyle = getComputedStyle(heading);
          let titleHeight =
            (fitSummaryToHeight ? info.clientHeight : card.clientHeight) -
            coverBudget -
            (parseFloat(infoStyle.paddingTop) || 0) -
            (parseFloat(infoStyle.paddingBottom) || 0) -
            (parseFloat(infoStyle.borderTopWidth) || 0) -
            (parseFloat(headingStyle.marginTop) || 0) -
            (parseFloat(headingStyle.marginBottom) || 0);
          for (const child of Array.from(info.children)) {
            if (
              !(child instanceof HTMLElement) ||
              child === heading ||
              child.contains(heading) ||
              child.classList.contains('preview-card__summary')
            )
              continue;
            const childStyle = getComputedStyle(child);
            titleHeight -=
              child.offsetHeight +
              (parseFloat(childStyle.marginTop) || 0) +
              (parseFloat(childStyle.marginBottom) || 0);
          }
          const lines = Math.max(
            0,
            Math.floor(titleHeight / metrics.titleLine),
          );
          heading.style.setProperty(
            '--card-title-lines',
            String(Math.max(1, lines)),
          );
          heading.style.maxHeight = lines === 0 ? '0px' : '';
        } else {
          heading.style.removeProperty('--card-title-lines');
          heading.style.maxHeight = '';
        }
      }
      const headingRect = heading?.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      setTitleFits(
        !heading ||
          (heading.scrollHeight <= heading.clientHeight + 1 &&
            heading.scrollWidth <= heading.clientWidth + 1 &&
            (!headingRect || headingRect.bottom <= cardRect.bottom + 1)),
      );
      const style = getComputedStyle(info);
      let available =
        (fitSummaryToHeight ? info.clientHeight : card.clientHeight) -
        (parseFloat(style.paddingTop) || 0) -
        (parseFloat(style.paddingBottom) || 0) -
        metrics.descriptionGap -
        coverBudget;
      for (const child of Array.from(info.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (child.classList.contains('preview-card__summary')) continue;
        const childStyle = getComputedStyle(child);
        available -=
          (parseFloat(childStyle.marginTop) || 0) +
          (parseFloat(childStyle.marginBottom) || 0) +
          child.offsetHeight;
      }
      setSummaryLines(
        Math.max(
          0,
          Math.min(
            fitSummaryToHeight ? maxSummaryLines : 2,
            Math.floor(available / metrics.descriptionLine),
          ),
        ),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(info);
    observer.observe(card);
    if (titleRef.current) observer.observe(titleRef.current);
    for (const child of Array.from(info.children)) {
      if (!child.classList.contains('preview-card__summary'))
        observer.observe(child);
    }
    document.fonts?.addEventListener('loadingdone', measure);
    void document.fonts?.ready.then(measure);
    return () => {
      active = false;
      observer.disconnect();
      document.fonts?.removeEventListener('loadingdone', measure);
    };
  }, [
    fitSummaryToHeight,
    maxSummaryLines,
    summary,
    title,
    source,
    nodeType,
    failed,
    width,
    height,
    metrics.descriptionLine,
    metrics.descriptionGap,
    metrics.horizontal,
    metrics.titleLine,
    textOnly,
    far,
    baseMetrics.verticalCoverMinHeight,
    scale,
  ]);

  const resolvedAccent = resolveNodeAccent(nodeType, accent);
  const style = {
    ...(resolvedAccent ? noteSurfaceStyle(resolvedAccent) : {}),
    ...(far
      ? {
          width: `${scale * 100}%`,
          height: `${scale * 100}%`,
          transform: `scale(${1 / scale})`,
          transformOrigin: 'top left',
        }
      : {}),
    '--card-view-radius': `calc(var(--node-inner-radius, ${metrics.radius - NODE_BORDER_WIDTH}px) * ${scale})`,
    '--card-inner-radius': `${metrics.radius - NODE_BORDER_WIDTH}px`,
    '--card-padding': `${metrics.padding}px`,
    '--card-image-text-gap': `${metrics.imageTextGap}px`,
    '--card-badge-padding': `${metrics.badgePadding}px`,
    '--card-gap': `${metrics.gap}px`,
    '--card-title-gap': `${far && nodeType === 'web' ? 0 : metrics.gap}px`,
    '--card-description-gap': `${metrics.descriptionGap}px`,
    '--card-title': `${metrics.title}px`,
    '--card-title-weight': `${far ? FAR_ZOOM_DESIGN.labelWeight : NODE_TYPOGRAPHY.cardTitle.weight}`,
    '--card-title-line': `${metrics.titleLine}px`,
    '--card-description': `${metrics.description}px`,
    '--card-description-line': `${metrics.descriptionLine}px`,
    '--card-meta': `${metrics.meta}px`,
    '--card-meta-line': `${metrics.metaLine}px`,
    '--card-image-radius': `${metrics.radius * 0.65 * scale}px`,
    '--card-divider-width': `${scale}px`,
    '--card-image-width': `${metrics.imageWidth}px`,
    '--card-summary-lines': fitSummaryToHeight
      ? summaryLines
      : Math.min(2, summaryLines),
  } as CSSProperties;
  const pdfLabel =
    nodeType === 'pdf' ? (
      <span
        className={`preview-card__metadata preview-card__type-label ${
          textOnly
            ? 'bg-bg-default text-fg-muted'
            : 'bg-inverse text-fg-inverse border-fg-inverse/25 border'
        }`}
      >
        {source}
      </span>
    ) : null;

  return (
    <div
      className="preview-card bg-surface text-fg-default"
      data-far={far || undefined}
      data-tier={metrics.tier}
      data-orientation={
        textOnly ? 'text' : metrics.horizontal ? 'horizontal' : 'vertical'
      }
      style={style}
    >
      {!textOnly ? (
        <div
          className={`preview-card__cover ${!image || (nodeType === 'pdf' && imageFit === 'contain') ? 'bg-bg-default' : 'bg-surface'}`}
        >
          {image ? (
            <img
              key={attempt}
              src={image}
              alt={imageAlt}
              className="preview-card__image"
              data-fit={imageFit}
              loading="lazy"
              decoding="async"
              draggable={false}
              onLoad={() => setImageState('loaded')}
              onError={() => setImageState('failed')}
            />
          ) : null}
          {busy ? (
            <div role="status" aria-label={t('status.loading')}>
              <Loading layout="overlay" variant="skeleton" />
            </div>
          ) : null}
          {pdfLabel ? (
            <div className="preview-card__cover-label">{pdfLabel}</div>
          ) : null}
        </div>
      ) : null}
      <div className="preview-card__info" ref={infoRef}>
        {nodeType === 'pdf' ? (
          <div className="preview-card__heading">
            {textOnly ? pdfLabel : null}
            {title ? (
              <h3 ref={titleRef} className="preview-card__title">
                {title}
              </h3>
            ) : null}
          </div>
        ) : (
          <>
            {!far || nodeType !== 'web' ? (
              <div className="preview-card__metadata text-fg-muted">
                <PreviewMark
                  key={favicon}
                  favicon={favicon}
                  nodeType={nodeType}
                  size={metrics.mark}
                />
                <span className="truncate">{source}</span>
              </div>
            ) : null}
            {title ? (
              <h3 ref={titleRef} className="preview-card__title">
                {title}
              </h3>
            ) : null}
          </>
        )}
        {summary?.trim() ? (
          <p
            className="preview-card__summary text-fg-muted"
            style={
              !titleFits || summaryLines < minSummaryLines
                ? { display: 'none' }
                : undefined
            }
          >
            {summary}
          </p>
        ) : null}
        {failed ? (
          <div
            className="preview-card__error text-fg-subtle"
            title={error || t('node.previewFailed')}
          >
            <span role="status">{t('node.previewFailed')}</span>
            {(error ? !!onRetry : imageState === 'failed') ? (
              <Button
                variant="ghost"
                size="sm"
                className="nodrag nopan shrink-0"
                onKeyDown={handleCanvasNavigationKey}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  if (error) onRetry?.();
                  else {
                    setImageState('loading');
                    setAttempt((value) => value + 1);
                  }
                }}
              >
                {t('messages.retry')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
