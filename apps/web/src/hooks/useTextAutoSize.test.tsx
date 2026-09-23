// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NODE_SHELL_INSET } from '@huabu/shared/canvas-engine';

import {
  computeFontSizeForHeight,
  measureTextHeight,
} from '@/utils/node/textMeasure';

import {
  useTextAutoSize,
  type UseTextAutoSizeOpts,
  type UseTextAutoSizeResult,
} from './useTextAutoSize';
import {
  useTextNodeSurface,
  type UseTextNodeSurfaceOpts,
  type UseTextNodeSurfaceResult,
} from './useTextNodeSurface';

import type { NodeStyle } from '@huabu/shared';

const fixture = vi.hoisted(() => ({
  node: {
    id: 'text',
    data: { style: {} as NodeStyle },
    style: {} as { width?: number; height?: number },
  },
  patchNodeSilent: vi.fn(),
}));

vi.mock('@xyflow/react', () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({ nodeLookup: new Map([['text', fixture.node]]) }),
}));
vi.mock('@/store/canvasStore', () => ({
  default: {
    getState: () => ({
      nodes: [fixture.node],
      patchNodeSilent: fixture.patchNodeSilent,
    }),
  },
}));

let root: Root;
let result: UseTextAutoSizeResult;
let surface: UseTextNodeSurfaceResult;
let opts: UseTextAutoSizeOpts;

function Probe({ value }: { value: UseTextAutoSizeOpts }) {
  result = useTextAutoSize(value);
  return null;
}

function SurfaceProbe({ value }: { value: UseTextNodeSurfaceOpts }) {
  surface = useTextNodeSurface(value);
  return null;
}

function render(overrides: Partial<UseTextAutoSizeOpts> = {}) {
  opts = { ...opts, ...overrides };
  act(() => root.render(<Probe value={opts} />));
}

function contentHeight(text: string, width: number, fontSize: number) {
  return (
    Math.max(
      measureTextHeight(
        text || opts.placeholder || 'Type...',
        Math.max(width - opts.paddingX * 2, 1),
        fontSize,
        opts.fontOpts,
      ),
      fontSize * opts.fontOpts.lineHeight,
    ) +
    opts.paddingY * 2
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.node.data.style = { fontSize: 20, fontWeight: 'bold' };
  fixture.node.style = { width: 332 };
  fixture.patchNodeSilent.mockReset();
  fixture.patchNodeSilent.mockImplementation(
    (_id: string, patch: { style: NodeStyle }) => {
      fixture.node.data = { ...fixture.node.data, ...patch };
    },
  );
  opts = {
    nodeId: 'text',
    text: 'Free text wraps across lines. '.repeat(12),
    width: 332,
    baseFontSize: 16,
    paddingX: 16,
    paddingY: 8,
    fontOpts: {
      fontFamily: 'sans-serif',
      fontWeight: 'normal',
      fontStyle: 'normal',
      lineHeight: 1.5,
    },
    placeholder: 'Type here...',
  };
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('useTextAutoSize resize modes', () => {
  it('scales typography by outer width independently of dragged height and keeps side reflow typography', () => {
    render({ fontSizing: 'proportional' });
    const height = result.effectiveHeight;
    expect(result.effectivePaddingX).toBe(20);
    act(() => result.handleResizeStart('scale'));
    act(() => result.handleResize(664, 9999));
    expect(result.effectiveFontSize).toBe(40);
    expect(result.effectivePaddingX).toBe(40);
    expect(result.effectivePaddingY).toBe(20);
    fixture.node.style = { width: 664 };
    act(() => result.handleResizeEnd(664, 9999));
    render({ width: 664 });
    expect(result.effectiveHeight).toBeCloseTo(height * 2, 0);
    expect(fixture.node.data.style.fontSize).toBe(40);
    expect(fixture.node.data.style.fontWeight).toBe('bold');
    act(() => result.handleResizeStart('width'));
    act(() => result.handleResize(332, 1));
    expect(result.effectiveFontSize).toBe(40);
    expect(result.effectivePaddingX).toBe(40);
    expect(result.effectiveHeight).toBeGreaterThan(height * 2);
  });

  it('keeps proportional content height independent of the dragged box throughout the gesture', () => {
    render({ fontSizing: 'proportional' });
    act(() => result.handleResizeStart('scale'));
    const expectedHeight =
      Math.max(
        measureTextHeight(opts.text, 664 - 80, 40, opts.fontOpts),
        40 * opts.fontOpts.lineHeight,
      ) + 40;
    for (const draggedHeight of [1, 9999]) {
      act(() => result.handleResize(664, draggedHeight));
      expect(result.effectiveHeight).toBe(expectedHeight);
      expect(result.effectiveFontSize).toBe(40);
    }
    fixture.node.style = { width: 664 };
    act(() => result.handleResizeEnd(664, 1));
    render({ width: 664 });
    expect(result.effectiveHeight).toBe(expectedHeight);
    expect(fixture.node.style.height).toBeUndefined();
  });

  it.each(['fit', 'scale', 'width'] as const)(
    'keeps fixed card typography through %s resize and external font changes',
    (mode) => {
      render({ fontSizing: 'fixed', baseFontSize: 28 });
      expect(result.effectiveFontSize).toBe(28);
      act(() => result.handleResizeStart(mode));
      act(() => result.handleResize(160, 999));
      expect(result.effectiveFontSize).toBe(28);
      expect(result.effectiveHeight).toBe(contentHeight(opts.text, 160, 28));
      fixture.node.style = { width: 160 };
      act(() => result.handleResizeEnd(160, 999));
      fixture.node.data.style = { fontSize: 90 };
      render({ width: 160 });
      expect(result.effectiveFontSize).toBe(28);
      expect(fixture.patchNodeSilent).not.toHaveBeenCalled();
    },
  );

  it('does not migrate legacy Question height into a font', () => {
    fixture.node.data.style = {};
    fixture.node.style = { width: 332, height: 500 };
    render({ fontSizing: 'fixed', baseFontSize: 28 });
    expect(result.effectiveFontSize).toBe(28);
    expect(fixture.patchNodeSilent).not.toHaveBeenCalled();
  });

  it('reserves natural width for question metadata without overriding an authored width', () => {
    fixture.node.style = {};
    fixture.node.data.style = {};
    render({ text: 'Hi', minAutoWidth: 280, paddingX: 12, paddingY: 29 });
    expect(result.effectiveWidth).toBe(280);
    expect(result.effectiveHeight).toBe(contentHeight('Hi', 280, 16));
    expect(fixture.patchNodeSilent).not.toHaveBeenCalled();
    fixture.node.style = { width: 120 };
    render({ width: 120 });
    expect(result.effectiveWidth).toBe(120);
  });

  it('reflows width live at the captured font and ignores dragged height', () => {
    render();
    act(() => result.handleResizeStart('width'));
    act(() => result.handleResize(132, 9999));
    expect(result.effectiveWidth).toBe(132);
    expect(result.effectiveFontSize).toBe(20);
    expect(result.effectiveHeight).toBe(contentHeight(opts.text, 132, 20));
    const narrowHeight = result.effectiveHeight;

    act(() => result.handleResize(632, 1));
    expect(result.effectiveFontSize).toBe(20);
    expect(result.effectiveHeight).toBe(contentHeight(opts.text, 632, 20));
    expect(result.effectiveHeight).toBeLessThan(narrowHeight);
    expect(fixture.patchNodeSilent).not.toHaveBeenCalled();

    fixture.node.style = { width: 632 };
    act(() => result.handleResizeEnd(632, 1));
    render({ width: 632 });
    expect(fixture.patchNodeSilent).not.toHaveBeenCalled();
    expect(result.effectiveFontSize).toBe(20);
    expect(result.effectiveHeight).toBe(contentHeight(opts.text, 632, 20));
  });

  it('does not materialize an implicit base font or migrate transient drag height', () => {
    fixture.node.data.style = {};
    render();
    act(() => result.handleResizeStart('width'));
    fixture.node.style = { width: 132, height: 9999 };
    act(() => result.handleResize(132, 9999));
    render({ width: 132 });
    expect(result.effectiveFontSize).toBe(16);
    expect(result.effectiveHeight).toBe(contentHeight(opts.text, 132, 16));
    expect(fixture.patchNodeSilent).not.toHaveBeenCalled();
    fixture.node.style = { width: 132 };
    act(() => result.handleResizeEnd(132, 9999));
    render();
    expect(fixture.patchNodeSilent).not.toHaveBeenCalled();
    expect(fixture.node.data.style.fontSize).toBeUndefined();
  });

  it('captures the effective font rather than following style changes mid-drag', () => {
    render();
    act(() => result.handleResizeStart('width'));
    fixture.node.data.style = { fontSize: 72 };
    render();
    act(() => result.handleResize(232, 500));
    expect(result.effectiveFontSize).toBe(20);
    act(() => result.handleResizeEnd(232, 500));
    expect(fixture.patchNodeSilent).not.toHaveBeenCalled();
    expect(result.effectiveFontSize).toBe(72);
  });

  it('measures empty width-mode content using the placeholder at the locked font', () => {
    render({ text: '' });
    act(() => result.handleResizeStart('width'));
    act(() => result.handleResize(80, 900));
    expect(result.effectiveFontSize).toBe(20);
    expect(result.effectiveHeight).toBe(contentHeight('', 80, 20));
    act(() => result.handleResizeEnd(80, 900));
    expect(fixture.patchNodeSilent).not.toHaveBeenCalled();
  });

  it('scales from initial content width, not outer width or successive drag samples', () => {
    render({ fontSizing: 'resizable' });
    act(() => result.handleResizeStart('scale'));
    act(() => result.handleResize(632, 111));
    expect(result.effectiveWidth).toBe(632);
    expect(result.effectiveHeight).toBe(111 - NODE_SHELL_INSET);
    expect(result.effectiveFontSize).toBe(40);
    act(() => result.handleResize(932, 2));
    expect(result.effectiveHeight).toBe(0);
    expect(result.effectiveFontSize).toBe(60);
    expect(fixture.patchNodeSilent).not.toHaveBeenCalled();

    // End can carry a newer width than the last live event; preserve fresh styling.
    fixture.node.data.style = { fontSize: 20, fontWeight: 'normal' };
    fixture.node.style = { width: 482 };
    act(() => result.handleResizeEnd(482, 9999));
    render({ width: 482 });
    expect(fixture.patchNodeSilent).toHaveBeenCalledExactlyOnceWith('text', {
      style: { fontSize: 30, fontWeight: 'normal' },
    });
    expect(result.effectiveFontSize).toBe(30);
    expect(result.effectiveHeight).toBe(contentHeight(opts.text, 482, 30));
  });

  it('keeps fractional ratios to avoid introducing wrap drift', () => {
    render();
    act(() => result.handleResizeStart('scale'));
    act(() => result.handleResize(337, 500));
    expect(result.effectiveFontSize).toBeCloseTo((20 * 305) / 300, 10);
    act(() => result.handleResizeEnd(337, 500));
    expect(fixture.node.data.style.fontSize).toBeCloseTo((20 * 305) / 300, 10);
  });

  it.each([
    [32, 1],
    [10000, 200],
  ])(
    'clamps scale at existing 1–200px bounds (width %s)',
    (width, expected) => {
      render();
      act(() => result.handleResizeStart('scale'));
      act(() => result.handleResize(width, 1));
      expect(result.effectiveFontSize).toBe(expected);
      act(() => result.handleResizeEnd(width, 1));
      expect(fixture.node.data.style.fontSize).toBe(expected);
    },
  );

  it('captures auto-measured width and the implicit base font for empty text', () => {
    fixture.node.style = {};
    fixture.node.data.style = {};
    render({ text: '', width: undefined });
    expect(result.hasFixedWidth).toBe(false);
    const initialContentWidth = result.effectiveWidth - opts.paddingX * 2;
    act(() => result.handleResizeStart('scale'));
    const nextWidth = initialContentWidth * 2 + opts.paddingX * 2;
    act(() => result.handleResize(nextWidth, 1));
    expect(result.effectiveFontSize).toBe(32);
    act(() => result.handleResizeEnd(nextWidth, 1));
    expect(fixture.node.data.style.fontSize).toBe(32);
  });

  it('captures a new baseline for each gesture and keeps later edits content-driven', () => {
    render();
    act(() => result.handleResizeStart('scale'));
    fixture.node.style = { width: 632 };
    act(() => result.handleResizeEnd(632, 200));
    render({ width: 632 });
    act(() => result.handleResizeStart('scale'));
    act(() => result.handleResize(932, 500));
    expect(result.effectiveFontSize).toBe(60);
    fixture.node.style = { width: 932 };
    act(() => result.handleResizeEnd(932, 500));
    render({ width: 932, text: 'Changed text\n' });
    expect(result.effectiveFontSize).toBe(60);
    expect(result.effectiveHeight).toBe(contentHeight(opts.text, 932, 60));
    fixture.node.data.style = { fontSize: 24 };
    render();
    expect(result.effectiveFontSize).toBe(24);
    expect(result.effectiveHeight).toBe(contentHeight(opts.text, 932, 24));
  });

  it.each(['fit', undefined] as const)(
    'preserves resizable box-fit behavior for mode %s',
    (mode) => {
      render({
        fontSizing: 'resizable',
        paddingX: 20,
        paddingY: 20,
        text: 'Question prompt',
      });
      act(() => result.handleResizeStart(mode));
      const expected = computeFontSizeForHeight(
        opts.text,
        260,
        110,
        opts.fontOpts,
      );
      act(() => result.handleResize(300, 150));
      expect(result.effectiveFontSize).toBe(expected);
      expect(result.effectiveHeight).toBe(150 - NODE_SHELL_INSET);
      fixture.node.style = { width: 300 };
      act(() => result.handleResizeEnd(300, 150));
      render({ width: 300 });
      expect(fixture.node.data.style.fontSize).toBe(expected);
      expect(result.effectiveHeight).toBe(
        contentHeight(opts.text, 300, expected),
      );
    },
  );

  it('resets width mode so legacy callbacks without start still fit the placeholder', () => {
    render({ fontSizing: 'resizable', text: '' });
    act(() => result.handleResizeStart('width'));
    act(() => result.handleResizeEnd(300, 150));
    act(() => result.handleResize(300, 150));
    const expected = computeFontSizeForHeight(
      opts.placeholder ?? 'Type...',
      268,
      134,
      opts.fontOpts,
    );
    expect(result.effectiveFontSize).toBe(expected);
    expect(result.effectiveHeight).toBe(150 - NODE_SHELL_INSET);
    fixture.node.style = { width: 300 };
    act(() => result.handleResizeEnd(300, 150));
    render({ width: 300 });
    expect(fixture.node.data.style.fontSize).toBe(expected);
    expect(result.effectiveHeight).toBe(contentHeight('', 300, expected));
  });

  it('preserves one-shot legacy height migration outside resize', () => {
    fixture.node.data.style = { fontWeight: 'bold' };
    fixture.node.style.height = 120;
    render();
    const expected = computeFontSizeForHeight(
      opts.text,
      300,
      104,
      opts.fontOpts,
    );
    expect(fixture.patchNodeSilent).toHaveBeenCalledExactlyOnceWith('text', {
      style: { fontWeight: 'bold', fontSize: expected },
    });
    render({ text: 'Later editing' });
    expect(fixture.patchNodeSilent).toHaveBeenCalledTimes(1);
  });
});

describe('useTextNodeSurface resize bundle', () => {
  it('forwards width, scale and no-argument fit modes through the real sizing hook', () => {
    const value: UseTextNodeSurfaceOpts = {
      ...opts,
      content: opts.text,
      isEditing: true,
    };
    act(() => root.render(<SurfaceProbe value={value} />));
    expect(surface.nodeWrapperProps.resizeEndClearHeight).toBe(true);
    act(() => surface.nodeWrapperProps.onResizeStart('width'));
    act(() => surface.nodeWrapperProps.onResize(132, 9999));
    expect(surface.bodyProps.effectiveFontSize).toBe(20);
    expect(surface.bodyProps.effectiveHeight).toBe(
      contentHeight(opts.text, 132, 20),
    );
    act(() => surface.setDraft('Updated draft\n'));
    expect(surface.bodyProps.effectiveHeight).toBe(
      contentHeight('Updated draft\n', 132, 20),
    );
    act(() => surface.nodeWrapperProps.onResizeEnd(132, 9999));
    expect(fixture.patchNodeSilent).not.toHaveBeenCalled();

    act(() => surface.nodeWrapperProps.onResizeStart('scale'));
    act(() => surface.nodeWrapperProps.onResizeEnd(632, 1));
    expect(fixture.node.data.style.fontSize).toBe(40);
    act(() => surface.nodeWrapperProps.onResizeStart());
    act(() => surface.nodeWrapperProps.onResizeEnd(332, 120));
    expect(fixture.node.data.style.fontSize).toBe(
      computeFontSizeForHeight('Updated draft\n', 300, 104, opts.fontOpts),
    );
  });
});
