// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { noteFarDescription } from './noteFarDescription';

describe('noteFarDescription', () => {
  it.each([
    '![tmux 代表图](art_tmux.png)',
    '![tmux 代表图](images/tmux(v2).png "Preview")',
    '![tmux 代表图][cover]\n\n[cover]: art_tmux.png',
    '![cover]\n\n[cover]: art_tmux.png',
    '<figure><img src="tmux.png" alt="tmux 代表图"><figcaption>tmux 代表图</figcaption></figure>',
  ])('skips image labels and selects the following body: %s', (image) => {
    expect(
      noteFarDescription(
        `# tmux\n\n${image}\n\n管理多个终端会话，支持分屏与会话恢复。`,
        'tmux',
      ),
    ).toBe('管理多个终端会话，支持分屏与会话恢复。');
    expect(noteFarDescription(image, 'tmux')).toBeUndefined();
  });

  it('preserves body text beside an image without including its alt', () => {
    expect(
      noteFarDescription('![代表图](tmux.png)\n管理多个终端会话。', 'tmux'),
    ).toBe('管理多个终端会话。');
    expect(
      noteFarDescription('Before ![preview](image.png) after.', 'Title'),
    ).toBe('Before after.');
  });

  it.each([
    '',
    ' \n\t ',
    '# Title',
    '## Other heading\n\n# Title',
    'Title\n===',
    '---\n\n***',
  ])('omits empty or heading-only content: %j', (markdown) => {
    expect(noteFarDescription(markdown, 'Title')).toBeUndefined();
  });

  it('skips headings and repeated titles while retaining later prose paragraphs', () => {
    expect(
      noteFarDescription(
        '# Title\n\n**TITLE:**\n\nFirst **useful** paragraph.\nContinues here.\n\nLater paragraph.',
        'Title',
      ),
    ).toBe('First useful paragraph. Continues here. Later paragraph.');
  });

  it('keeps prose immediately after ATX and setext headings', () => {
    expect(noteFarDescription('## Heading\nUseful prose.', 'Title')).toBe(
      'Useful prose.',
    );
    expect(noteFarDescription('Heading\n---\nUseful prose.', 'Title')).toBe(
      'Useful prose.',
    );
  });

  it('normalizes whitespace and inline formatting using the shared stripper', () => {
    expect(
      noteFarDescription(
        '  Read [the guide](https://example.com) with `code` and <b>bold</b>.\r\nNext line.\r\n\r\nLater.',
        'Title',
      ),
    ).toBe('Read the guide with code and bold. Next line. Later.');
  });

  it.each(['## Code\n    const x = 1;', 'Code\n===\n\tconst x = 1;'])(
    'skips code immediately after headings: %j',
    (block) => {
      expect(
        noteFarDescription(`Intro prose.\n\n${block}\n\nLater prose.`, 'Title'),
      ).toBe('Intro prose. Later prose.');
      expect(noteFarDescription(block, 'Title')).toBeUndefined();
    },
  );

  it('skips fenced code with blank lines, longer fences, and tilde fences', () => {
    expect(
      noteFarDescription(
        '````md\n```\n\nNot prose\n````\n\n~~~js\nconst x = 1;\n~~~\n\nActual prose.',
        'Title',
      ),
    ).toBe('Actual prose.');
  });

  it('does not expose an unclosed code block as prose', () => {
    expect(
      noteFarDescription(
        '# Title\n\n```js\nconst x = 1;\n\nStill code.',
        'Title',
      ),
    ).toBeUndefined();
  });

  it.each(['    const x = 1;', '\tconst x = 1;'])(
    'skips indented code: %j',
    (block) => {
      expect(noteFarDescription(`${block}\n\nActual prose.`, 'Title')).toBe(
        'Actual prose.',
      );
      expect(noteFarDescription(block, 'Title')).toBeUndefined();
    },
  );

  it.each([
    ['- First\n  continuation\n- Second', 'First continuation Second'],
    ['## Tasks\n- First\n- Second', 'First Second'],
    ['Tasks\n---\n1. First\n2. Second', 'First Second'],
    ['- [ ] Pending\n- [x] Done', 'Pending Done'],
    ['- Item.\n\n  List continuation.', 'Item. List continuation.'],
    ['10. Item.\n\n    List continuation.', 'Item. List continuation.'],
    ['- Parent\n  - Child\n    - Grandchild', 'Parent Child Grandchild'],
  ])('retains list text without markers: %j', (block, expected) => {
    expect(
      noteFarDescription(`Intro prose.\n\n${block}\n\nLater prose.`, 'Title'),
    ).toBe(`Intro prose. ${expected} Later prose.`);
  });

  it('excludes nested list code while retaining following list paragraphs', () => {
    expect(
      noteFarDescription(
        '- Item.\n\n  ```js\n  hidden();\n  ```\n\n  Continuation.\n\n      indented();\n\n  - Child with `inline` code.',
        'Title',
      ),
    ).toBe('Item. Continuation. Child with inline code.');
  });

  it('preserves Chinese prose and skips a repeated Chinese title', () => {
    expect(
      noteFarDescription(
        '# 研究计划\n\n**研究计划**。\n\n通过访谈理解协作过程。\n\n后续安排。',
        '研究计划',
      ),
    ).toBe('通过访谈理解协作过程。 后续安排。');
  });

  it('does not discard prose just because it begins with the title', () => {
    expect(
      noteFarDescription(
        'Project plan explains the next steps.',
        'Project plan',
      ),
    ).toBe('Project plan explains the next steps.');
  });
});
