// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeToolbar } from './CanvasToolbar';

const { listCanvases } = vi.hoisted(() => ({ listCanvases: vi.fn() }));
const toolState = vi.hoisted(() => ({
  pendingNodeType: null as string | null,
}));

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
      pendingNodeType: string | null;
      setPendingNodeType: () => void;
      setSketchDraft: () => void;
    }) => unknown,
  ) =>
    selector({
      pendingNodeType: toolState.pendingNodeType,
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
  toolState.pendingNodeType = null;
});

describe('NodeToolbar', () => {
  it('labels the outlined Sparkles tool with Agent and describes its placement action', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(<NodeToolbar activeTool="select" onToolChange={vi.fn()} />),
    );

    const button = container.querySelector(
      'button[aria-label="toolbar.nodes.addAgent (A)"]',
    );
    expect(button?.textContent).toContain('toolbar.nodes.agent');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    const icon = button?.querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.classList.contains('lucide-sparkles')).toBe(true);
    expect(icon?.getAttribute('fill')).toBe('none');
    expect(icon?.getAttribute('stroke')).toBe('currentColor');
  });

  it.each(['select', 'pan', 'lasso'] as const)(
    'uses the theme background for the active %s tool',
    (activeTool) => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      act(() =>
        root?.render(
          <NodeToolbar activeTool={activeTool} onToolChange={vi.fn()} />,
        ),
      );
      const selected = container.querySelector<HTMLButtonElement>(
        `button[aria-label^="toolbar.tools.${activeTool}"]`,
      );
      expect(selected?.classList.contains('text-info')).toBe(true);
      expect(selected?.classList.contains('bg-info-bg')).toBe(true);
      expect(selected?.classList.contains('enabled:hover:bg-info-bg')).toBe(
        true,
      );
      expect(container.querySelectorAll('button.bg-info-bg')).toHaveLength(1);
    },
  );

  it.each(['note', 'text', 'frame', 'sketch', 'question'])(
    'highlights only the pending %s placement button',
    (nodeType) => {
      toolState.pendingNodeType = nodeType;
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      act(() =>
        root?.render(
          <NodeToolbar activeTool="select" onToolChange={vi.fn()} />,
        ),
      );
      const selected = container.querySelector<HTMLButtonElement>(
        `button[aria-label^="toolbar.nodes.${nodeType === 'question' ? 'addAgent' : nodeType}"]`,
      );
      expect(selected?.classList.contains('text-info')).toBe(true);
      expect(selected?.classList.contains('bg-info-bg')).toBe(true);
      expect(selected?.classList.contains('enabled:hover:bg-info-bg')).toBe(
        true,
      );
      expect(container.querySelectorAll('button.bg-info-bg')).toHaveLength(1);
      if (nodeType === 'question') {
        expect(selected?.getAttribute('aria-pressed')).toBe('true');
      }
    },
  );

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
