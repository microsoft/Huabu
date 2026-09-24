// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MultiSelectToolbar } from './MultiSelectToolbar';

const state = vi.hoisted(() => ({
  nodes: [16, 24].map((fontSize, index) => ({
    id: `text-${index}`,
    type: 'text',
    selected: true,
    position: { x: index * 300, y: 0 },
    data: { style: { fontSize, fontFamily: 'serif' } },
  })),
  edges: [],
  executeCommands: vi.fn(),
  setMoveSelectionDialogOpen: vi.fn(),
}));
vi.mock('@/store/canvasStore', () => ({
  default: (select: (value: typeof state) => unknown) => select(state),
}));
vi.mock('@/hooks/useInputMode', () => ({ useIsNotMouse: () => false }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/Common/CanvasFloatingPopover', () => ({
  CanvasFloatingPopover: ({
    open,
    children,
  }: {
    open: boolean;
    children: ReactNode;
  }) => (open ? <div>{children}</div> : null),
}));

afterEach(() => vi.unstubAllGlobals());

describe('MultiSelectToolbar font size', () => {
  it('edits mixed sizes inline in one batch and hides the control for mixed types', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<MultiSelectToolbar />));
      const move = container.querySelector<HTMLButtonElement>(
        '[aria-label="moveSelection.action"]',
      );
      act(() => move?.click());
      expect(state.setMoveSelectionDialogOpen).toHaveBeenCalledWith(true, move);
      const input =
        container.querySelector<HTMLInputElement>('[name="font-size"]');
      expect(input?.value).toBe('');
      expect(input?.placeholder).toBe('—');
      expect(input?.getAttribute('aria-label')).toBe('toolbar.fontSize');
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('.node-toolbar-font-trigger')
          ?.click(),
      );
      expect(
        document.querySelector('.node-toolbar-font-menu [aria-current="true"]'),
      ).toBeNull();
      const preset = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '.node-toolbar-font-menu [role="menuitem"]',
        ),
      ).find((item) => item.textContent === '32');
      expect(preset).toBeDefined();
      await act(async () => preset?.click());
      expect(state.executeCommands).toHaveBeenCalledExactlyOnceWith([
        {
          type: 'MERGE_NODE_DATA',
          patches: state.nodes.map((node) => ({
            nodeId: node.id,
            patch: { style: { fontSize: 32, fontFamily: 'serif' } },
          })),
        },
      ]);
      expect(document.querySelector('.node-toolbar-font-menu')).toBeNull();
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="toolbar.size.title"]',
          )
          ?.click(),
      );
      expect(document.querySelector('.node-toolbar-size-panel')).not.toBeNull();
      expect(
        document.querySelector('.node-toolbar-size-panel [name="font-size"]'),
      ).toBeNull();
      state.nodes = state.nodes.map((node) => ({
        ...node,
        data: { style: { ...node.data.style, fontSize: 16 } },
      }));
      await act(async () => root.render(<MultiSelectToolbar />));
      expect(input?.value).toBe('16');
      state.nodes = state.nodes.map((node, index) => ({
        ...node,
        type: index === 0 ? 'text' : 'note',
      }));
      await act(async () => root.render(<MultiSelectToolbar />));
      expect(container.querySelector('[name="font-size"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
