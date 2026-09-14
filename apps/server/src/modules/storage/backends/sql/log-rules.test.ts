// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';
import { z } from 'zod';

import { extractCanvasChanges } from '@huabu/shared/canvas-engine';

import { decodeChanges, decodeEvents, firstIssue } from './log-rules.js';
import { event } from './test-fixtures.js';
it('decodes ordered events and refuses malformed historical records', () => {
  expect(
    decodeEvents(
      [event('a'), event('b')].map((e) => ({ event_json: JSON.stringify(e) })),
    ),
  ).toEqual([event('a'), event('b')]);
  expect(() => decodeEvents([{ event_json: '{}' }])).toThrow(/event 1/);
  expect(() => decodeEvents([{ event_json: '{' }])).toThrow(SyntaxError);
});
it('reports schema paths and handles empty issue lists', () => {
  expect(firstIssue(new z.ZodError([]))).toBe('unknown schema violation');
  const parsed = z.object({ name: z.string() }).safeParse({ name: 1 });
  if (parsed.success) throw new Error('Expected invalid input');
  expect(firstIssue(parsed.error)).toMatch(/^name:/);
});
it('coalesces real engine changes and rejects non-array history', () => {
  const changes = extractCanvasChanges([
    {
      type: 'INSERT_NODE',
      node: {
        id: 'n',
        type: 'note',
        position: { x: 0, y: 0 },
        data: { label: 'N', content: 'body' },
      },
    },
  ]);
  expect(
    decodeChanges(JSON.stringify([...changes, ...changes]), 'space', 'thread'),
  ).toHaveLength(1);
  expect(() => decodeChanges('{}', 'space', 'thread')).toThrow(
    /must be an array/,
  );
});
