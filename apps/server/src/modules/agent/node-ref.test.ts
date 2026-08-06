// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the node-reference preview ladder.
 *
 * The preview line is dropped verbatim into single-line containers —
 * most visibly the node-neighbourhood list (`- "label" [type] —
 * <preview>`). A multi-line preview would spawn spurious list items /
 * headings there, so {@link extractAgentNodePreview} must flatten
 * whitespace (including newlines) to single spaces and truncate to the
 * 120-char budget.
 */

import { describe, expect, it } from 'vitest';

import {
  buildAgentNodePreview,
  extractAgentNodePreview,
  NODE_PREVIEW_MAX_LENGTH,
} from './node-ref.js';

describe('extractAgentNodePreview', () => {
  it('flattens a multi-line markdown body to a single line', () => {
    const preview = extractAgentNodePreview({
      id: 'n1',
      type: 'note',
      content: '# Heading\n\n- bullet one\n- bullet two',
    });
    expect(preview).toBe('# Heading - bullet one - bullet two');
    expect(preview).not.toContain('\n');
  });

  it('uses content, collapsing whitespace', () => {
    const preview = extractAgentNodePreview({
      id: 'n1',
      type: 'note',
      content: 'line one\n\n\tline two   line three',
    });
    expect(preview).toBe('line one line two line three');
  });

  it('truncates the flattened preview to the 120-char cap', () => {
    const long = 'word '.repeat(60); // 300 chars before flatten/truncate
    const preview = extractAgentNodePreview({
      id: 'n1',
      type: 'note',
      content: long,
    });
    expect(preview).toHaveLength(NODE_PREVIEW_MAX_LENGTH);
    expect(preview).not.toContain('\n');
  });

  it('does NOT use summary — summary is its own field, not the preview', () => {
    expect(
      extractAgentNodePreview({ id: 'n1', type: 'note', summary: 'S' }),
    ).toBeUndefined();
  });

  it('does NOT fall back to src — a bare URL is not a content preview', () => {
    expect(
      extractAgentNodePreview({
        id: 'n1',
        type: 'image',
        src: 'https://example.com/a.png',
      }),
    ).toBeUndefined();
  });

  it('returns undefined when nothing meaningful is available', () => {
    expect(
      extractAgentNodePreview({ id: 'n1', type: 'note', content: '   ' }),
    ).toBeUndefined();
  });
});

describe('buildAgentNodePreview: summary and preview are independent fields', () => {
  it('emits summary and preview separately when both exist', () => {
    const node = buildAgentNodePreview({
      id: 'n1',
      type: 'note',
      summary: 'A crisp abstract',
      content: 'The full body text goes here.',
    });
    expect(node.summary).toBe('A crisp abstract');
    expect(node.preview).toBe('The full body text goes here.');
  });

  it('emits summary but no preview when there is no body', () => {
    const node = buildAgentNodePreview({
      id: 'n1',
      type: 'note',
      summary: 'Abstract only',
    });
    expect(node.summary).toBe('Abstract only');
    expect(node.preview).toBeUndefined();
  });

  it('emits preview but no summary when there is no summary', () => {
    const node = buildAgentNodePreview({
      id: 'n1',
      type: 'note',
      content: 'Body only',
    });
    expect(node.summary).toBeUndefined();
    expect(node.preview).toBe('Body only');
  });
});
