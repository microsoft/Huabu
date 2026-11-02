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
        'contains excerpts',
      );
    },
  );

  it.each([6001, 200_001])(
    'bounds unstructured input of %i characters using both ends',
    (length) => {
      const content = 'START ' + 'x'.repeat(length) + ' END';
      const source = sourceOf(content);
      expect(source.length).toBeLessThanOrEqual(6000);
      expect(source).toMatch(/^START /);
      expect(source).toMatch(/ END$/);
      expect(buildContentEnrichPrompt(content)).toContain(
        'contains excerpts, not the full document',
      );
      expect(buildContentEnrichPrompt(content)).toContain(
        'do not infer missing findings',
      );
    },
  );

  it('selects numbered English sections beyond the introduction and shares the budget', () => {
    const content =
      '# Background\n' +
      'irrelevant '.repeat(1000) +
      '\n## Abstract\nABSTRACT ' +
      'a'.repeat(7000) +
      '\n## 6 Results and Discussion\nFINDINGS ' +
      'r'.repeat(7000) +
      '\n## 7.2 **Limitations**\nCAVEATS ' +
      'l'.repeat(7000) +
      '\n## 8 Conclusion\nCONCLUSION ' +
      'c'.repeat(7000) +
      '\n## References\nDO NOT INCLUDE REFERENCES';
    const source = sourceOf(content);
    expect(source.length).toBeLessThanOrEqual(6000);
    for (const text of ['ABSTRACT', 'FINDINGS', 'CAVEATS', 'CONCLUSION']) {
      expect(source).toContain(text);
    }
    expect(source).not.toContain('irrelevant');
    expect(source).not.toContain('DO NOT INCLUDE REFERENCES');
  });

  it('recognizes Chinese and setext headings and redistributes short-section space', () => {
    const content =
      '# 正文\n' +
      '背景'.repeat(4000) +
      '\n\n摘要\n====\n简短摘要\n\n## 二、研究结果\n结果正文 ' +
      '证据'.repeat(4000) +
      '\n## 三、局限性\n小样本限制\n## 四、结论\n尚待验证\n## 附录\n不选附录';
    const source = sourceOf(content);
    expect(source.length).toBeLessThanOrEqual(6000);
    for (const text of ['简短摘要', '结果正文', '小样本限制', '尚待验证']) {
      expect(source).toContain(text);
    }
    expect(source.length).toBeGreaterThan(5900);
    expect(source).not.toContain('不选附录');
  });

  it('retains subsections until the next peer heading without duplicating selected nested sections', () => {
    const content =
      '# Introduction\n' +
      'x'.repeat(7000) +
      '\n## Results\nMAIN RESULT\n### Details\nDETAIL RESULT\n### Limitations\nUNIQUE CAVEAT\n## Appendix\nEXCLUDED';
    const source = sourceOf(content);
    expect(source).toContain('MAIN RESULT');
    expect(source).toContain('DETAIL RESULT');
    expect(source.match(/UNIQUE CAVEAT/g)).toHaveLength(1);
    expect(source).not.toContain('EXCLUDED');
  });

  it('ignores code-block headings and empty sections and falls back to both ends', () => {
    const content =
      'START\n```\n## Conclusion\nFAKE\n```\n' +
      'x'.repeat(8000) +
      '\n## Conclusion\n\n## Appendix\nEND';
    const source = sourceOf(content);
    expect(source).toMatch(/^START/);
    expect(source).toMatch(/END$/);
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
