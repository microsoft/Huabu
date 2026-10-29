// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import {
  getInkSigilStrokes,
  projectInkResourceBindings,
} from '@huabu/shared/canvas-engine';

import { resetCanvasGestureForTests } from '@/handler/canvasGestureSession';
import { i18n } from '@/i18n';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';
import {
  notifyInkSigilStrokeCommitted,
  resolvePendingInkSigilTap,
  resetInkSigilSession,
  useInkSigilStore,
} from '@/store/inkSigilStore';
import { useToolStore } from '@/store/toolStore';

import { InkSigilHighlightHost } from './InkSigilHighlightHost';
import { InkSigilLayer } from './InkSigilLayer';
import {
  FrameZoomController,
  FrameZoomProvider,
} from '../frame/FrameZoomContext';

import type { CanvasFloatingPopoverProps } from '@/components/Common/CanvasFloatingPopover';
import type { CanvasCommand } from '@huabu/shared';
import type { Node } from '@xyflow/react';

const mocks = vi.hoisted(() => ({
  state: {
    canvasId: 'space',
    nodes: [] as Node[],
    executeCommands: vi.fn(),
    beginGesture: vi.fn(),
  },
  save: vi.fn(),
  popover: vi.fn(),
  screenToFlowPosition: vi.fn(({ x, y }: { x: number; y: number }) => ({
    x,
    y,
  })),
}));
const frameFlow = createStore(() => ({
  nodes: [] as Node[],
  transform: [0, 0, 1],
}));
vi.mock('@/store/canvasStore', () => ({
  default: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
  saveCanvasForSubmission: mocks.save,
}));
vi.mock('@xyflow/react', () => ({
  ViewportPortal: ({ children }: { children: ReactNode }) => (
    <div data-test-viewport-portal>{children}</div>
  ),
  useStoreApi: () => frameFlow,
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  useReactFlow: () => ({ screenToFlowPosition: mocks.screenToFlowPosition }),
}));
vi.mock('@/components/Common/CanvasFloatingPopover', () => ({
  CanvasFloatingPopover: ({
    children,
    open,
    className,
    anchor,
    side,
    offset,
  }: CanvasFloatingPopoverProps) => {
    mocks.popover({ anchor, side, offset });
    return open ? <div className={className}>{children}</div> : null;
  },
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let hostRoot: Root;
let container: HTMLDivElement;

function renderHighlightHost(nodeIds = ['ink']) {
  hostRoot.render(
    <>
      {nodeIds.map((nodeId) => (
        <InkSigilHighlightHost key={nodeId} nodeId={nodeId}>
          <svg className="relative" data-test-ink-strokes />
        </InkSigilHighlightHost>
      ))}
    </>,
  );
}

function element<T extends HTMLElement = HTMLButtonElement>(
  selector: string,
  parent: ParentNode = container,
): T {
  const node = parent.querySelector<T>(selector);
  if (!node) throw new Error(`Missing Sigil test element: ${selector}`);
  return node;
}

function tab(label: string): HTMLButtonElement {
  const result = [
    ...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ].find((button) => button.textContent === label);
  if (!result) throw new Error(`Missing resource category: ${label}`);
  return result;
}

async function rediscoverPicker() {
  await act(async () => {
    resetInkSigilSession();
    root.render(
      <I18nextProvider i18n={i18n}>
        <InkSigilLayer />
      </I18nextProvider>,
    );
  });
  await act(async () => {
    for (let i = 0; i < 4; i++) notifyInkSigilStrokeCommitted(`s${i}`);
    vi.advanceTimersByTime(400);
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  await i18n.changeLanguage('en');
  resetInkSigilSession();
  resetCanvasGestureForTests();
  mocks.screenToFlowPosition.mockImplementation(({ x, y }) => ({ x, y }));
  mocks.state.nodes = [
    {
      id: 'ink',
      type: 'sketch',
      position: { x: 0, y: 0 },
      style: { width: 40, height: 40 },
      data: {
        initialSize: { width: 40, height: 40 },
        strokes: [
          [
            [10, 0],
            [10, 40],
          ],
          [
            [30, 0],
            [30, 40],
          ],
          [
            [0, 10],
            [40, 10],
          ],
          [
            [0, 30],
            [40, 30],
          ],
        ].map((points, index) => ({
          id: `s${index}`,
          points,
          color: 'black',
          size: 2,
          createdAt: index * 500,
        })),
      },
    },
    ...[
      'pdf',
      'web',
      'image',
      'note',
      'text',
      'question',
      'frame',
      'video',
    ].map((type) => ({
      id: type,
      type,
      position: { x: 100, y: 100 },
      data: { label: `${type} resource` },
    })),
  ];
  mocks.save.mockResolvedValue(undefined);
  mocks.state.executeCommands.mockImplementation(
    (commands: CanvasCommand[]) => {
      for (const command of commands) {
        if (command.type === 'SET_NODE_GEOMETRY') {
          for (const item of command.items) {
            mocks.state.nodes = mocks.state.nodes.map((node) =>
              node.id === item.nodeId
                ? {
                    ...node,
                    position: item.position ?? node.position,
                    style: { ...node.style, ...item.size },
                  }
                : node,
            );
          }
          continue;
        }
        if (command.type !== 'MERGE_NODE_DATA') continue;
        for (const patch of command.patches) {
          mocks.state.nodes = mocks.state.nodes.map((node) =>
            node.id === patch.nodeId
              ? { ...node, data: { ...node.data, ...patch.patch } }
              : node,
          );
        }
      }
    },
  );
  useToolStore.setState({
    pendingNodeType: 'sketch',
    sketchDraft: { ...useToolStore.getState().sketchDraft, mode: 'draw' },
  });
  useGesturePreviewStore.setState({
    nodeGeometryPreviews: null,
    sketchStrokeSelection: {},
    sketchStrokeMovePreview: null,
    sketchStrokeMoveCarriedNodeIds: [],
    sketchErasePreview: {},
  });
  container = document.createElement('div');
  document.body.append(container);
  const layerContainer = document.createElement('div');
  const hostContainer = document.createElement('div');
  container.append(layerContainer, hostContainer);
  root = createRoot(layerContainer);
  hostRoot = createRoot(hostContainer);
  await act(async () => renderHighlightHost());
  await act(async () =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <InkSigilLayer />
      </I18nextProvider>,
    ),
  );
  await act(async () => {
    for (let i = 0; i < 4; i++) notifyInkSigilStrokeCommitted(`s${i}`);
    vi.advanceTimersByTime(400);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  await act(async () => hostRoot.unmount());
  container.remove();
  resetInkSigilSession();
  resetCanvasGestureForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Ink resource picker', () => {
  it.each(['source', 'ancestor', 'both', 'resize'] as const)(
    'follows %s geometry previews without changing canonical binding validity',
    async (preview) => {
      await act(async () => element('[role="option"]').click());
      const canonical = mocks.state.nodes;
      const projection = projectInkResourceBindings(canonical)[0];
      const initial = element('[data-ink-sigil-label]').style.left;
      const frame: Node = {
        id: 'source-frame',
        type: 'frame',
        position: { x: 0, y: 0 },
        style: { width: 1400, height: 700 },
        data: {},
      };
      mocks.state.nodes = [
        frame,
        ...canonical.map((node) =>
          node.id === 'ink' ? { ...node, parentId: frame.id } : node,
        ),
      ];
      await act(async () =>
        useGesturePreviewStore.setState({
          nodeGeometryPreviews: new Map([
            ...(preview === 'source' || preview === 'both'
              ? [['ink', { position: { x: 50, y: 20 } }] as const]
              : []),
            ...(preview === 'ancestor' || preview === 'both'
              ? [[frame.id, { position: { x: 100, y: 60 } }] as const]
              : []),
            ...(preview === 'resize'
              ? [
                  [
                    'ink',
                    {
                      position: { x: 0, y: 0 },
                      style: { width: 80, height: 40 },
                    },
                  ] as const,
                ]
              : []),
          ]),
        }),
      );
      const dx =
        preview === 'source'
          ? 50
          : preview === 'ancestor'
            ? 100
            : preview === 'both'
              ? 150
              : 0;
      const dy =
        preview === 'source'
          ? 20
          : preview === 'ancestor'
            ? 60
            : preview === 'both'
              ? 80
              : 0;
      const target = element('[data-ink-sigil-hit-target]');
      expect(target.style.left).toBe(`${dx}px`);
      expect(target.style.top).toBe(`${dy}px`);
      expect(target.style.width).toBe(preview === 'resize' ? '80px' : '40px');
      expect(element('[data-ink-sigil-label]').style.left).toBe(
        `${Number.parseFloat(initial) + dx + (preview === 'resize' ? 40 : 0)}px`,
      );
      const highlight = element('[data-ink-sigil-highlight]');
      expect(highlight.style.left).toBe('0px');
      expect(highlight.style.top).toBe('0px');
      expect(highlight.style.width).toBe(
        `${projection.bounds.width + (preview === 'resize' ? 40 : 0) + 8 + Number(element('[data-ink-sigil]').dataset.inkSigilLabelWidth)}px`,
      );
      expect(projectInkResourceBindings(mocks.state.nodes)[0]).toMatchObject({
        binding: projection.binding,
        bounds: projection.bounds,
        sourceValid: true,
      });
      await act(async () =>
        useGesturePreviewStore.setState({ nodeGeometryPreviews: null }),
      );
      expect(element('[data-ink-sigil-hit-target]').style.left).toBe('0px');
      expect(element('[data-ink-sigil-label]').style.left).toBe(initial);
    },
  );

  it.each([
    'hidden-primary',
    'hidden-secondary',
    'suppressed-secondary',
  ] as const)(
    'hides the label, highlight and hit targets for %s without losing the binding',
    async (reason) => {
      await act(async () => element('[role="option"]').click());
      const projection = projectInkResourceBindings(mocks.state.nodes)[0];
      const strokes = projection.sources.map((source) => source.stroke);
      const ink = mocks.state.nodes[0];
      const frame: Node = {
        id: 'source-frame',
        type: 'frame',
        position: { x: 0, y: 0 },
        style: { width: 1400, height: 700 },
        data: {},
      };
      mocks.state.nodes = [
        frame,
        { ...ink, data: { ...ink.data, strokes: strokes.slice(0, 2) } },
        {
          ...ink,
          id: 'other-ink',
          parentId: frame.id,
          data: { ...ink.data, strokes: strokes.slice(2) },
        },
        ...mocks.state.nodes.slice(1),
      ];
      await act(async () => renderHighlightHost(['ink', 'other-ink']));
      const render = () =>
        act(async () => {
          frameFlow.setState({
            nodes: mocks.state.nodes,
            transform: [0, 0, 1],
          });
          root.render(
            <I18nextProvider i18n={i18n}>
              <FrameZoomProvider>
                <FrameZoomController />
                <InkSigilLayer />
              </FrameZoomProvider>
            </I18nextProvider>,
          );
        });
      await render();
      expect(container.querySelector('[data-ink-sigil-label]')).not.toBeNull();
      expect(
        element('[data-ink-sigil-highlight]').parentElement?.dataset
          .inkSigilHighlights,
      ).toBe('other-ink');
      await act(async () => element('[data-ink-sigil-label]').click());
      expect(useInkSigilStore.getState().pending).not.toBeNull();
      if (reason === 'suppressed-secondary') {
        await act(async () => frameFlow.setState({ transform: [0, 0, 0.09] }));
      } else {
        mocks.state.nodes = mocks.state.nodes.map((node) =>
          node.id === (reason === 'hidden-primary' ? 'ink' : 'other-ink')
            ? { ...node, hidden: true }
            : node,
        );
        await render();
      }
      for (const selector of [
        '[data-ink-sigil]',
        '[data-ink-sigil-highlight]',
        '[data-ink-sigil-label]',
        '[data-ink-sigil-hit-target]',
      ]) {
        expect(container.querySelector(selector)).toBeNull();
      }
      expect(projectInkResourceBindings(mocks.state.nodes)[0].binding).toEqual(
        projection.binding,
      );
      expect(useInkSigilStore.getState().pending).toBeNull();
      mocks.state.nodes = mocks.state.nodes.map((node) => ({
        ...node,
        hidden: false,
      }));
      await render();
      expect(container.querySelector('[data-ink-sigil-label]')).not.toBeNull();
      expect(
        container.querySelector('[data-ink-sigil-highlight]'),
      ).not.toBeNull();
      mocks.state.nodes = [
        ...mocks.state.nodes.filter((node) => node.id === 'ink'),
        ...mocks.state.nodes.filter((node) => node.id !== 'ink'),
      ];
      await render();
      expect(
        element('[data-ink-sigil-highlight]').parentElement?.dataset
          .inkSigilHighlights,
      ).toBe('ink');
    },
  );

  it.each(['list', 'canvas'])(
    'closes on a %s choice before persistence finishes',
    async (source) => {
      const releases: Array<() => void> = [];
      mocks.save.mockImplementationOnce(
        () => new Promise<void>((resolve) => releases.push(resolve)),
      );
      let target: HTMLDivElement | undefined;
      if (source === 'canvas') {
        target = document.createElement('div');
        target.className = 'react-flow__node';
        target.dataset.id = 'note';
        vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
          new DOMRect(100, 100, 100, 100),
        );
        container.append(target);
      }
      try {
        await act(async () => {
          if (source === 'list') element('[role="option"]').click();
          else expect(resolvePendingInkSigilTap(150, 150)).toBe(true);
        });
        expect(container.querySelector('[role="dialog"]')).toBeNull();
        expect(useInkSigilStore.getState().saving).toBe(true);
        expect(element('[data-ink-sigil-label]').textContent).toBe(
          source === 'list' ? 'pdf resource' : 'note resource',
        );
        await act(async () => element('[data-ink-sigil-label]').click());
        expect(container.querySelector('[role="dialog"]')).not.toBeNull();
        for (const option of container.querySelectorAll<HTMLButtonElement>(
          '[role="option"]',
        )) {
          expect(option.disabled).toBe(false);
        }
      } finally {
        await act(async () => releases.forEach((release) => release()));
        target?.remove();
      }
      expect(useInkSigilStore.getState().saving).toBe(false);
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    },
  );

  it('matches the compact reference menu without a search field or footer', () => {
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.parentElement?.classList.contains('bg-surface')).toBe(true);
    expect(dialog?.parentElement?.classList.contains('border')).toBe(true);
    expect(dialog?.parentElement?.classList.contains('shadow-lg')).toBe(true);
    const rows = container.querySelectorAll<HTMLElement>('[role="option"]');
    expect(rows.length).toBeGreaterThan(0);
    expect(dialog?.parentElement?.classList.contains('w-72')).toBe(true);
    const tabs = element('[role="tablist"]');
    expect(tabs.classList.contains('[&>button]:w-[50px]')).toBe(true);
    expect(tabs.classList.contains('[&>button]:flex-none')).toBe(true);
    expect(tabs.classList.contains('flex-wrap')).toBe(true);
    expect(tabs.classList.contains('[&>button]:flex-1')).toBe(false);
    expect(mocks.popover).toHaveBeenLastCalledWith({
      anchor: { x: 0, y: 0, width: 40, height: 40 },
      side: 'bottom',
      offset: 6,
    });
    for (const row of rows) expect(row.style.height).toBe('24px');
    expect(container.querySelector('input')).toBeNull();
    expect(dialog?.querySelector('[role="status"]')).toBeNull();
    expect(dialog?.textContent).toContain(
      'Click a canvas object or choose a resource from the list',
    );
    expect(dialog?.querySelectorAll('.overflow-y-auto')).toHaveLength(1);
    expect(
      dialog
        ?.querySelector('.overflow-y-auto')
        ?.classList.contains('huabu-scrollbar'),
    ).toBe(true);
  });
  it('paints highlights inside the source node before its ink without blending or intercepting input', async () => {
    await act(async () => element('[role="option"]').click());
    const layer = element<HTMLDivElement>('[data-ink-sigil-highlights]');
    expect(layer.dataset.inkSigilHighlights).toBe('ink');
    expect(layer.className).not.toContain('mix-blend');
    expect(layer.className).not.toContain('z-');
    expect(layer.classList.contains('pointer-events-none')).toBe(true);
    expect(layer.hasAttribute('inert')).toBe(true);
    expect(layer.querySelector('[data-ink-sigil-highlight]')).not.toBeNull();
    expect(layer.nextElementSibling).toBe(element('[data-test-ink-strokes]'));
    expect(layer.contains(element('[data-ink-sigil-label]'))).toBe(false);
  });
  it('keeps the highlight in world coordinates below its culled source and restores the local host', async () => {
    await act(async () => element('[role="option"]').click());
    expect(
      container.querySelector('[data-ink-sigil-highlight]'),
    ).not.toBeNull();
    await act(async () => hostRoot.render(null));
    const fallback = element(
      '[data-test-viewport-portal] [data-ink-sigil-highlight]',
    );
    expect(fallback.style.zIndex).toBe('-1');
    expect(fallback.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('[data-ink-sigil-label]')).not.toBeNull();
    await act(async () => renderHighlightHost());
    expect(
      container.querySelector('[data-ink-sigil-highlight]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-test-viewport-portal]')).toBeNull();
  });
  it.each(['ink', 'source-frame'])(
    'moves a split binding below the other source when %s is elevated',
    async (selectedId) => {
      await act(async () => element('[role="option"]').click());
      const ink = mocks.state.nodes[0];
      const strokes = ink.data.strokes as unknown[];
      mocks.state.nodes = [
        {
          id: 'source-frame',
          type: 'frame',
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          ...ink,
          parentId: 'source-frame',
          data: { ...ink.data, strokes: strokes.slice(0, 2) },
        },
        {
          ...ink,
          id: 'other-ink',
          data: { ...ink.data, strokes: strokes.slice(2) },
        },
        ...mocks.state.nodes.slice(1),
      ];
      await act(async () => {
        renderHighlightHost(['ink', 'other-ink']);
        useToolStore.setState({ pendingNodeType: null });
      });
      for (const selected of [false, true, false]) {
        mocks.state.nodes = mocks.state.nodes.map((node) => ({
          ...node,
          selected: selected && node.id === selectedId,
        }));
        await act(async () =>
          root.render(
            <I18nextProvider i18n={i18n}>
              <InkSigilLayer />
            </I18nextProvider>,
          ),
        );
        expect(
          element('[data-ink-sigil-highlight]').parentElement?.dataset
            .inkSigilHighlights,
        ).toBe(selected ? 'other-ink' : 'ink');
      }
    },
  );
  it('moves the label with complete strokes and hides it for partial move or erase previews', async () => {
    const option =
      container.querySelector<HTMLButtonElement>('[role="option"]');
    await act(async () => option?.click());
    const label = container.querySelector<HTMLElement>(
      '[data-ink-sigil-label]',
    );
    expect(label?.style.fontFamily).toContain('Caveat');
    expect(label?.style.fontFamily).toContain('LXGW WenKai Lite');
    expect(
      container
        .querySelector('[data-ink-sigil-highlight]')
        ?.classList.contains('bg-ink-reference-bg'),
    ).toBe(true);
    const originalLeft = parseFloat(
      container.querySelector<HTMLElement>('[data-ink-sigil-label]')?.style
        .left ?? '',
    );
    expect(originalLeft).toBeGreaterThan(0);
    await act(async () =>
      useGesturePreviewStore.setState({
        sketchStrokeSelection: { ink: ['s0', 's1', 's2', 's3'] },
        sketchStrokeMovePreview: { dx: 25, dy: 10 },
      }),
    );
    expect(
      parseFloat(
        container.querySelector<HTMLElement>('[data-ink-sigil-label]')?.style
          .left ?? '',
      ),
    ).toBe(originalLeft + 25);
    expect(
      container
        .querySelector('[data-ink-sigil-highlight]')
        ?.hasAttribute('data-canvas-grounding-exclude'),
    ).toBe(false);
    await act(async () =>
      useGesturePreviewStore.setState({
        sketchStrokeMoveCarriedNodeIds: ['ink'],
      }),
    );
    expect(
      parseFloat(
        container.querySelector<HTMLElement>('[data-ink-sigil-label]')?.style
          .left ?? '',
      ),
    ).toBe(originalLeft);
    await act(async () =>
      useGesturePreviewStore.setState({
        sketchStrokeSelection: { ink: ['s0'] },
      }),
    );
    expect(container.querySelector('[data-ink-sigil-label]')).toBeNull();
    await act(async () =>
      useGesturePreviewStore.setState({
        sketchStrokeMovePreview: null,
        sketchErasePreview: { ink: ['s0'] },
      }),
    );
    expect(container.querySelector('[data-ink-sigil-label]')).toBeNull();
  });
  it('pairs category labels with decorative canonical Canvas icons', () => {
    for (const [label, icon] of [
      ['Docs', 'file-text'],
      ['Web', 'globe'],
      ['Image', 'image'],
      ['Text', 'type'],
    ]) {
      const button = tab(label);
      expect(button.querySelector(`svg.lucide-${icon}`)).not.toBeNull();
      expect(
        button.querySelector('svg')?.closest('[aria-hidden="true"]'),
      ).not.toBeNull();
      expect(button.textContent).toBe(label);
    }
  });

  it('filters one list by available categories without collapsible groups', async () => {
    expect(
      [...container.querySelectorAll('[role="tab"]')].map(
        (item) => item.textContent,
      ),
    ).toEqual(['Docs', 'Web', 'Image', 'Text']);
    expect(tab('Docs').getAttribute('aria-selected')).toBe('true');
    const categories = [
      ['Docs', ['pdf resource']],
      ['Web', ['web resource']],
      ['Image', ['image resource']],
      ['Text', ['note resource', 'text resource']],
    ] as const;
    for (const [name, labels] of categories) {
      await act(async () => tab(name).click());
      expect(
        [...container.querySelectorAll('[role="option"]')].map(
          (item) => item.textContent,
        ),
      ).toEqual(labels);
      expect(container.querySelectorAll('[role="listbox"]')).toHaveLength(1);
      expect(container.querySelectorAll('.overflow-y-auto')).toHaveLength(1);
      expect(container.querySelector('[aria-expanded]')).toBeNull();
    }
    expect(mocks.state.nodes.find((node) => node.id === 'note')?.data).toEqual({
      label: 'note resource',
    });
    expect(mocks.state.executeCommands).not.toHaveBeenCalled();
  });

  it.each(['web', 'text', 'none'])(
    'defaults to the first nonempty category with %s resources',
    async (type) => {
      mocks.state.nodes = mocks.state.nodes.filter(
        (node) => node.type === 'sketch' || node.type === type,
      );
      await rediscoverPicker();
      if (type === 'none') {
        expect(element('[role="status"]').textContent).toBe(
          'No referenceable resources',
        );
        expect(container.querySelector('[role="tablist"]')).toBeNull();
        expect(container.querySelector('[role="tabpanel"]')).toBeNull();
      } else {
        expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
        expect(
          tab(type === 'web' ? 'Web' : 'Text').getAttribute('aria-selected'),
        ).toBe('true');
        expect(element('[role="option"]').textContent).toBe(`${type} resource`);
      }
    },
  );

  it('supports arrow, Home, and End keys with a single tab stop and linked panel', async () => {
    tab('Docs').focus();
    for (const [key, name] of [
      ['ArrowLeft', 'Text'],
      ['ArrowRight', 'Docs'],
      ['End', 'Text'],
      ['Home', 'Docs'],
      ['ArrowRight', 'Web'],
    ]) {
      await act(async () =>
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(document.activeElement).toBe(tab(name));
      expect(tab(name).getAttribute('aria-selected')).toBe('true');
      expect(tab(name).getAttribute('aria-controls')).toBe(
        element('[role="tabpanel"]').id,
      );
      expect(element('[role="tabpanel"]').getAttribute('aria-label')).toBe(
        name,
      );
      expect(
        container.querySelectorAll('[role="tab"][tabindex="0"]'),
      ).toHaveLength(1);
    }
    await act(async () => {
      const list = element('[role="listbox"]');
      list.focus();
      list.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(element('[data-ink-sigil-label]').textContent).toBe('web resource');
    await act(async () => element('[data-ink-sigil-label]').click());
    expect(tab('Web').getAttribute('aria-selected')).toBe('true');
  });

  it('falls back to an available category when repairing the last target of its type', async () => {
    await act(async () => tab('Web').click());
    await act(async () => element('[role="option"]').click());
    mocks.state.nodes = mocks.state.nodes.filter((node) => node.id !== 'web');
    await act(async () =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <InkSigilLayer />
        </I18nextProvider>,
      ),
    );
    expect(element('[data-ink-sigil-label]').textContent).toContain(
      'Missing resource',
    );
    await act(async () => element('[data-ink-sigil-label]').click());
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(3);
    expect(tab('Docs').getAttribute('aria-selected')).toBe('true');
    expect(element('[role="option"]').textContent).toBe('pdf resource');
  });

  it('updates available categories live and resets scrolling when the active category disappears', async () => {
    const originalNodes = mocks.state.nodes;
    const render = async () =>
      act(async () =>
        root.render(
          <I18nextProvider i18n={i18n}>
            <InkSigilLayer />
          </I18nextProvider>,
        ),
      );
    await act(async () => tab('Text').click());
    await act(async () => {
      const panel = element('[role="tabpanel"]');
      panel.scrollTop = 1000;
      panel.dispatchEvent(new Event('scroll'));
    });
    mocks.state.nodes = originalNodes.filter(
      (node) => node.type !== 'text' && node.type !== 'note',
    );
    await render();
    expect(
      [...container.querySelectorAll('[role="tab"]')].map(
        (item) => item.textContent,
      ),
    ).toEqual(['Docs', 'Web', 'Image']);
    expect(tab('Docs').getAttribute('aria-selected')).toBe('true');
    expect(element('[role="tabpanel"]').scrollTop).toBe(0);
    expect(element('[role="option"]').textContent).toBe('pdf resource');
    mocks.state.nodes = originalNodes;
    await render();
    expect(tab('Text')).toBeDefined();
    expect(tab('Docs').getAttribute('aria-selected')).toBe('true');
    mocks.state.nodes = originalNodes.filter((node) => node.type === 'sketch');
    await render();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(element('[role="status"]').textContent).toBe(
      'No referenceable resources',
    );
    mocks.state.nodes = originalNodes;
    await render();
    expect(tab('Docs').getAttribute('aria-selected')).toBe('true');
    expect(element('[role="tabpanel"]').scrollTop).toBe(0);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('resets scrolling and keyboard position on category changes while keeping rows virtualized', async () => {
    mocks.state.nodes.push(
      ...Array.from(
        { length: 50 },
        (_, index): Node => ({
          id: `pdf-${index}`,
          type: 'pdf',
          position: { x: 100, y: 100 },
          data: { label: `Document ${index}` },
        }),
      ),
    );
    await rediscoverPicker();
    await act(async () => {
      const list = element('[role="listbox"]');
      list.focus();
      list.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(element('[role="option"][aria-selected="true"]').textContent).toBe(
      'Document 0',
    );
    await act(async () => {
      const panel = element('[role="tabpanel"]');
      panel.scrollTop = 1000;
      panel.dispatchEvent(new Event('scroll'));
    });
    expect(
      container.querySelectorAll('[role="option"]').length,
    ).toBeLessThanOrEqual(13);
    expect(container.textContent).toContain('Document 40');
    await act(async () => tab('Text').click());
    expect(element('[role="tabpanel"]').scrollTop).toBe(0);
    expect(element('[role="option"][aria-selected="true"]').textContent).toBe(
      'note resource',
    );
    await act(async () => tab('Docs').click());
    expect(element('[role="tabpanel"]').scrollTop).toBe(0);
    expect(element('[role="option"][aria-selected="true"]').textContent).toBe(
      'pdf resource',
    );
  });

  it('binds, captures only complete selected labels, and preserves binding after Escape on reselection', async () => {
    const option = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ].find((element) => element.textContent?.includes('pdf resource'));
    await act(async () => option?.click());
    expect(useInkSigilStore.getState().pending).toBeNull();
    const label = container.querySelector<HTMLButtonElement>(
      '[data-ink-sigil-label]',
    );
    expect(label?.textContent).toBe('pdf resource');
    expect(
      container
        .querySelector('[data-ink-sigil]')
        ?.hasAttribute('data-canvas-grounding-exclude'),
    ).toBe(true);
    await act(async () =>
      useGesturePreviewStore.setState({
        sketchStrokeSelection: { ink: ['s0', 's1', 's2', 's3'] },
      }),
    );
    expect(
      container
        .querySelector('[data-ink-sigil]')
        ?.hasAttribute('data-canvas-grounding-exclude'),
    ).toBe(false);
    await act(async () => label?.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[data-ink-sigil-label]')?.textContent).toBe(
      'pdf resource',
    );
  });

  it('consumes a direct resource tap regardless of the active category and reopens in its category', async () => {
    expect(tab('Docs').getAttribute('aria-selected')).toBe('true');
    const node = document.createElement('div');
    node.className = 'react-flow__node';
    node.setAttribute('data-id', 'note');
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(100, 100, 100, 100),
    );
    container.append(node);
    await act(async () => {
      expect(resolvePendingInkSigilTap(150, 150)).toBe(true);
    });
    expect(container.querySelector('[data-ink-sigil-label]')?.textContent).toBe(
      'note resource',
    );
    expect(mocks.save).toHaveBeenCalledWith('space');
    await act(async () => element('[data-ink-sigil-label]').click());
    expect(tab('Text').getAttribute('aria-selected')).toBe('true');
  });

  it.each([
    ['draw', 'data-ink-sigil-label'],
    ['draw', 'data-ink-sigil-hit-target'],
    ['select', 'data-ink-sigil-label'],
    ['select', 'data-ink-sigil-hit-target'],
  ])(
    'rebinds through %s mode using %s and saves the replacement',
    async (mode, attribute) => {
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[role="option"]')?.click(),
      );
      if (mode === 'select') {
        await act(async () => useToolStore.setState({ pendingNodeType: null }));
      }
      const button = element(`[${attribute}]`);
      expect(button.classList.contains('pointer-events-auto')).toBe(true);
      if (attribute === 'data-ink-sigil-hit-target') {
        expect(button.style.left).toBe('0px');
        expect(button.style.width).toBe('40px');
        expect(button.style.height).toBe('40px');
        expect(button.hasAttribute('data-canvas-grounding-exclude')).toBe(true);
      }
      await act(async () => button.click());
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(
        container.querySelector('[role="dialog"]')?.textContent,
      ).not.toContain('Remove reference');
      expect(
        container.querySelector('[role="dialog"] .text-danger-fg'),
      ).toBeNull();
      await act(async () => tab('Web').click());
      const replacement = [
        ...container.querySelectorAll<HTMLButtonElement>('[role="option"]'),
      ].find((row) => row.textContent?.includes('web resource'));
      if (!replacement) throw new Error('Missing replacement resource');
      await act(async () => replacement.click());
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(
        container.querySelector('[data-ink-sigil-label]')?.textContent,
      ).toBe('web resource');
      expect(mocks.state.nodes[0].data.strokes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resourceBinding: expect.objectContaining({
              targetNodeId: 'web',
              targetType: 'web',
            }),
          }),
        ]),
      );
      expect(mocks.save).toHaveBeenCalledTimes(2);
      expect(mocks.save).toHaveBeenLastCalledWith('space');
    },
  );

  it.each(['lasso', 'pan', 'erase', 'placement'] as const)(
    'keeps hash and label pointer-transparent during %s',
    async (mode) => {
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[role="option"]')?.click(),
      );
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[data-ink-sigil-label]')
          ?.click(),
      );
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      await act(async () => {
        if (mode === 'erase') {
          useToolStore.setState({
            sketchDraft: {
              ...useToolStore.getState().sketchDraft,
              mode: 'erase',
            },
          });
        } else if (mode === 'placement') {
          useToolStore.setState({ pendingNodeType: 'note' });
        } else {
          root.render(
            <I18nextProvider i18n={i18n}>
              <InkSigilLayer tool={mode} />
            </I18nextProvider>,
          );
        }
      });
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      for (const selector of [
        '[data-ink-sigil-hit-target]',
        '[data-ink-sigil-label]',
      ]) {
        const button = element(selector);
        expect(button.classList.contains('pointer-events-none')).toBe(true);
        expect(button.tabIndex).toBe(-1);
        await act(async () => button.click());
        expect(container.querySelector('[role="dialog"]')).toBeNull();
      }
      expect(
        container.querySelector('[data-ink-sigil-label]')?.textContent,
      ).toBe('pdf resource');
      expect(mocks.save).toHaveBeenCalledTimes(1);
    },
  );

  it('clears pending discovery on authoritative geometry resets', async () => {
    await act(async () =>
      useGesturePreviewStore.getState().resetCanvasScopedTransients(),
    );
    expect(useInkSigilStore.getState().pending).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(useInkSigilStore.getState().pending).toBeNull();
  });

  it.each(['data-ink-sigil-label', 'data-ink-sigil-hit-target'])(
    'drags the hash and label together through %s without rebinding or moving other content',
    async (attribute) => {
      const sources = getInkSigilStrokes(mocks.state.nodes);
      const otherStroke = {
        ...sources[0].stroke,
        id: 'other',
        points: [
          [100, 100],
          [120, 120],
        ],
      };
      mocks.state.nodes[0] = {
        ...mocks.state.nodes[0],
        data: {
          ...mocks.state.nodes[0].data,
          strokes: [...sources.map((source) => source.stroke), otherStroke],
        },
      };
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[role="option"]')?.click(),
      );
      const original = projectInkResourceBindings(mocks.state.nodes)[0];
      const button = element(`[${attribute}]`);
      button.setPointerCapture = vi.fn();
      button.hasPointerCapture = () => false;
      button.releasePointerCapture = vi.fn();
      mocks.screenToFlowPosition.mockImplementation(({ x, y }) => ({
        x: x / 2,
        y: y / 2,
      }));
      for (const [type, x, y] of [
        ['pointerdown', 10, 10],
        ['pointermove', 50, 30],
      ] as const) {
        await act(async () =>
          button.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerType: 'mouse',
              pointerId: 1,
              isPrimary: true,
              button: 0,
              clientX: x,
              clientY: y,
            }),
          ),
        );
      }
      expect(useGesturePreviewStore.getState().sketchStrokeMovePreview).toEqual(
        { dx: 20, dy: 10 },
      );
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      await act(async () =>
        button.dispatchEvent(
          new PointerEvent('pointerup', {
            bubbles: true,
            cancelable: true,
            pointerType: 'mouse',
            pointerId: 1,
            isPrimary: true,
            button: 0,
            clientX: 50,
            clientY: 30,
          }),
        ),
      );
      await act(async () =>
        button.dispatchEvent(
          new MouseEvent('click', { bubbles: true, detail: 1 }),
        ),
      );
      const moved = projectInkResourceBindings(mocks.state.nodes)[0];
      expect(moved.sourceValid).toBe(true);
      expect(moved.binding).toEqual(original.binding);
      expect(moved.bounds.x).toBe(original.bounds.x + 20);
      expect(moved.bounds.y).toBe(original.bounds.y + 10);
      expect(
        getInkSigilStrokes(mocks.state.nodes).find(
          (source) => source.stroke.id === 'other',
        )?.points,
      ).toEqual([
        [100, 100],
        [120, 120],
      ]);
      expect(
        mocks.state.nodes.find((node) => node.id === 'pdf')?.position,
      ).toEqual({ x: 100, y: 100 });
      expect(mocks.state.beginGesture).toHaveBeenCalledExactlyOnceWith(
        'SET_NODE_GEOMETRY',
      );
      expect(
        useGesturePreviewStore.getState().sketchStrokeMovePreview,
      ).toBeNull();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  it.each(['pointercancel', 'Escape'])(
    'discards a drag preview on %s',
    async (cancel) => {
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[role="option"]')?.click(),
      );
      const before = mocks.state.nodes;
      const button = element('[data-ink-sigil-label]');
      button.setPointerCapture = vi.fn();
      button.hasPointerCapture = () => false;
      for (const [type, x] of [
        ['pointerdown', 0],
        ['pointermove', 40],
      ] as const) {
        await act(async () =>
          button.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerType: 'pen',
              pointerId: 2,
              isPrimary: true,
              button: 0,
              clientX: x,
            }),
          ),
        );
      }
      expect(
        useGesturePreviewStore.getState().sketchStrokeMovePreview,
      ).not.toBeNull();
      await act(async () =>
        cancel === 'Escape'
          ? window.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Escape' }),
            )
          : button.dispatchEvent(
              new PointerEvent('pointercancel', {
                bubbles: true,
                pointerId: 2,
              }),
            ),
      );
      expect(mocks.state.nodes).toBe(before);
      expect(
        useGesturePreviewStore.getState().sketchStrokeMovePreview,
      ).toBeNull();
      expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual(
        {},
      );
      expect(mocks.state.beginGesture).not.toHaveBeenCalled();
    },
  );

  it.each(['mouse', 'pen', 'touch'])(
    'keeps a short %s tap as reselection rather than movement',
    async (pointerType) => {
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[role="option"]')?.click(),
      );
      const button = element('[data-ink-sigil-label]');
      button.setPointerCapture = vi.fn();
      button.hasPointerCapture = () => false;
      for (const [type, x] of [
        ['pointerdown', 10],
        ['pointerup', 10.5],
      ] as const) {
        await act(async () =>
          button.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerType,
              pointerId: 3,
              isPrimary: true,
              button: 0,
              clientX: x,
            }),
          ),
        );
      }
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(mocks.state.beginGesture).not.toHaveBeenCalled();
      expect(
        useGesturePreviewStore.getState().sketchStrokeMovePreview,
      ).toBeNull();
    },
  );

  it('measures two-line label height for the highlight and frozen bounds', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('line-clamp-2')
          ? new DOMRect(0, 0, 288, 72.16)
          : new DOMRect();
      },
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[role="option"]')?.click(),
    );
    const annotation = element('[data-ink-sigil]');
    expect(annotation.dataset.inkSigilLabelWidth).toBe('288');
    expect(annotation.dataset.inkSigilLabelHeight).toBe('72.16');
    const text = element('.line-clamp-2', annotation);
    expect(text.style.maxWidth).toBe('288px');
    expect(text.classList.contains('wrap-anywhere')).toBe(true);
    const label = element('[data-ink-sigil-label]', annotation);
    const highlight = element('[data-ink-sigil-highlight]');
    expect(
      parseFloat(highlight.style.top) + parseFloat(highlight.style.height),
    ).toBeCloseTo(parseFloat(label.style.top) + 72.16);
    await act(async () => label.click());
    expect(mocks.popover).toHaveBeenLastCalledWith({
      anchor: {
        x: parseFloat(highlight.style.left),
        y: parseFloat(highlight.style.top),
        width: parseFloat(highlight.style.width),
        height: parseFloat(highlight.style.height),
      },
      side: 'bottom',
      offset: 6,
    });
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });
});
