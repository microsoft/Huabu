// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { agentRequestSchema } from '@huabu/shared';

import { renderQuotedComments } from './quoted-comments.js';

it('preserves PDF page evidence and an authored comment alongside the user task', () => {
  const request = agentRequestSchema.parse({
    content: 'Explain this',
    quotedComments: [
      {
        quote: 'captured <passage>',
        comment: 'Explain the passage',
        contextBefore: '',
        contextAfter: '',
        source: {
          kind: 'pdf',
          canvasId: 'space',
          nodeId: 'pdf<&',
          pages: [1, 2],
        },
      },
    ],
  });
  const text = renderQuotedComments(request.quotedComments);
  expect(text).toContain('<kind>pdf</kind>');
  expect(text).toContain('<pages>1, 2</pages>');
  expect(text).toContain('<node_id>pdf&lt;&amp;</node_id>');
  expect(text).toContain('<quote>captured &lt;passage&gt;</quote>');
  expect(text).not.toContain('earlier assistant reply');
});

it('preserves a cross-conversation Chat quotation identity', () => {
  const request = agentRequestSchema.parse({
    content: 'Compare',
    quotedComments: [
      {
        quote: 'answer',
        comment: 'Compare this answer',
        contextBefore: '',
        contextAfter: '',
        source: {
          kind: 'chat',
          canvasId: 'space',
          threadId: 'source-thread',
          messageId: 'source-message',
        },
      },
    ],
  });
  expect(renderQuotedComments(request.quotedComments)).toContain(
    '<thread_id>source-thread</thread_id>',
  );
  expect(renderQuotedComments(request.quotedComments)).toContain(
    '<message_id>source-message</message_id>',
  );
});
