// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';

import { MoveSelectionModal } from './MoveSelectionModal';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/api/canvas', () => ({
  listCanvases: vi.fn(),
  moveCanvasSelection: vi.fn(),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  useCanvasStore.setState({
    canvasId: '',
    nodes: [],
    moveSelectionDialogOpen: false,
  });
});

describe('MoveSelectionModal', () => {
  it('renders from a stable Canvas store snapshot', () => {
    useCanvasStore.setState({
      canvasId: 'source',
      nodes: [
        {
          id: 'node-selected',
          type: 'note',
          position: { x: 0, y: 0 },
          data: { label: 'Selected' },
          selected: true,
        },
      ],
      moveSelectionDialogOpen: false,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    expect(() => {
      act(() => root?.render(<MoveSelectionModal />));
    }).not.toThrow();

    act(() => useCanvasStore.setState({ pendingSave: true }));
    expect(container.innerHTML).toBe('');
  });
});
