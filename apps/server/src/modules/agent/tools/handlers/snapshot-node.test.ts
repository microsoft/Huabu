import { describe, expect, it } from 'vitest';

import {
  clusterToSvg,
  type ContextImage,
} from './snapshot-node.js';

import type { CanvasNode } from '@sediment/shared/canvas-engine';

// Minimal 1x1 transparent PNG so we can verify the data URL embed
// without bringing real image bytes into the test.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

function makeImageNode(opts: {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parentId?: string;
}): CanvasNode {
  return {
    id: opts.id,
    type: 'image',
    position: { x: opts.x, y: opts.y },
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    measured: { width: opts.w, height: opts.h },
    style: { width: opts.w, height: opts.h },
    data: { type: 'image' },
  };
}

type SketchStroke = {
  points: number[][];
  color?: string;
  size?: number;
};

function makeSketch(opts: {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parentId?: string;
  strokes?: SketchStroke[];
}): CanvasNode {
  // Real on-disk shape: the canvas engine (`CREATE_NODES`) writes size
  // into `style.width` / `style.height`; ReactFlow may also write
  // `measured` at render time. `data.initialSize` is the author-time
  // canonical size used to normalize stroke coordinates.
  return {
    id: opts.id,
    type: 'sketch',
    position: { x: opts.x, y: opts.y },
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    style: { width: opts.w, height: opts.h },
    data: {
      type: 'sketch',
      initialSize: { width: opts.w, height: opts.h },
      strokes: opts.strokes ?? [
        {
          points: [
            [10, 10, 0.5],
            [20, 20, 0.5],
            [30, 10, 0.5],
          ],
          color: 'red',
          size: 4,
        },
      ],
    },
  };
}

describe('clusterToSvg', () => {
  it('produces a sketch-only SVG when no contextImages are given', () => {
    // Without explicit backdrops, the snapshot is strokes-only —
    // even if the canvas has neighbouring images, they are never
    // automatically pulled in. The composite path only kicks in
    // when the caller actively passes a ContextImage.
    const sketch = makeSketch({ id: 'sk1', x: 50, y: 50, w: 100, h: 100 });
    const built = clusterToSvg([sketch]);
    expect(built).not.toBeNull();
    expect(built!.svg).not.toContain('<image');
    expect(built!.svg).toContain('<path');
    // viewBox = sketch rect + CLUSTER_PADDING (16) on every side:
    //   x [50..150] y [50..150] → viewBox x=34 y=34 w=132 h=132.
    expect(built!.svg).toMatch(/viewBox="34 34 132 132"/);
  });

  it('composites a passed-in backdrop image under the strokes', () => {
    const sketch = makeSketch({ id: 'sk1', x: 50, y: 50, w: 100, h: 100 });
    const imageNode = makeImageNode({
      id: 'img1',
      x: 80,
      y: 80,
      w: 200,
      h: 200,
    });
    const context: ContextImage[] = [
      {
        node: imageNode,
        resolvedSrc: 'cat.png',
        bytes: TINY_PNG,
        mimeType: 'image/png',
        width: 200,
        height: 200,
      },
    ];
    const built = clusterToSvg([sketch], context);
    expect(built).not.toBeNull();
    const svg = built!.svg;
    expect(svg).toContain('<image');
    expect(svg).toContain('href="data:image/png;base64,');
    expect(svg).toContain(TINY_PNG.toString('base64'));
    // Backdrop is placed at the image's on-canvas rect.
    expect(svg).toContain('x="80"');
    expect(svg).toContain('y="80"');
    expect(svg).toContain('width="200"');
    expect(svg).toContain('height="200"');
    // viewBox unions the sketch and the backdrop:
    //   sketch [50..150]x[50..150], image [80..280]x[80..280]
    //   union  [50..280]x[50..280] + padding 16 → x=34 y=34 w=262 h=262
    expect(svg).toMatch(/viewBox="34 34 262 262"/);
    // Strokes still render on top of the backdrop.
    expect(svg).toContain('<path');
  });

  it('unions the viewBox across multiple sketches in the same cluster', () => {
    // Sketch A: [50..150]x[50..150]; Sketch B: [200..300]x[80..180].
    // Union: x [50..300] y [50..180] → +padding 16 →
    //   viewBox x=34 y=34 w=282 h=162.
    const a = makeSketch({ id: 'a', x: 50, y: 50, w: 100, h: 100 });
    const b = makeSketch({ id: 'b', x: 200, y: 80, w: 100, h: 100 });
    const built = clusterToSvg([a, b]);
    expect(built).not.toBeNull();
    expect(built!.svg).toMatch(/viewBox="34 34 282 162"/);
  });

  it('returns null when the cluster has no strokes (avoids 1x1 placeholder PNG)', () => {
    const empty = makeSketch({
      id: 'sk0',
      x: 50,
      y: 50,
      w: 100,
      h: 100,
      strokes: [],
    });
    const built = clusterToSvg([empty]);
    expect(built).toBeNull();
  });

  it('respects maxEdge: a 2000-px-wide cluster downscales to fit', () => {
    // 2000 px sketch with default CLUSTER_PADDING=16 → vbW=2032.
    // Passing maxEdge=512 should yield a render width of
    //   round(2032 * 512/2032) = 512.
    const big = makeSketch({ id: 'big', x: 0, y: 0, w: 2000, h: 1000 });
    const built = clusterToSvg([big], [], 512);
    expect(built).not.toBeNull();
    expect(built!.width).toBe(512);
    expect(built!.svg).toContain('width="512"');
  });
});
