// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { splitMarkdownFrontmatter } from './markdownFrontmatter';

describe('splitMarkdownFrontmatter', () => {
  it('splits leading YAML frontmatter with nested, list, and multiline values from the Markdown body', () => {
    const markdown = [
      '---',
      'title: Design Guide',
      'tags:',
      '  - markdown',
      '  - preview',
      'meta:',
      '  owner: team',
      'summary: |',
      '  First paragraph',
      '  ---',
      '  Second paragraph after indented dashes',
      '---',
      '',
      '# Heading',
      '',
      'Body paragraph.',
    ].join('\n');

    expect(splitMarkdownFrontmatter(markdown)).toEqual({
      frontmatter: [
        'title: Design Guide',
        'tags:',
        '  - markdown',
        '  - preview',
        'meta:',
        '  owner: team',
        'summary: |',
        '  First paragraph',
        '  ---',
        '  Second paragraph after indented dashes',
      ].join('\n'),
      body: '\n# Heading\n\nBody paragraph.',
    });
  });

  it('recognizes frontmatter after a UTF-8 BOM and normalizes CRLF and CR line endings', () => {
    const crlf =
      '\uFEFF---  \r\ntitle: Hello\r\nauthor: Alice\r\n---\t\r\n# Body\r\n';
    expect(splitMarkdownFrontmatter(crlf)).toEqual({
      frontmatter: 'title: Hello\nauthor: Alice',
      body: '# Body\r\n',
    });

    const bareCr = '---\rtitle: Classic\r---\rParagraph';
    expect(splitMarkdownFrontmatter(bareCr)).toEqual({
      frontmatter: 'title: Classic',
      body: 'Paragraph',
    });
  });

  it('supports empty frontmatter blocks and frontmatter-only files', () => {
    expect(splitMarkdownFrontmatter('---\n---\n# Title')).toEqual({
      frontmatter: '',
      body: '# Title',
    });

    expect(splitMarkdownFrontmatter('---\nid: node-1\n---')).toEqual({
      frontmatter: 'id: node-1',
      body: '',
    });
  });

  it('keeps malformed YAML inside closed fences readable without throwing', () => {
    const malformed = '---\ntitle: [unclosed\ncolon: a: b\n---\n# Body';
    expect(splitMarkdownFrontmatter(malformed)).toEqual({
      frontmatter: 'title: [unclosed\ncolon: a: b',
      body: '# Body',
    });
  });

  it('leaves unterminated fences, ordinary horizontal rules, four-dash rules, and fenced YAML blocks untouched', () => {
    const unterminated = '---\ntitle: Missing closing fence\n\n# Heading';
    expect(splitMarkdownFrontmatter(unterminated)).toEqual({
      frontmatter: null,
      body: unterminated,
    });

    const leadingBlankLine = '\n---\ntitle: Not leading\n---\n# Heading';
    expect(splitMarkdownFrontmatter(leadingBlankLine)).toEqual({
      frontmatter: null,
      body: leadingBlankLine,
    });

    const bodyHorizontalRules = '# Heading\n\n---\n\nSection\n\n---\n';
    expect(splitMarkdownFrontmatter(bodyHorizontalRules)).toEqual({
      frontmatter: null,
      body: bodyHorizontalRules,
    });

    const fourDashes = '----\ntitle: Thematic break\n----\n# Heading';
    expect(splitMarkdownFrontmatter(fourDashes)).toEqual({
      frontmatter: null,
      body: fourDashes,
    });

    const fencedYaml = '```yaml\ntitle: Code block\n```\n\n# Heading';
    expect(splitMarkdownFrontmatter(fencedYaml)).toEqual({
      frontmatter: null,
      body: fencedYaml,
    });
  });
});
