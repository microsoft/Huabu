// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { LanguageDescription, syntaxTree } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { hashSearchSource } from '@/hooks/useSearchSource';
import { usePreviewSearchStore } from '@/store/previewSearchStore';

import RawMarkdownEditor from './RawMarkdownEditor';
import { InPreviewSearchBar } from '../Panels/ExpandedNodePanel/InPreviewSearchBar';
import { PreviewSearchAdapterProvider } from '../Panels/ExpandedNodePanel/PreviewSearchAdapterContext';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 100, 80, 20),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  usePreviewSearchStore.getState().close();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('does not indent a readonly plain-text source with Tab', async () => {
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      <RawMarkdownEditor
        value="source text"
        readOnly
        plainText
        onChange={onChange}
      />,
    ),
  );
  const content = host.querySelector<HTMLElement>('.cm-content');
  if (!content) throw new Error('Missing source viewer');
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error('Missing CodeMirror view');
  await act(async () =>
    content.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true }),
    ),
  );
  expect(view.state.doc.toString()).toBe('source text');
  expect(onChange).not.toHaveBeenCalled();
});

it.each([false, true])(
  'reveals exact raw-source URL text without editing or focusing (%s)',
  async (readOnly) => {
    const value = '[needle](https://example.test/needle)\n\nParagraph needle';
    const onChange = vi.fn();
    const external = document.createElement('input');
    document.body.append(external);
    external.focus();
    usePreviewSearchStore.getState().reveal('raw-note', 'needle', 1, {
      hash: await hashSearchSource(value),
      offset: value.indexOf('needle', value.indexOf('https')),
      length: 6,
    });
    act(() =>
      root.render(
        <PreviewSearchAdapterProvider>
          <InPreviewSearchBar scopeEl={host} nodeId="raw-note" />
          <RawMarkdownEditor
            searchNodeId="raw-note"
            value={value}
            onChange={onChange}
            readOnly={readOnly}
          />
        </PreviewSearchAdapterProvider>,
      ),
    );
    await act(async () => {
      await vi.waitFor(() =>
        expect(usePreviewSearchStore.getState().navigationRequest).toBeNull(),
      );
    });
    expect(host.textContent).toContain('2/3');
    const content = host.querySelector<HTMLElement>('.cm-content');
    if (!content) throw new Error('Missing CodeMirror document');
    const view = EditorView.findFromDOM(content);
    expect(view?.state.doc.toString()).toBe(value);
    expect(view?.state.selection.main.head).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(external);
    external.remove();
  },
);

it.each([
  ['source.ts', 'const greeting: string = "hello";'],
  ['source.json', '{"greeting": "hello"}'],
  ['C:\\project\\source.py', 'greeting = "hello"'],
  ['source.cpp', 'const char* greeting = "hello";'],
  ['source.rs', 'let greeting = "hello";'],
])(
  'loads syntax for %s without replacing the editor, changing text or losing selection',
  async (filename, value) => {
    let view: EditorView | null = null;
    await act(async () =>
      root.render(
        <RawMarkdownEditor
          value={value}
          readOnly
          plainText
          onReady={(next) => {
            view = next;
          }}
        />,
      ),
    );
    const content = host.querySelector<HTMLElement>('.cm-content');
    if (!content) throw new Error('Missing source');
    const editor = EditorView.findFromDOM(content);
    if (!editor) throw new Error('Missing CodeMirror editor');
    await act(async () =>
      editor.dispatch({ selection: { anchor: 1, head: 4 } }),
    );
    await act(async () =>
      root.render(
        <RawMarkdownEditor
          value={value}
          readOnly
          plainText
          languageFilename={filename}
          onReady={(next) => {
            view = next;
          }}
        />,
      ),
    );
    await act(async () => {
      await vi.waitFor(() =>
        expect(syntaxTree(editor.state).toString()).toContain('String'),
      );
    });
    expect(view).toBe(editor);
    expect(editor.state.doc.toString()).toBe(value);
    expect(editor.state.selection.main.from).toBe(1);
    expect(editor.state.selection.main.to).toBe(4);
    expect(editor.state.readOnly).toBe(true);
  },
);

it('keeps unknown extensions readable without reporting a language failure', async () => {
  await act(async () =>
    root.render(
      <RawMarkdownEditor
        value="custom file text"
        readOnly
        plainText
        languageFilename="file.unknown402"
      />,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(host.querySelector('.cm-content')?.textContent).toBe(
    'custom file text',
  );
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('keeps the source readable and reports a failed language download', async () => {
  const failure = new Error('Language unavailable');
  vi.spyOn(LanguageDescription, 'matchFilename').mockReturnValue(
    LanguageDescription.of({
      name: 'Unavailable',
      load: async () => {
        throw failure;
      },
    }),
  );
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await act(async () =>
    root.render(
      <RawMarkdownEditor
        value="unmodified source"
        readOnly
        plainText
        languageFilename="source.py"
      />,
    ),
  );
  await act(async () => {
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')).not.toBeNull(),
    );
  });
  expect(host.querySelector('.cm-content')?.textContent).toBe(
    'unmodified source',
  );
  expect(log).toHaveBeenCalledWith('File syntax highlighting failed', failure);
});
