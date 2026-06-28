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
  extractAgentNodePreview,
  NODE_PREVIEW_MAX_LENGTH,
} from './node-ref.js';

describe('extractAgentNodePreview', () => {
  it('flattens multi-line markdown summary to a single line', () => {
    const preview = extractAgentNodePreview({
      id: 'n1',
      type: 'note',
      summary: '# Heading\n\n- bullet one\n- bullet two',
    });
    expect(preview).toBe('# Heading - bullet one - bullet two');
    expect(preview).not.toContain('\n');
  });

  it('falls back to content when summary is absent, collapsing whitespace', () => {
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

  it('uses src as the last-resort preview (trimmed, not flattened further)', () => {
    const preview = extractAgentNodePreview({
      id: 'n1',
      type: 'image',
      src: '  https://example.com/a.png  ',
    });
    expect(preview).toBe('https://example.com/a.png');
  });

  it('prefers summary over content over src', () => {
    expect(
      extractAgentNodePreview({
        id: 'n1',
        type: 'note',
        summary: 'S',
        content: 'C',
        src: 'X',
      }),
    ).toBe('S');
    expect(
      extractAgentNodePreview({
        id: 'n1',
        type: 'note',
        content: 'C',
        src: 'X',
      }),
    ).toBe('C');
  });

  it('returns undefined when nothing meaningful is available', () => {
    expect(
      extractAgentNodePreview({ id: 'n1', type: 'note', content: '   ' }),
    ).toBeUndefined();
  });
});
