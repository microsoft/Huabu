// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from 'vitest';

import { usePreviewSearchStore } from './previewSearchStore';
import { useSearchStore } from './searchStore';

describe('previewSearchStore', () => {
  beforeEach(() => {
    usePreviewSearchStore.getState().close();
    useSearchStore.getState().close();
  });

  it('owns preview query state without changing canvas search', () => {
    useSearchStore.setState({
      scope: { kind: 'canvas', canvasId: 'canvas-1' },
      query: 'canvas query',
    });

    usePreviewSearchStore.getState().open('pdf-1');
    usePreviewSearchStore.getState().setQuery('pdf query');

    expect(usePreviewSearchStore.getState()).toMatchObject({
      nodeId: 'pdf-1',
      query: 'pdf query',
      isOpen: true,
    });
    expect(useSearchStore.getState()).toMatchObject({
      scope: { kind: 'canvas', canvasId: 'canvas-1' },
      query: 'canvas query',
    });
  });

  it('resets query and ownership when closed', () => {
    usePreviewSearchStore.getState().open('pdf-1');
    usePreviewSearchStore.getState().setQuery('needle');

    usePreviewSearchStore.getState().close();

    expect(usePreviewSearchStore.getState()).toMatchObject({
      nodeId: null,
      query: '',
      isOpen: false,
    });
  });
});
