// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { stripMarkdown } from './markdown.js';

describe('stripMarkdown', () => {
  it.each([
    ['Read `use_agent_stream.ts`', 'Read use_agent_stream.ts'],
    ['Use `Array<T>`', 'Use Array<T>'],
    ['Read use_agent_stream.ts', 'Read use_agent_stream.ts'],
    ['**Use `Array<T>` and `__key__`**', 'Use Array<T> and __key__'],
    ['``literal `backticks` and *stars*``', 'literal `backticks` and *stars*'],
    [
      '```ts\nconst use_agent_stream: Array<T> = [];\n```',
      'const use_agent_stream: Array<T> = [];',
    ],
    ['~~~html\n<div>**literal**</div>\n~~~', '<div>**literal**</div>'],
    ['````md\n```\n# literal\n````', '```\n# literal'],
    ['```ts\nArray<T>\nuse_agent_stream.ts', 'Array<T>\nuse_agent_stream.ts'],
    ['`use_agent_stream', '`use_agent_stream'],
    ['    Array<T>\n    use_agent_stream.ts', 'Array<T>\nuse_agent_stream.ts'],
    [
      'Before\n\n```txt\none\n\n\nfour\n```\n\nAfter',
      'Before\n\none\n\n\nfour\n\nAfter',
    ],
    [
      '# Heading\nBody **bold**, *italic*, ~~old~~ and [docs](https://example.com).',
      'Heading\nBody bold, italic, old and docs.',
    ],
    ['> - Reviewing ~~old~~ *results*', 'Reviewing old results'],
    ['![caption](image.png)\n\nNext', 'caption\n\nNext'],
    ['Read [docs][ref]\n\n[ref]: https://example.com', 'Read docs'],
    ['<b>bold</b> and <i>italic</i>', 'bold and italic'],
    ['<div>hello <b>world</b></div>', 'hello world'],
    ['<div><<b>script>alert(1)<</b>/script></div>', 'alert(1)'],
    ['`<script>alert(1)</script>`', '<script>alert(1)</script>'],
    ['```html\n<script>alert(1)</script>\n```', '<script>alert(1)</script>'],
    ['First\nSecond\n\nThird\n\n\nFourth', 'First\nSecond\n\nThird\n\nFourth'],
    ['- First\n- Second', 'First\nSecond'],
    ['- [x] Done\n- [ ] Pending', '[x] Done\n[ ] Pending'],
    ['---\n\n***', ''],
    ['', ''],
    [' \n\t ', ''],
  ])('projects %j without corrupting its content', (input, expected) => {
    expect(stripMarkdown(input)).toBe(expected);
  });
});
