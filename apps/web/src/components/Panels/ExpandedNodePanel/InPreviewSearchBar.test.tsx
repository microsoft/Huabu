// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InPreviewSearchBar } from './InPreviewSearchBar';
import { usePreviewSearchStore } from '../../../store/previewSearchStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../hooks/useTextHighlight', () => ({
  useTextHighlight: () => ({ matchCount: 0 }),
}));

vi.mock('./PreviewSearchAdapterContext', () => ({
  usePreviewSearchAdapter: () => null,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  usePreviewSearchStore.getState().close();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('InPreviewSearchBar preview-search lifecycle', () => {
  it('is active while its node owns preview search', () => {
    usePreviewSearchStore.getState().open('pdf-1');
    usePreviewSearchStore.getState().setQuery('needle');

    act(() =>
      root.render(<InPreviewSearchBar scopeEl={null} nodeId="pdf-1" />),
    );

    expect(container.querySelector('input')?.value).toBe('needle');
  });

  it('resets the shared store when unmounted so a stale query cannot resurface', () => {
    usePreviewSearchStore.getState().open('pdf-1');
    usePreviewSearchStore.getState().setQuery('needle');
    act(() =>
      root.render(<InPreviewSearchBar scopeEl={null} nodeId="pdf-1" />),
    );

    act(() => root.unmount());

    expect(usePreviewSearchStore.getState()).toMatchObject({
      nodeId: null,
      query: '',
      isOpen: false,
    });
  });

  it('resets the shared store when the owning node changes', () => {
    usePreviewSearchStore.getState().open('pdf-1');
    usePreviewSearchStore.getState().setQuery('needle');
    act(() =>
      root.render(<InPreviewSearchBar scopeEl={null} nodeId="pdf-1" />),
    );

    act(() =>
      root.render(<InPreviewSearchBar scopeEl={null} nodeId="pdf-2" />),
    );

    expect(usePreviewSearchStore.getState()).toMatchObject({
      nodeId: null,
      query: '',
      isOpen: false,
    });
  });
});
