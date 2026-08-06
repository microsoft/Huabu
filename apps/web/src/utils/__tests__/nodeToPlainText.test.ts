// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { nodesToPlainText } from '../io/nodeToPlainText';

describe('nodesToPlainText', () => {
  it('uses the body of content-bearing nodes', () => {
    expect(
      nodesToPlainText([
        { type: 'note', data: { content: '# Heading\n\nBody' } },
      ]),
    ).toBe('# Heading\n\nBody');
    expect(
      nodesToPlainText([{ type: 'text', data: { content: 'Plain' } }]),
    ).toBe('Plain');
    expect(
      nodesToPlainText([{ type: 'question', data: { content: 'Why?' } }]),
    ).toBe('Why?');
  });

  it('uses the url of a web node and the label of file-backed nodes', () => {
    expect(
      nodesToPlainText([
        { type: 'web', data: { src: 'https://example.com', label: 'Example' } },
      ]),
    ).toBe('https://example.com');
    expect(
      nodesToPlainText([
        { type: 'pdf', data: { src: 'a.pdf', label: 'Paper' } },
      ]),
    ).toBe('Paper');
  });

  it('produces nothing for nodes without a textual form', () => {
    expect(
      nodesToPlainText([
        { type: 'image', data: { src: 'a.png', label: 'Pic' } },
      ]),
    ).toBe('');
    expect(
      nodesToPlainText([{ type: 'sketch', data: { label: 'Doodle' } }]),
    ).toBe('');
    expect(nodesToPlainText([{ type: 'nodeRef', data: {} }])).toBe('');
  });

  it('joins a multi-node selection and drops the textless nodes', () => {
    expect(
      nodesToPlainText([
        { type: 'note', data: { content: 'First' } },
        { type: 'image', data: { src: 'a.png' } },
        { type: 'web', data: { src: 'https://example.com' } },
      ]),
    ).toBe('First\n\nhttps://example.com');
  });

  it('ignores missing, blank, and non-string fields', () => {
    expect(
      nodesToPlainText([
        { type: 'note', data: { content: '   ' } },
        { type: 'note', data: {} },
        { type: 'note' },
        { type: 'text', data: { content: 42 } },
      ]),
    ).toBe('');
  });
});
