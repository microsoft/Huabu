// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useInternalNode, useStore, ViewportPortal } from '@xyflow/react';
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { getNodeSize } from '@huabu/shared/canvas-engine';

import { frameSurfaceStyle, frameVisualMetricsForSize } from './frameDesign';
import { farFrameRegionPresentation, frameRegionContentBox } from './frameZoom';
import { useFrameRegionVisible, useFrameRegionZ } from './FrameZoomContext';
import { getAccentTokens, isWhiteAccent } from '../design/accentTokens';
import { FarZoomText } from '../semanticZoom/FarZoomText';
import { subscribeToFontChanges } from '../semanticZoom/fontObservation';

import type { FrameHeaderMetrics } from './frameHeaderMetrics';

const TITLE_BADGE_GAP = 3;

function contentCenterOffset(
  content: HTMLElement,
  width: number,
  ellipsisWidth: number,
) {
  const bounds = content.getBoundingClientRect();
  if (bounds.width <= 0) return 0;
  const title = content.querySelector<HTMLElement>('[data-frame-region-title]');
  const badge = content.querySelector('[data-frame-region-count]');
  const rects: DOMRect[] = [];
  if (title) {
    const titleBounds = title.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(title);
    // Line-clamped ranges include hidden lines; only measure the visible ones.
    for (const rect of range.getClientRects()) {
      if (rect.bottom > titleBounds.top && rect.top < titleBounds.bottom)
        rects.push(rect);
    }
    // The final visible range fragment excludes the browser-painted ellipsis.
    const last = rects.at(-1);
    if (last && title.scrollHeight > title.clientHeight) {
      rects.push(
        new DOMRect(
          last.right,
          last.top,
          Math.max(0, Math.min(ellipsisWidth, titleBounds.right - last.right)),
          last.height,
        ),
      );
    }
  }
  if (badge) rects.push(badge.getBoundingClientRect());
  let left = bounds.right;
  let right = bounds.left;
  for (const rect of rects) {
    if (rect.width <= 0) continue;
    left = Math.min(left, Math.max(bounds.left, rect.left));
    right = Math.max(right, Math.min(bounds.right, rect.right));
  }
  return right > left
    ? ((bounds.left + bounds.right - left - right) / 2) * (width / bounds.width)
    : 0;
}

/** Fixed-screen glyph metrics, inverse-scaled only at the outer container. */
export function FrameRegionLabel({
  title,
  childCount,
  accent,
  zoom,
  layout,
  headerMetrics,
}: {
  title: string;
  childCount: number;
  accent: string | null;
  zoom: number;
  layout: ReturnType<typeof farFrameRegionPresentation>;
  headerMetrics: FrameHeaderMetrics;
}) {
  const box = frameRegionContentBox(
    layout.screenHeight,
    zoom,
    headerMetrics,
    layout.lineHeight,
  );
  const titleLines = Math.max(0, box.lines - 1);
  const colors =
    accent && !isWhiteAccent(accent) ? getAccentTokens(accent) : null;
  const probe = useRef<HTMLDivElement>(null);
  const ellipsis = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [inlineFits, setInlineFits] = useState(false);
  const [centerOffset, setCenterOffset] = useState(0);
  useLayoutEffect(() => {
    const element = probe.current;
    const visibleContent = content.current;
    const ellipsisElement = ellipsis.current;
    if (!element || !visibleContent || !ellipsisElement) return;
    const measure = () => {
      const text = element.firstElementChild;
      const badge = element.lastElementChild as HTMLElement | null;
      if (!text || !badge) return;
      const range = document.createRange();
      range.selectNodeContents(text);
      const fragments = [...range.getClientRects()].filter(
        (rect) => rect.width > 0,
      );
      const last = fragments.at(-1);
      // Glyph centers avoid rounding a transformed line-top into the previous line.
      const textLine = last
        ? Math.floor(
            (last.top + last.height / 2 - element.getBoundingClientRect().top) /
              layout.lineHeight,
          )
        : 0;
      setInlineFits(
        element.offsetHeight > 0 &&
          element.offsetHeight <= box.availableHeight &&
          Math.round(badge.offsetTop / layout.lineHeight) === textLine,
      );
      setCenterOffset(
        contentCenterOffset(
          visibleContent,
          box.availableWidth,
          ellipsisElement.getBoundingClientRect().width,
        ),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(visibleContent);
    const unsubscribeFonts = subscribeToFontChanges(measure);
    return () => {
      observer.disconnect();
      unsubscribeFonts();
    };
  }, [
    title,
    childCount,
    box.availableWidth,
    box.availableHeight,
    layout.lineHeight,
    inlineFits,
  ]);
  const countBadge = (measurement = false) => (
    <span
      data-frame-region-count={measurement ? undefined : ''}
      className="inline-flex shrink-0 items-center justify-center rounded-full align-top tabular-nums"
      style={{
        minWidth: 10,
        height: 10,
        lineHeight: '10px',
        marginBlock: (layout.lineHeight - 10) / 2,
        paddingInline: 2,
        boxSizing: 'border-box',
        fontSize: 7,
        color: colors?.fg ?? 'var(--fg-muted)',
        backgroundColor:
          colors?.highlightBg ??
          'color-mix(in srgb, var(--fg-default) 12%, var(--bg-hover))',
      }}
    >
      {childCount}
    </span>
  );
  return (
    <div
      data-frame-region-label=""
      className="text-fg-default pointer-events-none absolute overflow-hidden text-left"
      style={{
        left: '50%',
        top: headerMetrics.top,
        transform: `scale(${1 / zoom}) translateX(-50%)`,
        transformOrigin: 'top left',
        width: box.availableWidth,
        maxHeight: box.availableHeight,
        boxSizing: 'border-box',
        fontSize: layout.fontSize,
        lineHeight: `${layout.lineHeight}px`,
        fontWeight: 500,
      }}
    >
      <div
        ref={probe}
        aria-hidden="true"
        className="invisible absolute top-0 left-0 w-full"
        style={{ overflowWrap: 'anywhere' }}
      >
        <span>
          <FarZoomText text={title} />
        </span>
        <span
          className="inline-block align-top"
          style={{ marginLeft: TITLE_BADGE_GAP }}
        >
          {countBadge(true)}
        </span>
      </div>
      <span
        ref={ellipsis}
        data-frame-region-ellipsis=""
        aria-hidden="true"
        className="invisible absolute top-0 left-0"
      >
        {'\u2026'}
      </span>
      {inlineFits ? (
        <div
          ref={content}
          data-frame-region-inline=""
          style={{
            overflowWrap: 'anywhere',
            transform: `translateX(${centerOffset}px)`,
          }}
        >
          <span data-frame-region-title="">
            <FarZoomText text={title} />
          </span>
          <span
            className="inline-block align-top"
            style={{ marginLeft: TITLE_BADGE_GAP }}
          >
            {countBadge()}
          </span>
        </div>
      ) : (
        <div
          ref={content}
          className="flex flex-wrap items-start"
          style={{
            columnGap: TITLE_BADGE_GAP,
            transform: `translateX(${centerOffset}px)`,
          }}
        >
          <span className="inline-block max-w-full align-top">
            <span
              data-frame-region-title=""
              className="min-w-0 overflow-hidden"
              style={{
                display: titleLines > 0 ? '-webkit-box' : 'none',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: Math.max(1, titleLines),
                maxHeight: titleLines * layout.lineHeight,
                overflowWrap: 'anywhere',
                wordBreak: 'normal',
              }}
            >
              <FarZoomText text={title} />
            </span>
          </span>{' '}
          {countBadge()}
        </div>
      )}
    </div>
  );
}

/** Header lifecycle stays mounted; only a visible replacement hides it. */
export function FrameZoomHeader({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const visible = useFrameRegionVisible(id);
  return (
    <div
      data-frame-header=""
      className="pointer-events-none absolute inset-0"
      inert={visible || undefined}
      aria-hidden={visible || undefined}
      style={{ visibility: visible ? 'hidden' : undefined }}
    >
      {children}
    </div>
  );
}

/** Portal above sibling child shells, at this Frame's stacking level. */
export const FrameRegionOverlay = memo(function FrameRegionOverlay({
  id,
  title,
  childCount,
  accent,
  headerMetrics,
}: {
  id: string;
  title: string;
  childCount: number;
  accent: string | null;
  headerMetrics: FrameHeaderMetrics;
}) {
  const visible = useFrameRegionVisible(id);
  const zIndex = useFrameRegionZ(id);
  const node = useInternalNode(id);
  const zoom = useStore((state) => (visible ? state.transform[2] : 1));
  if (!visible || !node) return null;
  const size = getNodeSize(node);
  const position = node.internals.positionAbsolute;
  const layout = farFrameRegionPresentation(
    size.width * zoom,
    size.height * zoom,
    zoom,
    true,
    headerMetrics,
  );
  return (
    <ViewportPortal>
      <div
        data-frame-region-owner={id}
        className="pointer-events-none absolute"
        style={{
          left: position.x,
          top: position.y,
          width: size.width,
          height: size.height,
          zIndex,
        }}
      >
        <div
          data-frame-region-veil=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundColor: frameSurfaceStyle(accent).backgroundColor,
            borderRadius: frameVisualMetricsForSize(size.width, size.height)
              .borderRadius,
            opacity: 0.6,
          }}
        />
        <FrameRegionLabel
          title={title}
          childCount={childCount}
          accent={accent}
          zoom={zoom}
          layout={layout}
          headerMetrics={headerMetrics}
        />
      </div>
    </ViewportPortal>
  );
});
