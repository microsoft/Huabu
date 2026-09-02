// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';

import { MoveSelectionModal } from './MoveSelectionModal';

const { listCanvases, translate } = vi.hoisted(() => ({
  listCanvases: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: translate }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/api/canvas', async (importOriginal) => ({
  ...(await importOriginal()),
  listCanvases,
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
    pendingSave: false,
  });
  listCanvases.mockReset();
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

  it('allows entering a name for a new destination Space', async () => {
    listCanvases.mockResolvedValue({ canvases: [] });
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
      moveSelectionDialogOpen: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<MoveSelectionModal />));
    const kindSelect = document.querySelector<HTMLButtonElement>(
      'button[aria-label="moveSelection.destinationKind"]',
    );
    act(() => kindSelect?.click());
    const newDestination = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((button) =>
      button.textContent?.includes('moveSelection.newDestination'),
    );
    act(() => newDestination?.click());

    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="moveSelection.newSpaceName"]',
      ),
    ).not.toBeNull();
  });
});
