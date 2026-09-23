// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { FarZoomText } from './FarZoomText';

describe('shared far-zoom text renderer', () => {
  it('keeps long tokens with their punctuation and leaves CJK free to wrap', () => {
    const text =
      '研究 Supercalifragilisticexpialidocious，cafe\u0301 Agent’s_v2-next';
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(<FarZoomText text={text} />);
    expect(host.textContent).toBe(text);
    const words = [...host.querySelectorAll<HTMLElement>('[data-study-word]')];
    expect(words.map((word) => word.textContent)).toEqual([
      'Supercalifragilisticexpialidocious，',
      'cafe\u0301',
      'Agent’s_v2-next',
    ]);
    for (const word of words) {
      expect(word.style.display).toBe('');
      expect(word.style.whiteSpace).toBe('normal');
      expect(word.style.textOverflow).toBe('');
      expect(word.style.overflowWrap).toBe('anywhere');
      expect(word.style.wordBreak).toBe('normal');
    }
  });

  it.each([
    ['Jupyter: Operations', ['Jupyter:', 'Operations']],
    ['Omar - Research', ['Omar -', 'Research']],
    ['Jupyter : Operations', ['Jupyter :', 'Operations']],
    ['Omar — Research', ['Omar —', 'Research']],
    ['(Jupyter): Operations', ['(Jupyter):', 'Operations']],
    ['“Jupyter”：操作', ['“Jupyter”：']],
    ['中文，Jupyter；后文。', ['Jupyter；']],
  ])('binds punctuation without changing source text: %s', (text, expected) => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <FarZoomText text={text as string} />,
    );
    expect(host.textContent).toBe(text);
    expect(
      [...host.querySelectorAll('[data-study-word]')].map(
        (word) => word.textContent,
      ),
    ).toEqual(expected);
  });

  it('renders an empty string without a placeholder', () => {
    expect(renderToStaticMarkup(<FarZoomText text="" />)).toBe('');
  });
  it('binds only boundary characters, allowing the rest of a long word to wrap', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <FarZoomText text="(Jupyter): Operations - Research" />,
    );
    expect(
      [...host.querySelectorAll('[data-study-punctuation]')].map(
        (el) => el.textContent,
      ),
    ).toEqual(['(J', 'r):', 's -']);
    expect(host.textContent).toBe('(Jupyter): Operations - Research');
    expect(host.innerHTML).not.toContain('text-overflow');
  });

  it.each([
    ['((“cafe\u0301”))：\t—/·• Next', ['((“c', 'e\u0301”))：\t—/·•']],
    ['《Huabu》，中文；「Agent」！', ['《H', 'u》，', '「A', 't」！']],
    ['(A) “e\u0301”', ['(A', '“e\u0301']],
    ['Agent’s_v2-next---word!', ['d!']],
    ['word---中文', ['d---']],
    ['word_!', []],
    ['word \t, next\n中文', []],
    ['(中文) 😀 𝟙\u0301：\t/Next', ['𝟙\u0301：\t/']],
    ['(((中文 ““😀', []],
  ])(
    'preserves exact punctuation groups and whitespace: %s',
    (text, groups) => {
      const host = document.createElement('div');
      host.innerHTML = renderToStaticMarkup(<FarZoomText text={text} />);
      expect(host.textContent).toBe(text);
      const punctuation = [
        ...host.querySelectorAll<HTMLElement>('[data-study-punctuation]'),
      ];
      expect(punctuation.map((group) => group.textContent)).toEqual(groups);
      for (const group of punctuation) {
        expect(group.style.whiteSpace).toBe('nowrap');
      }
    },
  );

  it('handles long internal separators and unmatched opening runs in a bounded process', () => {
    const filename = resolve(
      dirname(fileURLToPath(import.meta.url)),
      'FarZoomText.tsx',
    );
    const require = createRequire(import.meta.url);
    // A process deadline can interrupt synchronous backtracking; a Vitest timer
    // cannot. This is a generous hang guard, not a machine-speed benchmark.
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
          const requireFromSource = require('node:module').createRequire(${JSON.stringify(filename)});
          const ts = require(${JSON.stringify(require.resolve('typescript'))});
          const source = require('node:fs').readFileSync(0, 'utf8');
          const compiled = ts.transpileModule(source, { compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          }}).outputText;
          const moduleExports = {};
          new Function('require', 'exports', compiled)(requireFromSource, moduleExports);
          const React = requireFromSource('react');
          const { renderToStaticMarkup } = requireFromSource('react-dom/server');
          const samples = [
            'left' + '-'.repeat(100_000) + 'right!',
            'left' + "'".repeat(100_000) + 'right!',
            '('.repeat(100_000) + '中文',
            'left' + ' \\t'.repeat(50_000) + ',中文',
          ];
          process.stdout.write(JSON.stringify(samples.map(text => ({
            text,
            markup: renderToStaticMarkup(React.createElement(moduleExports.FarZoomText, {text})),
          }))));
        `,
      ],
      {
        input: readFileSync(filename, 'utf8'),
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const samples: { text: string; markup: string }[] = JSON.parse(
      result.stdout,
    );
    expect(samples).toHaveLength(4);
    for (const [index, { text, markup }] of samples.entries()) {
      const host = document.createElement('div');
      host.innerHTML = markup;
      expect(host.textContent).toBe(text);
      expect(host.querySelectorAll('[data-study-word]')).toHaveLength(
        index === 2 ? 0 : 1,
      );
      expect(
        [...host.querySelectorAll('[data-study-punctuation]')].map(
          (group) => group.textContent,
        ),
      ).toEqual(index < 2 ? ['t!'] : []);
    }
  }, 15_000);
});
