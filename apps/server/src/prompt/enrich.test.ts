// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { buildContentEnrichPrompt } from './enrich.js';

describe('content summary guidance', () => {
  it('requests bounded, conclusion-first paragraphs or lists in the existing string field', () => {
    const prompt = buildContentEnrichPrompt('Friday arrival. Sunday return.');
    expect(prompt).toContain('"summary": a compact Markdown string');
    expect(prompt).toContain('at most 400 characters');
    expect(prompt).toContain('not introducing or describing the document');
    expect(prompt).toContain('paragraphs or 2-4 bullet/numbered items');
    expect(prompt).toContain('Preserve important uncertainty');
    expect(prompt).toContain('ONLY valid JSON');
  });

  it('does not ask for a summary when the capability is disabled', () => {
    const prompt = buildContentEnrichPrompt('Content', { needSummary: false });
    expect(prompt).not.toContain('"summary"');
    expect(prompt).toContain('"label"');
    expect(prompt).toContain('"keywords"');
  });

  function sourceOf(content: string) {
    const prompt = buildContentEnrichPrompt(content);
    return prompt
      .split('Content:\n')[1]
      .split('\n\nAnalyze the above content')[0];
  }

  it.each([0, 5999, 6000])(
    'preserves a short source of %i characters verbatim',
    (length) => {
      const content = 'x'.repeat(length);
      expect(sourceOf(content)).toBe(content);
      expect(buildContentEnrichPrompt(content)).not.toContain(
        'opening excerpt',
      );
    },
  );

  it.each([6001, 200_001])(
    'bounds input of %i characters using only its opening',
    (length) => {
      const content = 'START ' + 'x'.repeat(length) + ' END';
      const source = sourceOf(content);
      expect(source.length).toBeLessThanOrEqual(6000);
      expect(source).toMatch(/^START /);
      expect(source).toBe(content.slice(0, 5999) + '…');
      expect(source).not.toContain('END');
      expect(buildContentEnrichPrompt(content)).toContain(
        'opening excerpt, not the full document',
      );
      expect(buildContentEnrichPrompt(content)).toContain(
        'do not infer missing findings',
      );
    },
  );

  it('does not select or rearrange sections based on headings', () => {
    const content =
      '# Abstract\nOpening evidence\n## Introduction\n' +
      'background '.repeat(1000) +
      '\n## Results\nLATE FINDINGS\n### Limitations\nLATE CAVEATS\n### Replication\nLATE REPLICATION';
    const source = sourceOf(content);
    expect(source).toBe(content.slice(0, 5999) + '…');
    expect(source).toContain('Opening evidence');
    expect(source).not.toContain('LATE');
  });

  it('does not split surrogate pairs at excerpt boundaries', () => {
    const source = sourceOf('😀'.repeat(4000));
    expect(source.length).toBeLessThanOrEqual(6000);
    expect(() => encodeURIComponent(source)).not.toThrow();
  });

  it('retains the existing input budget for metadata that does not request a summary', () => {
    const content = 'x'.repeat(200_001) + 'excluded tail';
    const prompt = buildContentEnrichPrompt(content, { needSummary: false });
    expect(prompt).toContain('x'.repeat(4000) + '…');
    expect(prompt).not.toContain('excluded tail');
  });
});
