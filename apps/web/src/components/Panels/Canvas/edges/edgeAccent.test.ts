// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { applyEdgeStyle } from '@huabu/shared/canvas-engine';

import { resolveAccentCss } from '@/utils/accentColor';

import { getEdgeAccent, renderEdgeAccent } from './edgeAccent';

describe('edge accent projection', () => {
  it('themes the path and both arrows without mutating persisted engine props', () => {
    const edge = applyEdgeStyle(
      { id: 'edge', source: 'a', target: 'b' },
      { stroke: 'amber', direction: 'both' },
    );
    const before = JSON.stringify(edge);
    const rendered = renderEdgeAccent(edge);
    expect(rendered.style?.stroke).toBe(resolveAccentCss('amber'));
    expect(rendered.markerStart).toMatchObject({
      color: resolveAccentCss('amber'),
    });
    expect(rendered.markerEnd).toMatchObject({
      color: resolveAccentCss('amber'),
    });
    expect(getEdgeAccent(rendered)).toBe('amber');
    expect(JSON.stringify(edge)).toBe(before);
    expect(renderEdgeAccent(edge)).toBe(rendered);
  });

  it('retains the default token and keeps custom strokes fixed', () => {
    const edge = applyEdgeStyle({ id: 'edge', source: 'a', target: 'b' });
    expect(renderEdgeAccent(edge).style?.stroke).toBe(
      resolveAccentCss(getEdgeAccent(edge)),
    );
    const custom = applyEdgeStyle(edge, {
      stroke: '#688FB8',
      direction: 'forward',
    });
    expect(renderEdgeAccent(custom).style?.stroke).toBe('#688FB8');
    expect(renderEdgeAccent(custom).markerEnd).toMatchObject({
      color: '#688FB8',
    });
  });
});
