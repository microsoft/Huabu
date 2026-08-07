// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { nodeRevisionOf } from '../../change.js';
import {
  getNodeCreationStyle,
  isAlwaysAutoHeightNodeType,
} from '../../utils/nodeSizes.js';
import {
  HEIGHT_LAYOUT_VERSION,
  HEIGHT_QUANTIZATION_STEP,
  autoHeightKey,
  contentScaleFor,
  getHeightPolicy,
  getHeightRefWidth,
  intrinsicToLayoutHeight,
  isAlwaysAutoHeightType,
  isAutoHeightByDefaultType,
  materializeAutoHeight,
  materializeAutoHeights,
  quantizeHeight,
  readAutoHeightHint,
  resolveHeightMode,
} from '../index.js';

import type { Node } from '@xyflow/react';

/**
 * The values the height policy table replaced. Kept here verbatim so the
 * table is pinned to the behaviour that shipped before it existed — this
 * suite is the proof that introducing the table changed nothing.
 */
const LEGACY_ALWAYS_AUTO = new Set(['text', 'question']);
const LEGACY_AUTO_BY_DEFAULT = new Set(['text', 'note', 'question']);
const LEGACY_REF_WIDTHS: Record<string, number> = {
  note: 400,
  web: 400,
  pdf: 400,
  office: 400,
};

const ALL_NODE_TYPES = [
  'text',
  'note',
  'question',
  'web',
  'pdf',
  'office',
  'video',
  'image',
  'audio',
  'frame',
  'sketch',
  'canvasRef',
  'frameRef',
  'nodeRef',
  'unknown-future-type',
];

function node(partial: Partial<Node> & { type: string }): Node {
  return {
    id: 'n1',
    position: { x: 0, y: 0 },
    data: {},
    ...partial,
  } as Node;
}

describe('height policy table', () => {
  it('reproduces the legacy always-auto-height type set', () => {
    for (const type of ALL_NODE_TYPES) {
      expect([type, isAlwaysAutoHeightType(type)]).toEqual([
        type,
        LEGACY_ALWAYS_AUTO.has(type),
      ]);
    }
  });

  it('reproduces the legacy auto-height-by-default type set', () => {
    for (const type of ALL_NODE_TYPES) {
      expect([type, isAutoHeightByDefaultType(type)]).toEqual([
        type,
        LEGACY_AUTO_BY_DEFAULT.has(type),
      ]);
    }
  });

  it('reproduces the legacy reference widths', () => {
    for (const type of ALL_NODE_TYPES) {
      expect([type, getHeightRefWidth(type)]).toEqual([
        type,
        LEGACY_REF_WIDTHS[type],
      ]);
    }
  });

  it('keeps nodeSizes behaviour unchanged', () => {
    for (const type of ALL_NODE_TYPES) {
      expect(isAlwaysAutoHeightNodeType(type)).toBe(
        LEGACY_ALWAYS_AUTO.has(type),
      );
      expect(getNodeCreationStyle(type, { width: 400, height: 300 })).toEqual(
        LEGACY_AUTO_BY_DEFAULT.has(type)
          ? { width: 400 }
          : { width: 400, height: 300 },
      );
      expect(
        getNodeCreationStyle(
          type,
          { width: 400, height: 300 },
          { heightIsExplicit: true },
        ),
      ).toEqual(
        LEGACY_ALWAYS_AUTO.has(type)
          ? { width: 400 }
          : { width: 400, height: 300 },
      );
    }
  });
});

describe('resolveHeightMode', () => {
  it('is always auto for content-driven types, whatever is stored', () => {
    expect(
      resolveHeightMode(
        node({ type: 'text', style: { height: 200 }, data: {} }),
      ),
    ).toBe('auto');
    expect(
      resolveHeightMode(
        node({ type: 'question', data: { heightMode: 'fixed' } }),
      ),
    ).toBe('auto');
  });

  it('is always fixed for manual types', () => {
    expect(resolveHeightMode(node({ type: 'image' }))).toBe('fixed');
    expect(
      resolveHeightMode(node({ type: 'pdf', data: { heightMode: 'auto' } })),
    ).toBe('fixed');
  });

  it('prefers the stored flag on toggleable types', () => {
    expect(
      resolveHeightMode(
        node({
          type: 'note',
          data: { heightMode: 'auto' },
          style: { height: 300 },
        }),
      ),
    ).toBe('auto');
    expect(
      resolveHeightMode(node({ type: 'note', data: { heightMode: 'fixed' } })),
    ).toBe('fixed');
  });

  it('infers the legacy encoding when the flag is absent', () => {
    expect(resolveHeightMode(node({ type: 'note' }))).toBe('auto');
    expect(resolveHeightMode(node({ type: 'note', style: {} }))).toBe('auto');
    expect(
      resolveHeightMode(node({ type: 'note', style: { height: 320 } })),
    ).toBe('fixed');
  });

  it('does not read a measurement hint as evidence of ownership', () => {
    // A pinned note records a hint too — it describes the content, not
    // who owns the box — so the hint cannot stand in for the flag.
    expect(
      resolveHeightMode(
        node({
          type: 'note',
          style: { height: 700 },
          data: {
            autoHeight: { intrinsicHeight: 260, measuredFor: 'k1' },
          },
        }),
      ),
    ).toBe('fixed');
  });

  it('still lets an explicit flag override a stored hint', () => {
    expect(
      resolveHeightMode(
        node({
          type: 'note',
          style: { height: 700 },
          data: {
            heightMode: 'auto',
            autoHeight: { intrinsicHeight: 260, measuredFor: 'k1' },
          },
        }),
      ),
    ).toBe('auto');
  });
});

describe('intrinsicToLayoutHeight', () => {
  it('quantizes to the step so sub-step differences collapse', () => {
    expect(quantizeHeight(100)).toBe(100);
    expect(quantizeHeight(100.4)).toBe(100 + HEIGHT_QUANTIZATION_STEP);
    expect(intrinsicToLayoutHeight(199, 'note', 400)).toBe(
      intrinsicToLayoutHeight(201, 'note', 400),
    );
  });

  it('adds the node shell inset after scaling, not before', () => {
    // The shell border lives outside the scaled container, so doubling
    // the width doubles the content but not the 6px chrome. The same
    // 6px also narrows the content box, which is why the scale at the
    // reference width is 394/400 rather than 1.
    expect(intrinsicToLayoutHeight(200, 'note', 400)).toBe(204);
    expect(intrinsicToLayoutHeight(200, 'note', 800)).toBe(404);
  });

  it('applies the minimum before scaling', () => {
    // Note minimum is 50 unscaled; at half width the scale clamp is 0.5.
    expect(intrinsicToLayoutHeight(10, 'note', 400)).toBe(56);
    expect(intrinsicToLayoutHeight(10, 'note', 200)).toBe(32);
  });

  it('does not scale types without a reference width', () => {
    expect(intrinsicToLayoutHeight(200, 'text', 800)).toBe(200);
    expect(intrinsicToLayoutHeight(200, 'text', undefined)).toBe(200);
  });

  it('does not floor the scale for a type whose height derives from it', () => {
    // A note keeps shrinking all the way down. A floor would make its
    // content lay out narrower than the reference width, so a height
    // measured at that reference would no longer apply and the node
    // would render short. Semantic zoom, not this, is what keeps a tiny
    // note readable — it swaps the body for a placeholder.
    expect(contentScaleFor(getHeightPolicy('note'), 100)).toBeCloseTo(0.235);
    expect(intrinsicToLayoutHeight(200, 'note', 100)).toBe(56);
  });

  it('floors the scale for manual types, whose box the user owns', () => {
    // Their height is authored, so the scale is purely a rendering
    // decision and a legibility floor costs nothing.
    expect(contentScaleFor(getHeightPolicy('pdf'), 100)).toBe(0.5);
    expect(contentScaleFor(getHeightPolicy('web'), 100)).toBe(0.5);
    expect(contentScaleFor(getHeightPolicy('office'), 100)).toBe(0.5);
  });

  it('keeps the logical layout width at the reference width', () => {
    // The premise the whole hint cache rests on: content measured at one
    // node width wraps identically at any other.
    for (const width of [80, 155, 206, 400, 800, 1600]) {
      const scale = contentScaleFor(getHeightPolicy('note'), width);
      expect((width - 6) / scale).toBeCloseTo(400);
    }
  });
});

describe('readAutoHeightHint', () => {
  const content = '# hello';
  const currentKey = `${HEIGHT_LAYOUT_VERSION}:${nodeRevisionOf({ content })}`;

  it('reports missing when nothing is stored', () => {
    expect(readAutoHeightHint(node({ type: 'note' }))).toEqual({
      freshness: 'missing',
    });
  });

  it('reports missing for a malformed or non-positive hint', () => {
    for (const autoHeight of [
      null,
      42,
      { measuredFor: currentKey },
      { intrinsicHeight: 0, measuredFor: currentKey },
      { intrinsicHeight: Number.NaN, measuredFor: currentKey },
      { intrinsicHeight: 120 },
    ]) {
      expect(
        readAutoHeightHint(node({ type: 'note', data: { autoHeight } }))
          .freshness,
      ).toBe('missing');
    }
  });

  it('reports current only when the key matches', () => {
    const read = readAutoHeightHint(
      node({
        type: 'note',
        data: {
          content,
          autoHeight: { intrinsicHeight: 120, measuredFor: currentKey },
        },
      }),
    );
    expect(read.freshness).toBe('current');
    expect(read.hint?.intrinsicHeight).toBe(120);
  });

  it('reports stale after the content changes', () => {
    expect(
      readAutoHeightHint(
        node({
          type: 'note',
          data: {
            content: '# changed',
            autoHeight: { intrinsicHeight: 120, measuredFor: currentKey },
          },
        }),
      ).freshness,
    ).toBe('stale');
  });

  it('reports stale after the layout version is bumped', () => {
    expect(
      readAutoHeightHint(
        node({
          type: 'note',
          data: {
            content,
            autoHeight: {
              intrinsicHeight: 120,
              measuredFor: `${HEIGHT_LAYOUT_VERSION + 1}:${nodeRevisionOf({ content })}`,
            },
          },
        }),
      ).freshness,
    ).toBe('stale');
  });

  it('reports stale for a key it cannot recognise at all', () => {
    const read = readAutoHeightHint(
      node({
        type: 'note',
        data: {
          content,
          autoHeight: {
            intrinsicHeight: 260,
            measuredFor: 'not-a-key',
          },
        },
      }),
    );
    expect(read.freshness).toBe('stale');
    // ...but the footprint is still usable as a seed.
    expect(read.hint?.intrinsicHeight).toBe(260);
  });

  it('treats a provisional measurement as stale even under the current key', () => {
    expect(
      readAutoHeightHint(
        node({
          type: 'note',
          data: {
            content,
            autoHeight: {
              intrinsicHeight: 120,
              measuredFor: currentKey,
              provisional: true,
            },
          },
        }),
      ).freshness,
    ).toBe('stale');
  });

  it('keys on src as well as content, matching nodeRevisionOf', () => {
    expect(autoHeightKey(node({ type: 'note', data: { content } }))).not.toBe(
      autoHeightKey(node({ type: 'note', data: { content, src: 'a.png' } })),
    );
  });
});

describe('materializeAutoHeight', () => {
  const content = '# hello';
  const currentKey = `${HEIGHT_LAYOUT_VERSION}:${nodeRevisionOf({ content })}`;

  it('gives an unmeasured auto node a positive height', () => {
    const result = materializeAutoHeight(node({ type: 'note' }));
    expect((result.style as { height: number }).height).toBeGreaterThan(0);
    expect(result.measured?.height).toBe(
      (result.style as { height: number }).height,
    );
  });

  it('materializes from the stored hint', () => {
    const result = materializeAutoHeight(
      node({
        type: 'note',
        style: { width: 400 },
        data: {
          content,
          autoHeight: { intrinsicHeight: 260, measuredFor: currentKey },
        },
      }),
    );
    // 260 content, scaled by 394/400, plus 6px shell chrome, quantized.
    expect((result.style as { height: number }).height).toBe(264);
  });

  it('materializes a stale hint too — a seed beats a collapse', () => {
    const result = materializeAutoHeight(
      node({
        type: 'note',
        style: { width: 400 },
        data: {
          content: '# changed',
          autoHeight: { intrinsicHeight: 260, measuredFor: currentKey },
        },
      }),
    );
    expect((result.style as { height: number }).height).toBe(264);
  });

  it('leaves fixed nodes alone', () => {
    const fixed = node({
      type: 'note',
      style: { height: 321 },
      data: { heightMode: 'fixed' },
    });
    expect(materializeAutoHeight(fixed)).toBe(fixed);

    const image = node({ type: 'image', style: { height: 300 } });
    expect(materializeAutoHeight(image)).toBe(image);
  });

  it('returns the same reference when the geometry already agrees', () => {
    const settled = materializeAutoHeight(
      node({
        type: 'note',
        style: { width: 400 },
        data: {
          content,
          autoHeight: { intrinsicHeight: 260, measuredFor: currentKey },
        },
      }),
    );
    expect(materializeAutoHeight(settled)).toBe(settled);
  });

  it('overwrites a stale measured height left behind by a mode toggle', () => {
    const result = materializeAutoHeight(
      node({
        type: 'note',
        style: { width: 400 },
        measured: { width: 400, height: 800 },
        data: {
          heightMode: 'auto',
          content,
          autoHeight: { intrinsicHeight: 260, measuredFor: currentKey },
        },
      }),
    );
    expect(result.measured?.height).toBe(264);
    expect(result.measured?.width).toBe(400);
  });

  it('preserves the array reference when no node changes', () => {
    const nodes = [
      node({ id: 'a', type: 'image', style: { height: 300 } }),
      materializeAutoHeight(node({ id: 'b', type: 'note' })),
    ];
    expect(materializeAutoHeights(nodes)).toBe(nodes);
  });
});
