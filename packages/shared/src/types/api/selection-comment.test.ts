// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { agentRequestSchema, quotedCommentSchema } from './agent.js';

const quote = {
  quote: 'Passage',
  comment: 'Explain',
  contextBefore: '',
  contextAfter: '',
};
it('requires a user request or an authored comment, never a selection alone', () => {
  expect(
    agentRequestSchema.safeParse({
      content: '',
      quotedComments: [{ ...quote, comment: '' }],
    }).success,
  ).toBe(false);
  expect(
    agentRequestSchema.safeParse({
      content: 'Explain',
      quotedComments: [{ ...quote, comment: '' }],
    }).success,
  ).toBe(false);
  expect(
    agentRequestSchema.safeParse({
      content: '',
      quotedComments: [{ ...quote, comment: 'Explain' }],
    }).success,
  ).toBe(true);
});
it.each([{ pages: [] }, { pages: [0] }, { pages: [-1] }, { pages: [1.5] }])(
  'rejects invalid PDF page evidence $pages',
  ({ pages }) => {
    expect(
      quotedCommentSchema.safeParse({
        ...quote,
        source: { kind: 'pdf', canvasId: 'space', nodeId: 'pdf', pages },
      }).success,
    ).toBe(false);
  },
);
it('requires the original message identity for Chat quotations', () => {
  expect(
    quotedCommentSchema.safeParse({
      ...quote,
      source: { kind: 'chat', canvasId: 'space', threadId: 'thread' },
    }).success,
  ).toBe(false);
  expect(
    quotedCommentSchema.safeParse({
      ...quote,
      source: {
        kind: 'chat',
        canvasId: 'space',
        threadId: 'thread',
        messageId: 'message',
      },
    }).success,
  ).toBe(true);
});
