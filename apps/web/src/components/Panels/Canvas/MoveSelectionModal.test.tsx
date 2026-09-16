// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';

import { MoveSelectionModal } from './MoveSelectionModal';

const { drainPendingSaves, listCanvases, moveCanvasSelection, translate } =
  vi.hoisted(() => ({
    drainPendingSaves: vi.fn().mockResolvedValue(undefined),
    listCanvases: vi.fn(),
    moveCanvasSelection: vi.fn(),
    translate: (key: string) => key,
  }));

const moveResult = {
  movedNodeCount: 1,
  movedConversationCount: 0,
  destination: { canvasId: 'destination' },
};

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
  moveCanvasSelection,
}));

vi.mock('@/store/canvasStore', async (importOriginal) => ({
  ...(await importOriginal()),
  drainPendingSaves,
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
  moveCanvasSelection.mockReset();
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

  it('lists existing Spaces and the separated create action in one selector', async () => {
    listCanvases.mockResolvedValue({
      canvases: [{ canvasId: 'destination', title: 'Destination' }],
    });
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
    const destinationSelectors = document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="moveSelection.selectDestination"]',
    );
    expect(destinationSelectors).toHaveLength(1);

    act(() => destinationSelectors[0]?.click());
    const optionLabels = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).map((button) => button.textContent);
    expect(optionLabels).toEqual([
      'Destination',
      'moveSelection.createNewDestination',
    ]);
    expect(document.body.textContent).toContain(
      'moveSelection.newDestinationSection',
    );
  });

  it('allows entering a name for a new destination Space when no existing target is available', async () => {
    listCanvases.mockResolvedValue({ canvases: [] });
    moveCanvasSelection.mockResolvedValue(moveResult);
    useCanvasStore.setState({
      canvasId: 'source',
      version: 3,
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
    const destinationSelect = document.querySelector<HTMLButtonElement>(
      'button[aria-label="moveSelection.selectDestination"]',
    );
    act(() => destinationSelect?.click());
    const newDestination = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((button) =>
      button.textContent?.includes('moveSelection.createNewDestination'),
    );
    act(() => newDestination?.click());

    const nameInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="moveSelection.newSpaceName"]',
    );
    expect(nameInput).not.toBeNull();
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setValue?.call(nameInput, 'New destination');
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const move = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'moveSelection.confirm',
    );
    await act(async () => move?.click());

    expect(moveCanvasSelection).toHaveBeenCalledWith('source', {
      selectedNodeIds: ['node-selected'],
      destination: { kind: 'new', title: 'New destination' },
      createSourcePreview: true,
      expectedSourceVersion: 3,
    });
  });

  it('submits the selected existing destination', async () => {
    listCanvases.mockResolvedValue({
      canvases: [{ canvasId: 'destination', title: 'Destination' }],
    });
    moveCanvasSelection.mockResolvedValue(moveResult);
    useCanvasStore.setState({
      canvasId: 'source',
      version: 3,
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
    const destinationSelect = document.querySelector<HTMLButtonElement>(
      'button[aria-label="moveSelection.selectDestination"]',
    );
    act(() => destinationSelect?.click());
    const destination = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((button) => button.textContent === 'Destination');
    act(() => destination?.click());
    const move = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'moveSelection.confirm',
    );
    await act(async () => move?.click());

    expect(moveCanvasSelection).toHaveBeenCalledWith('source', {
      selectedNodeIds: ['node-selected'],
      destination: { kind: 'existing', canvasId: 'destination' },
      createSourcePreview: true,
      expectedSourceVersion: 3,
    });
  });

  it('defaults the source Preview checkbox on and allows disabling it', async () => {
    listCanvases.mockResolvedValue({
      canvases: [{ canvasId: 'destination', title: 'Destination' }],
    });
    useCanvasStore.setState({
      canvasId: 'source',
      version: 3,
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
    const checkbox = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(checkbox?.checked).toBe(true);
    act(() => checkbox?.click());
    expect(checkbox?.checked).toBe(false);
  });
});
