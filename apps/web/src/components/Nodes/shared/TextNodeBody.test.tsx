// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Regression tests for the text body's box geometry.
 *
 * The bug this guards against has been reintroduced more than once: the
 * body was sized to the node's OUTER width while `useTextAutoSize`
 * measured the text at `width - 2 * paddingX`. Any drift between those
 * two widths makes the measurement count a line as wrapped that the
 * browser keeps on one line, and the node then reserves a line of height
 * that renders empty.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { NODE_SHELL_INSET } from '@huabu/shared/canvas-engine';

import {
  TEXT_NODE_PADDING_X,
  TEXT_NODE_PADDING_Y,
} from '@/utils/node/nodeFontConfig';
import { measureTextHeight, type FontOpts } from '@/utils/node/textMeasure';

import { resolveTextBodyBox, TextNodeBody } from './TextNodeBody';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const fontOpts: FontOpts = {
  fontFamily: 'sans-serif',
  fontWeight: 'normal',
  fontStyle: 'normal',
  lineHeight: 1.5,
};

/** Width the text is laid out at, given the node's outer geometry. */
function renderedTextWidth(outerWidth: number): number {
  const box = resolveTextBodyBox({
    width: outerWidth,
    height: 100,
    paddingX: TEXT_NODE_PADDING_X,
    paddingY: TEXT_NODE_PADDING_Y,
  });
  return box.width - box.paddingX * 2;
}

/** Width `useTextAutoSize` measures at, given the node's outer geometry. */
function measuredTextWidth(outerWidth: number): number {
  return outerWidth - TEXT_NODE_PADDING_X * 2;
}

describe('resolveTextBodyBox', () => {
  it('fits inside the node shell instead of overflowing it', () => {
    const box = resolveTextBodyBox({
      width: 200,
      height: 120,
      paddingX: TEXT_NODE_PADDING_X,
      paddingY: TEXT_NODE_PADDING_Y,
    });

    expect(box.width).toBe(200 - NODE_SHELL_INSET);
  });

  it('leaves the content-driven axis alone', () => {
    // Only the width is pinned by React Flow. The shell has no height of
    // its own, so correcting the height would just tighten every node.
    const box = resolveTextBodyBox({
      width: 200,
      height: 120,
      paddingX: TEXT_NODE_PADDING_X,
      paddingY: TEXT_NODE_PADDING_Y,
    });

    expect(box.height).toBe(120);
    expect(box.paddingY).toBe(TEXT_NODE_PADDING_Y);
  });

  it('lays text out at exactly the width the measurement assumed', () => {
    for (const outerWidth of [80, 121, 200, 400]) {
      expect(renderedTextWidth(outerWidth)).toBe(measuredTextWidth(outerWidth));
    }
  });

  it('never produces a negative box or padding', () => {
    const box = resolveTextBodyBox({
      width: 2,
      height: 2,
      paddingX: 1,
      paddingY: 1,
    });

    expect(box).toEqual({ width: 0, height: 2, paddingX: 0, paddingY: 1 });
  });
});

describe('measurement / layout agreement', () => {
  // Guards the assertion above: prove that being off by the shell inset
  // is enough to change the line count, so the equality actually matters.
  it('over-counts lines when the measurement width is off by the shell inset', () => {
    // 'Frame Test' is 96px wide at 16px under the deterministic test
    // metric (`chars * size * 0.6`), so it fits 97px but not 91px.
    const text = 'Frame Test';
    const fontSize = 16;
    const outerWidth = 121;
    const width = renderedTextWidth(outerWidth);
    expect(width).toBe(97);

    const oneLine = measureTextHeight(text, width, fontSize, fontOpts);
    const narrowed = measureTextHeight(
      text,
      width - NODE_SHELL_INSET,
      fontSize,
      fontOpts,
    );

    expect(oneLine).toBe(Math.ceil(fontSize * fontOpts.lineHeight));
    expect(narrowed).toBe(oneLine * 2);
  });
});

describe('<TextNodeBody>', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  function render(): HTMLDivElement {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <TextNodeBody
          effectiveWidth={200}
          effectiveHeight={120}
          effectiveFontSize={16}
          paddingX={TEXT_NODE_PADDING_X}
          paddingY={TEXT_NODE_PADDING_Y}
          draft="Frame Test"
          onChange={() => {}}
          onBlur={() => {}}
          isEditing={false}
          placeholder="Type..."
          fontFamily="sans-serif"
        />,
      );
    });
    return container.firstElementChild as HTMLDivElement;
  }

  it('writes the shell-inset box onto the container', () => {
    const body = render();

    expect(body.style.width).toBe(`${200 - NODE_SHELL_INSET}px`);
    expect(body.style.height).toBe('120px');
    expect(body.style.paddingLeft).toBe(
      `${TEXT_NODE_PADDING_X - NODE_SHELL_INSET / 2}px`,
    );
    expect(body.style.paddingTop).toBe(`${TEXT_NODE_PADDING_Y}px`);
  });

  it('keeps the read-only mirror padding in sync with the container', () => {
    const body = render();
    const mirror = body.querySelector<HTMLDivElement>('[aria-hidden="true"]');

    expect(mirror).not.toBeNull();
    expect(mirror!.style.paddingLeft).toBe(body.style.paddingLeft);
    expect(mirror!.style.paddingTop).toBe(body.style.paddingTop);
  });
});
