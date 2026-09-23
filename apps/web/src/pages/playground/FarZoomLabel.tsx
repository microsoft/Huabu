// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useLayoutEffect, useRef, useState } from 'react';

import {
  FAR_ZOOM_STUDY as METRICS,
  farDescriptionLines,
} from './farZoomPresentation';
import { FarZoomText } from './FarZoomText';

export function FarZoomLabel({
  title,
  description,
  width,
  height,
  lines,
  zoom,
  visible,
}: {
  title: string;
  description?: string;
  width: number;
  height: number;
  lines: number;
  zoom: number;
  visible: boolean;
}) {
  const probe = useRef<HTMLDivElement>(null);
  const [descriptionLines, setDescriptionLines] = useState(0);
  useLayoutEffect(() => {
    const element = probe.current;
    if (!element) return;
    let active = true;
    const measure = () => {
      if (active)
        setDescriptionLines(
          visible && description?.trim() && description.trim() !== title.trim()
            ? farDescriptionLines(
                width,
                height,
                element.getBoundingClientRect().height,
                lines,
              )
            : 0,
        );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    document.fonts?.addEventListener('loadingdone', measure);
    void document.fonts?.ready.then(measure);
    return () => {
      active = false;
      observer.disconnect();
      document.fonts?.removeEventListener('loadingdone', measure);
    };
  }, [title, description, width, height, lines, zoom, visible]);

  const typography = {
    fontSize: METRICS.labelFont / zoom,
    lineHeight: `${METRICS.labelLine / zoom}px`,
    fontWeight: METRICS.labelWeight,
    overflowWrap: 'normal' as const,
    wordBreak: 'normal' as const,
  };
  return (
    <div
      data-study-label=""
      aria-hidden={!visible}
      className="pointer-events-none absolute overflow-hidden"
      style={{
        left: METRICS.labelInset / zoom,
        top: METRICS.labelInset / zoom,
        width: width / zoom,
        maxHeight: height / zoom,
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
          maxHeight: (lines * METRICS.labelLine) / zoom,
        }}
      >
        <FarZoomText text={title} />
      </div>
      {visible && descriptionLines > 0 && (
        <p
          data-study-description=""
          className="text-fg-muted overflow-hidden"
          style={{
            marginTop: METRICS.descriptionGap / zoom,
            fontSize: METRICS.descriptionFont / zoom,
            lineHeight: `${METRICS.descriptionLine / zoom}px`,
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: descriptionLines,
            maxHeight: (descriptionLines * METRICS.descriptionLine) / zoom,
            overflowWrap: 'normal',
            wordBreak: 'normal',
          }}
        >
          <FarZoomText text={description ?? ''} />
        </p>
      )}
    </div>
  );
}
