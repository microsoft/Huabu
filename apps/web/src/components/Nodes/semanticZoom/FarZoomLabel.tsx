// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useLayoutEffect, useRef, useState } from 'react';

import { FarZoomText } from './FarZoomText';
import {
  FAR_ZOOM_DESIGN,
  farDescriptionLines,
  type FarZoomDesign,
} from '../design/farZoomDesign';

const fontSubscribers = new Set<() => void>();
let stopFontObservation: (() => void) | undefined;

/** Share one font listener across labels, releasing it when none need measurement. */
function subscribeToFontChanges(measure: () => void) {
  const fonts = document.fonts;
  if (!fonts) return () => {};
  fontSubscribers.add(measure);
  if (!stopFontObservation) {
    let active = true;
    const refresh = () => {
      if (active) fontSubscribers.forEach((subscriber) => subscriber());
    };
    fonts.addEventListener('loadingdone', refresh);
    void fonts.ready.then(refresh);
    stopFontObservation = () => {
      active = false;
      fonts.removeEventListener('loadingdone', refresh);
    };
  }
  return () => {
    fontSubscribers.delete(measure);
    if (fontSubscribers.size === 0) {
      stopFontObservation?.();
      stopFontObservation = undefined;
    }
  };
}

/** Lay out text in screen pixels; only the outer transform cancels canvas zoom. */
export function FarZoomLabel({
  title,
  description,
  descriptionDivider = false,
  width,
  height,
  lines,
  zoom,
  visible,
  design = FAR_ZOOM_DESIGN,
  verticalInset = design.labelInset,
  horizontalInset = design.labelInsetInline ?? design.labelInset,
}: {
  title: string;
  description?: string;
  descriptionDivider?: boolean;
  width: number;
  height: number;
  lines: number;
  zoom: number;
  visible: boolean;
  verticalInset?: number;
  horizontalInset?: number;
  design?: FarZoomDesign;
}) {
  const probe = useRef<HTMLDivElement>(null);
  const [titleHeight, setTitleHeight] = useState(0);
  // Read once when revealing or replacing text, not on every zoom frame.
  useLayoutEffect(() => {
    if (visible && probe.current) setTitleHeight(probe.current.offsetHeight);
  }, [title, visible]);

  useLayoutEffect(() => {
    const element = probe.current;
    if (!visible || !element) return;
    let active = true;
    const measure = () => {
      if (active) setTitleHeight(element.offsetHeight);
    };
    // ResizeObserver already carries untransformed layout dimensions. Reuse
    // that result instead of forcing a synchronous layout read after each zoom.
    const observer = new ResizeObserver((entries) => {
      if (!active) return;
      const entry = entries.find((entry) => entry.target === element);
      if (entry) setTitleHeight(entry.contentRect.height);
    });
    observer.observe(element);
    const unsubscribeFonts = subscribeToFontChanges(measure);
    return () => {
      active = false;
      observer.disconnect();
      unsubscribeFonts();
    };
  }, [visible]);

  const descriptionLines =
    visible && description?.trim() && description.trim() !== title.trim()
      ? farDescriptionLines(width, height, titleHeight, lines, design)
      : 0;

  const typography = {
    fontSize: design.labelFont,
    lineHeight: `${design.labelLine}px`,
    fontWeight: design.labelWeight,
    overflowWrap: 'anywhere' as const,
    wordBreak: 'normal' as const,
  };
  return (
    <div
      data-study-label=""
      aria-hidden={!visible}
      className="pointer-events-none absolute overflow-hidden"
      style={{
        left: horizontalInset / zoom,
        top: verticalInset / zoom,
        width,
        maxHeight: height,
        transform: `scale(${1 / zoom})`,
        transformOrigin: 'top left',
        opacity: visible ? 1 : 0,
      }}
    >
      <div
        ref={probe}
        aria-hidden="true"
        data-title-probe=""
        className="invisible absolute top-0 left-0 w-full"
        style={typography}
      >
        <FarZoomText text={title} />
      </div>
      <div
        data-study-title=""
        className="text-fg-default overflow-hidden"
        style={{
          ...typography,
          display: lines ? '-webkit-box' : 'none',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: Math.max(1, lines),
          maxHeight: lines * design.labelLine,
        }}
      >
        <FarZoomText text={title} />
      </div>
      {visible && descriptionLines > 0 && (
        <>
          {descriptionDivider && (
            <div
              aria-hidden="true"
              className="flex items-center"
              style={{ height: design.descriptionGap }}
            >
              <div
                data-far-description-divider=""
                className="bg-edge-default h-px w-full"
              />
            </div>
          )}
          <p
            data-study-description=""
            className="text-fg-muted overflow-hidden"
            style={{
              marginTop: descriptionDivider ? 0 : design.descriptionGap,
              fontSize: design.descriptionFont,
              lineHeight: `${design.descriptionLine}px`,
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: descriptionLines,
              maxHeight: descriptionLines * design.descriptionLine,
              overflowWrap: 'anywhere',
              wordBreak: 'normal',
            }}
          >
            <FarZoomText text={description ?? ''} />
          </p>
        </>
      )}
    </div>
  );
}
