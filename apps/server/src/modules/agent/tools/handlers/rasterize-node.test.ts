import { describe, expect, it } from 'vitest';

import {
  clusterToSvg,
  findContextImageNodes,
  type ContextImage,
  type RawNode,
} from './rasterize-node.js';

// Minimal 1x1 transparent PNG (so we can verify the data URL embed
// without bringing real image bytes into the test).
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

function makeImage(opts: {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  src?: string;
  parentId?: string;
  measured?: boolean;
}): RawNode {
  const size = opts.measured
    ? { measured: { width: opts.w, height: opts.h } }
    : { style: { width: opts.w, height: opts.h } };
  return {
    id: opts.id,
    parentId: opts.parentId,
    position: { x: opts.x, y: opts.y },
    ...size,
    data: {
      type: 'image',
      src: opts.src ?? 'cat.png',
    },
  };
}

function makeSketch(opts: {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parentId?: string;
  strokes?: RawNode['data'] extends infer D
    ? D extends { strokes?: infer S }
      ? S
      : never
    : never;
}): RawNode {
  return {
    id: opts.id,
    parentId: opts.parentId,
    position: { x: opts.x, y: opts.y },
    width: opts.w,
    height: opts.h,
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

describe('findContextImageNodes', () => {
  it('returns image nodes whose bbox overlaps the cluster (style-sized)', () => {
    // Sketch at (50,50) 100x100 → covers [50..150]x[50..150]
    // Image at (100,100) 200x200 (style.width) → covers [100..300]x[100..300]
    // They overlap.
    const sketch = makeSketch({ id: 'sk1', x: 50, y: 50, w: 100, h: 100 });
    const image = makeImage({
      id: 'img1',
      x: 100,
      y: 100,
      w: 200,
      h: 200,
      measured: false,
    });
    const found = findContextImageNodes([sketch], [sketch, image]);
    expect(found.map((n) => n.id)).toEqual(['img1']);
  });

  it('returns image nodes sized via measured.width (real React Flow shape)', () => {
    const sketch = makeSketch({ id: 'sk1', x: 50, y: 50, w: 100, h: 100 });
    const image = makeImage({
      id: 'img1',
      x: 80,
      y: 80,
      w: 200,
      h: 200,
      measured: true,
    });
    const found = findContextImageNodes([sketch], [sketch, image]);
    expect(found.map((n) => n.id)).toEqual(['img1']);
  });

  it('returns image nodes that have NO data.src (the real canvas.json shape)', () => {
    // canvas.json never persists `data.src` for image nodes — the
    // artifact key lives in the sidecar markdown frontmatter. So this
    // filter must NOT require src; `loadContextImage` resolves it.
    const sketch = makeSketch({ id: 'sk1', x: 50, y: 50, w: 100, h: 100 });
    const image: RawNode = {
      id: 'img-no-src',
      position: { x: 80, y: 80 },
      measured: { width: 200, height: 200 },
      style: { width: 200, height: 200 },
      data: { type: 'image' /* no src */ },
    };
    const found = findContextImageNodes([sketch], [sketch, image]);
    expect(found.map((n) => n.id)).toEqual(['img-no-src']);
  });

  it('excludes images that do NOT overlap the cluster (the BillG case)', () => {
    // Reproduces the user's actual canvas: image and sketch were both
    // selected but spatially nowhere near each other.
    //   image:  x=474,  y=636.5, 400x400 → [474..874]x[636.5..1036.5]
    //   sketch: x=-811, y=711.5, 167x161 → [-811..-644]x[711.5..872.5]
    const sketch = makeSketch({
      id: 'sk-far',
      x: -811,
      y: 711.5,
      w: 167,
      h: 161,
    });
    const image = makeImage({
      id: 'img-cat',
      x: 474,
      y: 636.5,
      w: 400,
      h: 400,
      measured: true,
    });
    const found = findContextImageNodes([sketch], [sketch, image]);
    expect(found).toEqual([]);
  });

  it('excludes images in a different frame (parentId mismatch)', () => {
    const sketch = makeSketch({
      id: 'sk1',
      x: 50,
      y: 50,
      w: 100,
      h: 100,
      parentId: 'frame-A',
    });
    const image = makeImage({
      id: 'img1',
      x: 60,
      y: 60,
      w: 100,
      h: 100,
      parentId: 'frame-B',
    });
    const found = findContextImageNodes([sketch], [sketch, image]);
    expect(found).toEqual([]);
  });
});

describe('clusterToSvg', () => {
  it('includes the backdrop <image> as a base64 data URL when given a ContextImage', () => {
    const sketch = makeSketch({ id: 'sk1', x: 50, y: 50, w: 100, h: 100 });
    const image = makeImage({
      id: 'img1',
      x: 80,
      y: 80,
      w: 200,
      h: 200,
      measured: true,
    });
    const context: ContextImage[] = [
      {
        node: image,
        resolvedSrc: 'cat.png',
        bytes: TINY_PNG,
        mimeType: 'image/png',
      },
    ];
    const built = clusterToSvg([sketch], context);
    expect(built).not.toBeNull();
    const svg = built!.svg;
    // The <image> element must be emitted with the data URL.
    expect(svg).toContain('<image');
    expect(svg).toContain('href="data:image/png;base64,');
    expect(svg).toContain(TINY_PNG.toString('base64'));
    // And the backdrop must sit at the image's on-canvas rect, not
    // the sketch's rect.
    expect(svg).toContain('x="80"');
    expect(svg).toContain('y="80"');
    expect(svg).toContain('width="200"');
    expect(svg).toContain('height="200"');
    // viewBox must encompass the union of sketch + backdrop, with
    // CLUSTER_PADDING (16) on every side. Sketch:[50..150], Image:[80..280]
    // → union x [50..280], y [50..280] → viewBox x=34 y=34 w=262 h=262.
    expect(svg).toMatch(/viewBox="34 34 262 262"/);
    // Strokes must still render on top.
    expect(svg).toContain('<path');
  });

  it('produces a sketch-only SVG (no <image>) when no backdrops are passed', () => {
    const sketch = makeSketch({ id: 'sk1', x: 50, y: 50, w: 100, h: 100 });
    const built = clusterToSvg([sketch], []);
    expect(built).not.toBeNull();
    expect(built!.svg).not.toContain('<image');
    expect(built!.svg).toContain('<path');
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
    const built = clusterToSvg([empty], []);
    expect(built).toBeNull();
  });
});
