import { describe, expect, it } from 'vitest';

import { buildNoteDragPayload } from '../MilkdownMessageCard';

describe('buildNoteDragPayload', () => {
  it('returns null for empty markdown', () => {
    expect(buildNoteDragPayload('', 'thread-1')).toBeNull();
  });

  it('returns null for whitespace-only markdown', () => {
    expect(buildNoteDragPayload('   \n\t  ', 'thread-1')).toBeNull();
  });

  it('builds a note payload with trimmed markdown', () => {
    const result = buildNoteDragPayload('  hello\n\n', 'thread-abc');
    expect(result).not.toBeNull();
    expect(result?.payload).toEqual({
      kind: 'note',
      origin: { type: 'user-from-chat', threadId: 'thread-abc' },
      data: { content: 'hello' },
    });
  });

  it('does NOT populate the deprecated contentJson field', () => {
    const result = buildNoteDragPayload('hello', 'thread-1');
    expect(result?.payload.data).not.toHaveProperty('contentJson');
  });

  it('preserves multi-line block structure', () => {
    const markdown = '## Heading\n\n- item one\n- item two\n';
    const result = buildNoteDragPayload(markdown, 'thread-1');
    expect(result?.payload.data.content).toBe(
      '## Heading\n\n- item one\n- item two',
    );
  });

  it('preserves code fences verbatim', () => {
    const markdown = '```ts\nconst x = 1;\n```\n';
    const result = buildNoteDragPayload(markdown, 'thread-1');
    expect(result?.payload.data.content).toBe('```ts\nconst x = 1;\n```');
  });
});
