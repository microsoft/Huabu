// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { DEFAULT_EDGE_STROKE_TOKEN } from '@huabu/shared/canvas-engine';

import { resolveAccentCss } from '@/utils/accentColor';

import type { Edge } from '@xyflow/react';

export function getEdgeAccent(edge: Pick<Edge, 'data' | 'style'>): string {
  const style = edge.data?.edgeStyle;
  if (style && typeof style === 'object') {
    return 'stroke' in style && typeof style.stroke === 'string' && style.stroke
      ? style.stroke
      : DEFAULT_EDGE_STROKE_TOKEN;
  }
  return typeof edge.style?.stroke === 'string' && edge.style.stroke
    ? edge.style.stroke
    : DEFAULT_EDGE_STROKE_TOKEN;
}

const renderedEdges = new WeakMap<Edge, Edge>();

/** Theme only the display projection, never the serializable engine state. */
export function renderEdgeAccent(edge: Edge): Edge {
  const cached = renderedEdges.get(edge);
  if (cached) return cached;
  const color = resolveAccentCss(getEdgeAccent(edge)) ?? undefined;
  const recolor = (marker: Edge['markerEnd']) =>
    marker && typeof marker !== 'string' ? { ...marker, color } : marker;
  const rendered = {
    ...edge,
    style: { ...edge.style, stroke: color },
    markerStart: recolor(edge.markerStart),
    markerEnd: recolor(edge.markerEnd),
  };
  renderedEdges.set(edge, rendered);
  return rendered;
}
