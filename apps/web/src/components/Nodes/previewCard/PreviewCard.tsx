// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useStore } from '@xyflow/react';
import { memo, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getNodeDefaultSize } from '@huabu/shared/canvas-engine';

import { Button } from '@/components/Common/Button';
import { Loading } from '@/components/Common/Loading';
import { SummaryContent } from '@/components/Common/SummaryContent';
import { getNodeIcon } from '@/config/nodeIcons';
import { resolveFarLabelLayout } from '@/config/semanticZoom';
import { handleCanvasNavigationKey } from '@/hooks/shortcuts/handleCanvasNavigationKey';

import {
  allocateCardLines,
  cardTextHeight,
  CARD_COVER_SHARE,
  CARD_MEASURED_TAGS,
  CARD_TAG_ROWS,
  CARD_TEXT_LINES,
  CARD_TITLE_LINES,
  visibleTagCount,
  tagRowsNeeded,
} from './previewCardBudget';
import { previewCardMetricsForSize } from './previewCardDesign';
import { FAR_ZOOM_DESIGN } from '../design/farZoomDesign';
import { nodeAccentToken } from '../design/nodeAccentPolicy';
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

export interface CardProperty {
  name: string;
  value: string;
}

/** Measured line counts for the budgeted PDF text area. */
interface CardLines {
  titleLines: number;
  tagRows: number;
  visibleTags: number;
  textLines: number[];
  summaryLines: number;
  /** Height the shown blocks occupy, in px. */
  textHeight: number;
}

/**
 * An element's border-box width with its fraction. `offsetWidth` rounds, and
 * half a pixel decides whether a line or a tag wraps; bounding rects would
 * include the canvas zoom transform.
 */
function layoutWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const width = parseFloat(style.width);
  if (!(width > 0)) return element.offsetWidth;
  if (style.boxSizing === 'border-box') return width;
  return (
    width +
    (parseFloat(style.paddingLeft) || 0) +
    (parseFloat(style.paddingRight) || 0) +
    (parseFloat(style.borderLeftWidth) || 0) +
    (parseFloat(style.borderRightWidth) || 0)
  );
}

function sameLines(a: CardLines | null, b: CardLines): boolean {
  return (
    !!a &&
    a.titleLines === b.titleLines &&
    a.tagRows === b.tagRows &&
    a.visibleTags === b.visibleTags &&
    a.summaryLines === b.summaryLines &&
    a.textHeight === b.textHeight &&
    a.textLines.length === b.textLines.length &&
    a.textLines.every((lines, index) => lines === b.textLines[index])
  );
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
  /** Short categorical values, shown as one row of tags (PDF cards). */
  tags?: CardProperty[];
  /** Prose values, each on its own lines below the tags (PDF cards). */
  texts?: CardProperty[];
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
  tags,
  texts,
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
  const measureRef = useRef<HTMLDivElement>(null);
  const [measuredLines, setMeasuredLines] = useState<CardLines | null>(null);
  const baseMetrics = previewCardMetricsForSize(width, height);
  const far = farZoom !== undefined;
  const scale = farZoom ?? 1;
  const horizontal = !textOnly && baseMetrics.horizontal;
  const farLayout = far
    ? resolveFarLabelLayout(
        Math.max(
          0,
          width -
            2 * NODE_BORDER_WIDTH -
            (horizontal
              ? baseMetrics.imageWidth + baseMetrics.imageTextGap
              : 0),
        ) * scale,
        Math.max(
          0,
          height -
            2 * NODE_BORDER_WIDTH -
            (!textOnly && !horizontal
              ? baseMetrics.verticalCoverMinHeight + NODE_BORDER_WIDTH
              : 0),
        ) * scale,
      )
    : undefined;
  // Keep the cover orientation and scale; far text insets use Note's screen-space fit.
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
  // PDF cards at reading zoom divide a fixed text area by priority; see
  // previewCardBudget. Far zoom and other node types keep the flow layout.
  const budgeted = nodeType === 'pdf' && !far;
  const tagList = budgeted ? (tags ?? []) : [];
  const textList = budgeted ? (texts ?? []) : [];
  const tagChipGap = metrics.gap / 2;
  // One optical rhythm between blocks. Text lines carry half a line's
  // leading above and below their glyphs and tag chips carry none, so text
  // blocks sit that much closer and the tag row trails that much extra:
  // every visible gap then equals the card gap.
  const halfLeading = (metrics.descriptionLine - metrics.description) / 2;
  const textGap = Math.max(0, metrics.gap - halfLeading);
  const tagTrail = halfLeading;
  // Consecutive text properties read as one group: no extra space beyond
  // their own leading.
  const textInnerGap = 0;
  const lines: CardLines =
    measuredLines &&
    measuredLines.textLines.length === textList.length &&
    measuredLines.visibleTags <= tagList.length
      ? measuredLines
      : {
          // Before the first measurement, show each block's guaranteed share.
          titleLines: CARD_TITLE_LINES,
          tagRows: tagList.length ? CARD_TAG_ROWS : 0,
          visibleTags: Math.min(tagList.length, CARD_MEASURED_TAGS),
          textLines: textList.map((_, index) =>
            textList.length === 1
              ? CARD_TEXT_LINES
              : index < CARD_TEXT_LINES
                ? 1
                : 0,
          ),
          summaryLines: fitSummaryToHeight ? 6 : 2,
          textHeight: Infinity,
        };
  // A vertical cover keeps at least its share; the text area is budgeted
  // against the rest and hands back what it does not use.
  const verticalBody = baseMetrics.innerHeight - baseMetrics.imageTextGap;
  const minCoverHeight = Math.min(
    Math.max(
      baseMetrics.innerHeight * CARD_COVER_SHARE,
      baseMetrics.verticalCoverMinHeight,
    ),
    Math.max(0, verticalBody - baseMetrics.titleLine),
  );
  const coverHeight = Math.max(minCoverHeight, verticalBody - lines.textHeight);
  const verticalBudget = budgeted && !textOnly && !horizontal;

  useLayoutEffect(() => {
    const info = infoRef.current;
    const measurer = measureRef.current;
    if (!budgeted || !info) return;
    let active = true;
    const run = () => {
      if (!active || !info.clientHeight) return;
      const infoStyle = getComputedStyle(info);
      // Vertical cards budget against the cover's minimum, not the live text
      // area, whose height depends on the result.
      let available = verticalBudget
        ? verticalBody - minCoverHeight
        : info.clientHeight -
          (parseFloat(infoStyle.paddingTop) || 0) -
          (parseFloat(infoStyle.paddingBottom) || 0);
      let errorHeight = 0;
      const errorRow = info.querySelector<HTMLElement>('.preview-card__error');
      if (errorRow) {
        const errorStyle = getComputedStyle(errorRow);
        errorHeight =
          errorRow.offsetHeight + (parseFloat(errorStyle.marginTop) || 0);
        available -= errorHeight;
      }
      // Layout width with its fraction: `clientWidth` rounds, and half a
      // pixel decides whether a line wraps. (Bounding rects would include
      // the canvas zoom transform.)
      const inlinePadding =
        (parseFloat(infoStyle.paddingLeft) || 0) +
        (parseFloat(infoStyle.paddingRight) || 0);
      const styledWidth = parseFloat(infoStyle.width);
      const rowWidth = Math.max(
        0,
        styledWidth > 0
          ? styledWidth -
              (infoStyle.boxSizing === 'border-box' ? inlinePadding : 0)
          : info.clientWidth - inlinePadding,
      );
      // The copies wrap exactly as the text area does.
      if (measurer) measurer.style.width = `${rowWidth}px`;
      const needed = (selector: string) =>
        Array.from(measurer?.querySelectorAll<HTMLElement>(selector) ?? []).map(
          (element) =>
            Math.max(
              1,
              Math.round(element.offsetHeight / metrics.descriptionLine),
            ),
        );
      // Rounded up a hair: a tag judged to fit that then wraps is clipped
      // with no marker to say so, while one judged not to fit only joins it.
      const widths = Array.from(
        measurer?.querySelectorAll<HTMLElement>('[data-measure="tag"]') ?? [],
      ).map((element) => layoutWidth(element) + 0.05);
      const more = measurer?.querySelector<HTMLElement>(
        '[data-measure="more"]',
      );
      const moreWidth = more ? layoutWidth(more) + 0.05 : 0;
      // A clamped heading still reports its full height.
      const heading = titleRef.current;
      const titleNeed = heading
        ? Math.max(1, Math.round(heading.scrollHeight / metrics.titleLine))
        : 0;
      const sizes = {
        titleLine: metrics.titleLine,
        textLine: metrics.descriptionLine,
        tagRow: metrics.descriptionLine,
        tagRowGap: tagChipGap,
        // The row's trailing space is part of what showing tags costs.
        tagGap: metrics.gap + tagTrail,
        textGap,
        textInnerGap,
        // The excerpt's rule spans its whole line box, so like a tag chip it
        // is spaced by its box rather than its glyphs.
        summaryGap: metrics.gap,
      };
      const budget = allocateCardLines({
        ...sizes,
        available,
        titleNeed,
        tagRowsNeed: tagRowsNeeded(widths, rowWidth, tagChipGap),
        textNeeds: needed('[data-measure="text"]'),
        summaryNeed: needed('[data-measure="summary"]')[0] ?? 0,
      });
      const next = {
        ...budget,
        textHeight: cardTextHeight(sizes, budget) + errorHeight,
        visibleTags: visibleTagCount(
          widths,
          rowWidth,
          tagChipGap,
          budget.tagRows,
          moreWidth,
          tagList.length > widths.length,
        ),
      };
      setMeasuredLines((previous) =>
        sameLines(previous, next) ? previous : next,
      );
    };
    run();
    const observer = new ResizeObserver(run);
    observer.observe(info);
    if (titleRef.current) observer.observe(titleRef.current);
    for (const child of Array.from(
      measurer?.querySelectorAll('[data-measure]') ?? [],
    ))
      observer.observe(child);
    document.fonts?.addEventListener('loadingdone', run);
    void document.fonts?.ready.then(run);
    return () => {
      active = false;
      observer.disconnect();
      document.fonts?.removeEventListener('loadingdone', run);
    };
  }, [
    budgeted,
    tags,
    texts,
    summary,
    title,
    source,
    failed,
    textOnly,
    width,
    height,
    verticalBudget,
    verticalBody,
    minCoverHeight,
    metrics.titleLine,
    metrics.descriptionLine,
    metrics.gap,
    tagChipGap,
    textGap,
    tagTrail,
  ]);

  useLayoutEffect(() => {
    const info = infoRef.current;
    const card = info?.parentElement;
    if (budgeted) {
      // The far layout hides a heading it has no line for by writing to the
      // element. The budget sizes the heading through React, so that write
      // would otherwise outlive the zoom back in and keep the title hidden.
      if (titleRef.current) titleRef.current.style.maxHeight = '';
      return;
    }
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
    budgeted,
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

  const resolvedAccent = nodeAccentToken(nodeType, accent);
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
    '--card-padding-inline': farLayout
      ? `${farLayout.horizontalInset}px`
      : undefined,
    '--card-padding-block': farLayout
      ? `${farLayout.verticalInset}px`
      : undefined,
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
    '--card-cover-height': `${coverHeight}px`,
    '--card-tag-gap': `${tagChipGap}px`,
    '--card-text-gap': `${textGap}px`,
    '--card-tag-trail': `${tagTrail}px`,
    '--card-text-inner-gap': `${textInnerGap}px`,
    '--card-summary-lines': budgeted
      ? lines.summaryLines
      : fitSummaryToHeight
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
      data-budget={budgeted || undefined}
      data-node-type={nodeType}
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
              <h3
                ref={titleRef}
                className="preview-card__title"
                style={
                  budgeted
                    ? ({
                        '--card-title-lines': lines.titleLines,
                      } as CSSProperties)
                    : undefined
                }
              >
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
        {lines.tagRows > 0 && tagList.length > 0 ? (
          <div
            className="preview-card__tags"
            style={{
              maxHeight:
                lines.tagRows * metrics.descriptionLine +
                (lines.tagRows - 1) * tagChipGap,
            }}
          >
            {tagList.slice(0, lines.visibleTags).map(({ name, value }) => (
              <span
                key={`${name}\0${value}`}
                className="preview-card__tag"
                title={name === value ? name : `${name}: ${value}`}
              >
                {value}
              </span>
            ))}
            {lines.visibleTags < tagList.length ? (
              <span
                className="preview-card__tag text-fg-muted"
                title={tagList
                  .slice(lines.visibleTags)
                  .map(({ value }) => value)
                  .join(', ')}
              >
                +{tagList.length - lines.visibleTags}
              </span>
            ) : null}
          </div>
        ) : null}
        {textList.map(({ name, value }, index) =>
          lines.textLines[index] > 0 ? (
            <p
              key={name}
              className="preview-card__text"
              title={`${name}: ${value}`}
              style={
                { '--card-text-lines': lines.textLines[index] } as CSSProperties
              }
            >
              {value}
            </p>
          ) : null,
        )}
        {summary?.trim() ? (
          <div
            className="preview-card__summary text-fg-muted"
            style={
              (
                budgeted
                  ? lines.summaryLines === 0
                  : !titleFits || summaryLines < minSummaryLines
              )
                ? { display: 'none' }
                : undefined
            }
          >
            <SummaryContent summary={summary} compact={far} />
          </div>
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
      {budgeted && (tagList.length || textList.length || summary?.trim()) ? (
        // Unclamped copies at the text area's width: what each block needs in
        // full, independent of what the budget currently shows.
        <div ref={measureRef} className="preview-card__measure" aria-hidden>
          <div className="preview-card__measure-tags">
            {tagList.slice(0, CARD_MEASURED_TAGS).map(({ name, value }) => (
              <span
                key={`${name}\0${value}`}
                className="preview-card__measure-tag"
                data-measure="tag"
              >
                {value}
              </span>
            ))}
            <span className="preview-card__measure-tag" data-measure="more">
              +{tagList.length}
            </span>
          </div>
          {textList.map(({ name, value }) => (
            <p key={name} data-measure="text">
              {value}
            </p>
          ))}
          {summary?.trim() ? (
            <div data-measure="summary">
              <SummaryContent summary={summary} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
