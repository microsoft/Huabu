// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useInternalNode, useStore, ViewportPortal } from '@xyflow/react';
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { getNodeSize } from '@huabu/shared/canvas-engine';

import {
  FRAME_DESIGN_CONFIG,
  frameSurfaceStyle,
  frameVisualMetricsForSize,
} from './frameDesign';
import { farFrameRegionPresentation } from './frameZoom';
import { useFrameRegionVisible, useFrameRegionZ } from './FrameZoomContext';
import { getAccentTokens, isWhiteAccent } from '../design/accentTokens';
import { farLabelContentBox } from '../design/farZoomDesign';
import { FarZoomText } from '../semanticZoom/FarZoomText';

import type { FrameHeaderMetrics } from './frameHeaderMetrics';

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
  const box = farLabelContentBox(
    headerMetrics.maxWidth * zoom,
    layout.screenHeight -
      (headerMetrics.top + FRAME_DESIGN_CONFIG.header.edgeInset) * zoom,
    0,
    0,
    layout.lineHeight,
  );
  const titleLines = Math.max(0, box.lines - 1);
  const colors =
    accent && !isWhiteAccent(accent) ? getAccentTokens(accent) : null;
  const probe = useRef<HTMLDivElement>(null);
  const [inlineFits, setInlineFits] = useState(false);
  useLayoutEffect(() => {
    const element = probe.current;
    if (!element) return;
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
      const textLine = last
        ? Math.floor(
            (last.top - element.getBoundingClientRect().top) /
              layout.lineHeight,
          )
        : 0;
      setInlineFits(
        element.offsetHeight > 0 &&
          element.offsetHeight <= box.availableHeight &&
          Math.round(badge.offsetTop / layout.lineHeight) === textLine,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [
    title,
    childCount,
    box.availableWidth,
    box.availableHeight,
    layout.lineHeight,
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
        left: headerMetrics.left,
        top: headerMetrics.top,
        transform: `scale(${1 / zoom})`,
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
        <span className="inline-block align-top" style={{ marginLeft: 6 }}>
          {countBadge(true)}
        </span>
      </div>
      {inlineFits ? (
        <div data-frame-region-inline="" style={{ overflowWrap: 'anywhere' }}>
          <span data-frame-region-title="">
            <FarZoomText text={title} />
          </span>
          <span className="inline-block align-top" style={{ marginLeft: 6 }}>
            {countBadge()}
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-start" style={{ columnGap: 6 }}>
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
