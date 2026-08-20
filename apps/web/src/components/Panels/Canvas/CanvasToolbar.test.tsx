// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeToolbar } from './CanvasToolbar';

const { listCanvases } = vi.hoisted(() => ({ listCanvases: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/api/artifact', () => ({
  uploadHtml: vi.fn(),
  uploadImage: vi.fn(),
  uploadOffice: vi.fn(),
  uploadPdf: vi.fn(),
  uploadVideo: vi.fn(),
}));

vi.mock('@/api/canvas', () => ({ listCanvases }));

vi.mock('@/config/shortcuts', () => ({ matchesShortcut: () => false }));

vi.mock('@/hooks/useInputMode', () => ({ useIsNotMouse: () => false }));

vi.mock('@/store/toolStore', () => ({
  useToolStore: (
    selector: (state: {
      pendingNodeType: null;
      setPendingNodeType: () => void;
      setSketchDraft: () => void;
    }) => unknown,
  ) =>
    selector({
      pendingNodeType: null,
      setPendingNodeType: vi.fn(),
      setSketchDraft: vi.fn(),
    }),
}));

vi.mock('@/store/workspaceStore', () => ({
  useWorkspaceStore: (
    selector: (state: { worldCanvasId: string }) => unknown,
  ) => selector({ worldCanvasId: 'world' }),
}));

vi.mock('../../../store/canvasStore.ts', () => ({
  default: (
    selector: (state: {
      addNodes: () => void;
      undo: () => void;
      redo: () => void;
      canUndo: boolean;
      canRedo: boolean;
      canvasId: string;
    }) => unknown,
  ) =>
    selector({
      addNodes: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
      canUndo: false,
      canRedo: false,
      canvasId: 'space-a',
    }),
}));

vi.mock('../../Nodes/sketch/SketchModeSwitcher.tsx', () => ({
  SketchModeSwitcher: () => null,
}));

vi.mock('../../Nodes/sketch/SketchSettingsPanel.tsx', () => ({
  SketchSettingsPanel: () => null,
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  listCanvases.mockReset();
});

describe('NodeToolbar', () => {
  it('places Add Space Preview in the content dropdown', async () => {
    listCanvases.mockResolvedValue({ canvases: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() =>
      root?.render(<NodeToolbar activeTool="select" onToolChange={vi.fn()} />),
    );

    expect(
      document.querySelector('button[aria-label="spacePreview.add"]'),
    ).toBeNull();

    const menuTrigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="toolbar.resources.addContent"]',
    );
    expect(menuTrigger).not.toBeNull();

    act(() => menuTrigger?.click());

    const previewAction = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.includes('spacePreview.add'));
    expect(previewAction).toBeDefined();

    await act(async () => previewAction?.click());

    expect(listCanvases).toHaveBeenCalledOnce();
  });
});
