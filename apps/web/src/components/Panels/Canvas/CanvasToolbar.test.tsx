// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeToolbar } from './CanvasToolbar';

import type * as ReactI18next from 'react-i18next';

const { listCanvases, addNodes, translate } = vi.hoisted(() => ({
  listCanvases: vi.fn(),
  addNodes: vi.fn(),
  translate: (key: string) => key,
}));
const toolState = vi.hoisted(() => ({
  pendingNodeType: null as string | null,
  setPendingNodeType: vi.fn(),
}));
const inputState = vi.hoisted(() => ({ isNotMouse: false }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({ t: translate }),
}));

vi.mock('@/api/artifact', () => ({
  uploadHtml: vi.fn(),
  uploadImage: vi.fn(),
  uploadOffice: vi.fn(),
  uploadPdf: vi.fn(),
  uploadVideo: vi.fn(),
}));

vi.mock('@/api/canvas', () => ({ listCanvases }));

vi.mock('@/hooks/useInputMode', () => ({
  useIsNotMouse: () => inputState.isNotMouse,
}));

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
      setPendingNodeType: toolState.setPendingNodeType,
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
      addNodes,
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
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  listCanvases.mockReset();
  addNodes.mockClear();
  toolState.pendingNodeType = null;
  toolState.setPendingNodeType.mockClear();
  inputState.isNotMouse = false;
});

describe('NodeToolbar', () => {
  it('arms child Space placement from the primary toolbar button or shortcut 5', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(<NodeToolbar activeTool="select" onToolChange={vi.fn()} />),
    );
    const create = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="spaceHierarchy.createChild (5)"]',
    );
    expect(create).not.toBeNull();
    await act(async () => create?.click());
    expect(toolState.setPendingNodeType).toHaveBeenCalledWith('childSpace');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(listCanvases).not.toHaveBeenCalled();
    toolState.setPendingNodeType.mockClear();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '5', bubbles: true }),
      );
    });
    expect(toolState.setPendingNodeType).toHaveBeenCalledWith('childSpace');
    toolState.pendingNodeType = 'childSpace';
    await act(async () =>
      root?.render(<NodeToolbar activeTool="select" onToolChange={vi.fn()} />),
    );
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '5', bubbles: true }),
      ),
    );
    expect(toolState.setPendingNodeType).toHaveBeenLastCalledWith(null);
  });
  it('updates pressed states when placement changes and navigation resumes', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    for (const pendingNodeType of ['note', 'text', 'childSpace', null]) {
      toolState.pendingNodeType = pendingNodeType;
      act(() =>
        root?.render(
          <NodeToolbar activeTool="select" onToolChange={vi.fn()} />,
        ),
      );
      expect(
        container
          .querySelector('button[aria-label^="toolbar.tools.select"]')
          ?.getAttribute('aria-pressed'),
      ).toBe(String(pendingNodeType === null));
      for (const nodeType of ['note', 'text']) {
        expect(
          container
            .querySelector(`button[aria-label^="toolbar.nodes.${nodeType}"]`)
            ?.getAttribute('aria-pressed'),
        ).toBe(String(pendingNodeType === nodeType));
      }
      expect(
        container
          .querySelector('button[aria-label^="spaceHierarchy.createChild"]')
          ?.getAttribute('aria-pressed'),
      ).toBe(String(pendingNodeType === 'childSpace'));
      expect(
        container.querySelectorAll('button[aria-pressed="true"]'),
      ).toHaveLength(1);
    }
  });

  it('uses roomier primary buttons without enlarging icons or compact dropdowns', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(<NodeToolbar activeTool="select" onToolChange={vi.fn()} />),
    );

    for (const label of [
      'toolbar.tools.select',
      'toolbar.nodes.note',
      'toolbar.nodes.text',
      'toolbar.nodes.frame',
      'toolbar.nodes.sketch',
      'spaceHierarchy.createChild',
    ]) {
      const button = container.querySelector<HTMLButtonElement>(
        `button[aria-label^="${label}"]`,
      );
      expect(button).not.toBeNull();
      for (const className of [
        'h-9',
        'w-9',
        'p-2.5',
        '[&_svg]:h-4',
        '[&_svg]:w-4',
        '[&>span]:right-1',
        '[&>span]:bottom-1',
      ]) {
        expect(button?.classList.contains(className)).toBe(true);
      }
    }
    const dropdown = container.querySelector<HTMLButtonElement>(
      'button[aria-label="toolbar.resources.addContent"]',
    );
    expect(dropdown?.classList.contains('h-9')).toBe(false);
    expect(dropdown?.classList.contains('w-9')).toBe(false);
  });

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
      expect(selected?.classList.contains('text-info-fg')).toBe(true);
      expect(selected?.classList.contains('bg-info-bg')).toBe(true);
      expect(selected?.classList.contains('enabled:hover:bg-info-bg')).toBe(
        true,
      );
      expect(selected?.getAttribute('aria-pressed')).toBe('true');
      expect(
        container.querySelectorAll('button[aria-pressed="true"]'),
      ).toHaveLength(1);
      expect(container.querySelectorAll('button.bg-info-bg')).toHaveLength(1);
    },
  );

  it('shows a fixed leading Lasso button for touch and pen input', () => {
    inputState.isNotMouse = true;
    const onToolChange = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <NodeToolbar activeTool="select" onToolChange={onToolChange} />,
      ),
    );

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    );
    const lasso = buttons.find(
      (button) => button.getAttribute('aria-label') === 'toolbar.tools.lasso',
    );
    expect(lasso).toBe(buttons[0]);
    expect(lasso?.getAttribute('aria-pressed')).toBe('false');
    expect(
      container.querySelector('button[aria-label^="toolbar.tools.select"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label^="toolbar.tools.pan"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="toolbar.tools.moreTools"]'),
    ).toBeNull();

    act(() => lasso?.click());
    expect(onToolChange).toHaveBeenCalledWith('lasso');
  });

  it('keeps the touch Lasso button active when pressed again', () => {
    inputState.isNotMouse = true;
    const onToolChange = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <NodeToolbar activeTool="lasso" onToolChange={onToolChange} />,
      ),
    );

    const lasso = container.querySelector<HTMLButtonElement>(
      'button[aria-label="toolbar.tools.lasso"]',
    );
    expect(lasso?.getAttribute('aria-pressed')).toBe('true');
    expect(lasso?.classList.contains('text-info-fg')).toBe(true);
    expect(lasso?.classList.contains('bg-info-bg')).toBe(true);

    act(() => lasso?.click());
    expect(onToolChange).toHaveBeenCalledWith('lasso');
    expect(onToolChange).not.toHaveBeenCalledWith('select');
  });

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
      expect(selected?.classList.contains('text-info-fg')).toBe(true);
      expect(selected?.classList.contains('bg-info-bg')).toBe(true);
      expect(selected?.classList.contains('enabled:hover:bg-info-bg')).toBe(
        true,
      );
      expect(container.querySelectorAll('button.bg-info-bg')).toHaveLength(1);
      expect(selected?.getAttribute('aria-pressed')).toBe('true');
      expect(
        container.querySelectorAll('button[aria-pressed="true"]'),
      ).toHaveLength(1);
      for (const otherType of ['note', 'text', 'frame', 'sketch', 'addAgent']) {
        const button = container.querySelector<HTMLButtonElement>(
          `button[aria-label^="toolbar.nodes.${otherType}"]`,
        );
        expect(button?.getAttribute('aria-pressed')).toBe(
          otherType === (nodeType === 'question' ? 'addAgent' : nodeType)
            ? 'true'
            : 'false',
        );
      }
      expect(
        container
          .querySelector('button[aria-label^="toolbar.tools.select"]')
          ?.getAttribute('aria-pressed'),
      ).toBe('false');
    },
  );

  it('places Add Space Preview in the content dropdown', async () => {
    listCanvases.mockResolvedValue({
      canvases: [
        { canvasId: 'space-a', title: 'Source' },
        { canvasId: 'space-b', title: 'Folder' },
        { canvasId: 'space-c', title: 'Nested', parentSpaceId: 'space-b' },
        { canvasId: 'space-d', title: 'Own child', parentSpaceId: 'space-a' },
        { canvasId: 'world', title: 'World' },
      ],
    });
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
    expect(previewAction?.classList.contains('text-[13px]')).toBe(true);
    expect(previewAction?.classList.contains('font-normal')).toBe(true);
    expect(previewAction?.classList.contains('leading-5')).toBe(true);
    expect(previewAction?.classList.contains('gap-2')).toBe(true);
    expect(previewAction?.querySelector('svg')?.parentElement?.className).toBe(
      'shrink-0 text-inherit',
    );
    expect(previewAction?.parentElement?.classList.contains('rounded-lg')).toBe(
      true,
    );
    expect(previewAction?.parentElement?.classList.contains('p-1')).toBe(true);
    expect(previewAction?.classList.contains('min-h-7')).toBe(true);
    expect(previewAction?.classList.contains('py-1')).toBe(true);

    await act(async () => previewAction?.click());

    expect(listCanvases).toHaveBeenCalledOnce();
    const button = (label: string) =>
      document.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      );
    expect(button('Source')?.disabled).toBe(true);
    expect(button('Own child')?.disabled).toBe(false);
    expect(button('World')).toBeNull();
    expect(button('Nested')).not.toBeNull();
    await act(async () =>
      button('Folder')
        ?.closest('li')
        ?.querySelector<HTMLButtonElement>('button[aria-expanded]')
        ?.click(),
    );
    expect(button('Nested')).toBeNull();
    expect(addNodes).not.toHaveBeenCalled();
    const search = document.querySelector<HTMLInputElement>(
      'input[name="space-destination-search"]',
    );
    if (!search) throw new Error('Missing Space search');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(search, 'Nested');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('Nested')?.textContent).toContain('Folder');
    await act(async () => button('Nested')?.click());
    expect(addNodes).toHaveBeenCalledExactlyOnceWith([
      {
        nodeType: 'spacePreview',
        data: { targetCanvasId: 'space-c', origin: { type: 'user-created' } },
      },
    ]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(menuTrigger);
  });
});
