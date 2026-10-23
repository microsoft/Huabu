// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
