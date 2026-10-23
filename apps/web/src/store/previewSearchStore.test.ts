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

  it('addresses a result without changing canvas search and fences stale navigation completion', () => {
    const state = usePreviewSearchStore.getState;
    useSearchStore.setState({ query: 'canvas query' });
    state().reveal('note-1', 'needle', 2);
    const first = state().navigationRequest;
    expect(state()).toMatchObject({
      nodeId: 'note-1',
      query: 'needle',
      isOpen: true,
      focusInput: false,
      navigationRequest: { occurrenceIndex: 2 },
    });
    state().reveal('note-2', 'needle', 3);
    const second = state().navigationRequest;
    expect(second?.nonce).toBeGreaterThan(first?.nonce ?? 0);
    state().consumeNavigation(first?.nonce ?? 0);
    expect(state().navigationRequest).toBe(second);
    state().consumeNavigation(second?.nonce ?? 0);
    expect(state().navigationRequest).toBeNull();
    expect(useSearchStore.getState().query).toBe('canvas query');
    state().open('note-2');
    expect(state().focusInput).toBe(true);
  });
});
