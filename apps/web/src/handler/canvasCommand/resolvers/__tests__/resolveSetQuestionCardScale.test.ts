// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  executeCanvasCommands,
  getNodeSize,
} from '@huabu/shared/canvas-engine';

import { getNodeFontFit } from '@/utils/node/fontFit';
import { QUESTION_NODE_DEFAULT_FONT_SIZE } from '@/utils/node/nodeFontConfig';

import { resolveUiIntent } from '../../uiIntent';
import { QUESTION_CARD_SCALE_RANGE } from '../resolveSetQuestionCardScale';

import type { Node } from '@xyflow/react';

const base = QUESTION_NODE_DEFAULT_FONT_SIZE;
const empty = { commands: [], trace: [] };

function question(extra: Partial<Node> = {}): Node {
  return {
    id: 'node-question',
    type: 'question',
    position: { x: 12.25, y: 40.75 },
    style: { width: 321.125 },
    data: { label: 'Question', style: { accent: 'teal', fontFamily: 'serif' } },
    ...extra,
  };
}

function resolve(node: Node | undefined, percent: number) {
  return resolveUiIntent(
    { type: 'SET_QUESTION_CARD_SCALE', nodeId: 'node-question', percent },
    { nodes: node ? [node] : [], edges: [] },
  );
}

function expectScale(node: Node, percent: number) {
  const before = structuredClone(node);
  const fontSize = (base * percent) / 100;
  const currentFont = getNodeFontFit(node)?.fontSize ?? base;
  const width = (getNodeSize(node).width * fontSize) / currentFont;
  const result = resolve(node, percent);
  expect(result.commands).toEqual([
    {
      type: 'MERGE_NODE_DATA',
      patches: [{ nodeId: node.id, patch: { style: { fontSize } } }],
    },
    {
      type: 'SET_NODE_GEOMETRY',
      items: [{ nodeId: node.id, size: { width, height: 'auto' } }],
    },
  ]);
  expect(result.trace).toEqual([
    {
      action: 'node_edited',
      node: { id: node.id, type: 'question', label: 'Question' },
    },
  ]);
  expect(node).toEqual(before);
  return result;
}

describe('SET_QUESTION_CARD_SCALE resolver', () => {
  it('uses the default title font when no override exists', () => {
    expectScale(question(), 200);
  });

  it.each([10, 33.333333333333336, 125.125, 1000])(
    'accepts absolute percentage %s, including fractional values and range endpoints',
    (percent) => {
      expectScale(
        question({
          data: { label: 'Question', style: { fontSize: base * 2 } },
        }),
        percent,
      );
    },
  );

  it('resets a scaled card to the default at 100%, not its current font', () => {
    expectScale(
      question({ data: { label: 'Question', style: { fontSize: base * 3 } } }),
      100,
    );
  });

  it('uses canonical measured outer width ahead of style and top-level width', () => {
    expectScale(
      question({ measured: { width: 407.123456789, height: 100 }, width: 999 }),
      137.123456789,
    );
  });

  it('supports canonical CSS width parsing when no measurement exists', () => {
    expectScale(question({ style: { width: '305.625px' } }), 125);
  });

  it.each([undefined, null, 0, -1, NaN, Infinity, '42'])(
    'uses the existing effective-font fallback for %s',
    (fontSize) => {
      expectScale(
        question({ data: { label: 'Question', style: { fontSize } } }),
        150,
      );
    },
  );

  it.each([
    NaN,
    Infinity,
    -Infinity,
    0,
    -10,
    9.999999,
    1000.000001,
    undefined,
    null,
    '100',
  ])(
    'rejects invalid or out-of-range input %s instead of clamping',
    (percent) => {
      expect(resolve(question(), percent as number)).toEqual(empty);
    },
  );

  it('exports the same inclusive limits used by the resolver', () => {
    expect(QUESTION_CARD_SCALE_RANGE).toEqual({ min: 10, max: 1000 });
  });

  it.each(['text', 'note', 'frame', undefined])(
    'rejects a live %s node even with Question data',
    (type) => {
      expect(
        resolve(question({ type, data: { type: 'question' } }), 200),
      ).toEqual(empty);
    },
  );

  it('rejects a missing node', () => {
    expect(resolve(undefined, 200)).toEqual(empty);
  });

  it.each([undefined, 0, -1, NaN, Infinity])(
    'rejects unusable outer width %s',
    (width) => {
      expect(resolve(question({ style: { width } }), 200)).toEqual(empty);
    },
  );

  it('rejects overflowing computed geometry', () => {
    expect(
      resolve(question({ style: { width: Number.MAX_VALUE } }), 1000),
    ).toEqual(empty);
  });

  it('returns no commands or trace for the effective default and exact current scale', () => {
    expect(resolve(question(), 100)).toEqual(empty);
    const percent = 137.123456789;
    expect(
      resolve(
        question({ data: { style: { fontSize: (base * percent) / 100 } } }),
        percent,
      ),
    ).toEqual(empty);
  });

  it('retains exact arithmetic over successive executions and makes repeats strict no-ops', () => {
    let node = question({ measured: { width: 407.123456789, height: 100 } });
    for (const percent of [
      137.123456789, 233.33333333333334, 10, 1000, 100, 137.123456789,
    ]) {
      const previousFont = getNodeFontFit(node)?.fontSize ?? base;
      const expectedFont = (base * percent) / 100;
      const expectedWidth =
        (getNodeSize(node).width * expectedFont) / previousFont;
      const result = expectScale(node, percent);
      const output = executeCanvasCommands(
        { commands: result.commands },
        { canvasId: 'question-scale-test', nodes: [node], edges: [] },
      );
      node = output.writeResult.nodes[0];
      expect(node.data.style).toEqual({
        accent: 'teal',
        fontFamily: 'serif',
        fontSize: expectedFont,
      });
      expect(node.style?.width).toBe(expectedWidth);
      expect(node.measured?.width).toBe(expectedWidth);
      expect(node.style?.height).toBeUndefined();
      expect(resolve(node, percent)).toEqual(empty);
    }
  });
});
