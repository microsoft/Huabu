// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFileSync } from 'node:fs';

import { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_PRESENCE_LIMITS } from '@huabu/shared';

import { useCanvasPresenceStore } from '@/store/canvasPresence/canvasPresenceStore';

import {
  PRESENCE_COLOR_TOKENS,
  presenceColor,
  remoteNodeOutlines,
} from './presencePaint';
import { RemoteCursors } from './RemoteCursors';
import { RemoteNodeOutlines } from './RemoteNodeOutlines';
import { editingNodeId } from './useReportCanvasPresence';

import type { CanvasPresencePage } from '@huabu/shared';

const flow = vi.hoisted(() => ({
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: new Map<string, unknown>(),
}));
vi.mock('@xyflow/react', () => ({
  useViewport: () => flow.viewport,
  useInternalNode: (id: string) => flow.nodes.get(id),
  useReactFlow: () => ({ screenToFlowPosition: (point: unknown) => point }),
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, values?: { label?: string }) =>
      values?.label ? `${key}(${values.label})` : key,
  }),
}));
vi.mock('@/store/canvasStore/sync/pageId', () => ({ CANVAS_PAGE_ID: 'me' }));
vi.mock('@/store/canvasSyncSubscription', () => ({
  subscribeCanvasPresence: () => () => {},
}));
vi.mock('@/store/canvasStore', () => ({ default: { getState: () => ({}) } }));

function page(
  pageId: string,
  overrides: Partial<CanvasPresencePage> = {},
): CanvasPresencePage {
  return {
    pageId,
    colorIndex: 0,
    label: 'Chrome · Mac',
    pointer: null,
    selectedNodeIds: [],
    draggingNodeIds: [],
    editingNodeIds: [],
    ...overrides,
  };
}

function internalNode(id: string, x: number, y: number) {
  return {
    id,
    type: 'note',
    position: { x, y },
    data: {},
    measured: { width: 300, height: 200 },
    internals: { positionAbsolute: { x, y } },
  };
}

const apply = (
  event: Parameters<
    ReturnType<typeof useCanvasPresenceStore.getState>['applyEvent']
  >[0],
) => act(() => useCanvasPresenceStore.getState().applyEvent(event));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Without a ResizeObserver the outline uses the node's stored geometry.
  vi.stubGlobal('ResizeObserver', undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  flow.viewport = { x: 0, y: 0, zoom: 1 };
  flow.nodes.clear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useCanvasPresenceStore.getState().disconnect());
  vi.unstubAllGlobals();
});

describe('remote cursors', () => {
  it('draws each other page at its flow position under this page’s viewport, in its colour, with its label', () => {
    flow.viewport = { x: 100, y: -40, zoom: 2 };
    act(() => root.render(<RemoteCursors />));
    expect(container.querySelector('[data-presence-cursor]')).toBeNull();

    apply({
      op: 'snapshot',
      pages: [
        page('a', { colorIndex: 2, pointer: { x: 30, y: 50 } }),
        page('b', { colorIndex: 4, label: '', pointer: { x: -5, y: 0 } }),
        page('c', { colorIndex: 1 }),
        page('me', { pointer: { x: 1, y: 1 } }),
      ],
    });

    const layer = container.querySelector<HTMLElement>(
      '[data-presence-cursors]',
    );
    expect(layer?.style.transform).toBe('translate(100px, -40px)');
    const cursors = container.querySelectorAll<HTMLElement>(
      '[data-presence-cursor]',
    );
    // Not page `c` (pointer off the canvas) and never this page.
    expect([...cursors].map((cursor) => cursor.dataset.presenceCursor)).toEqual(
      ['a', 'b'],
    );
    expect(cursors[0]?.style.transform).toBe('translate(60px, 100px)');
    expect(cursors[0]?.querySelector('svg')?.style.color).toBe(
      'var(--accent-purple-text-fg)',
    );
    const labels = [...cursors].map(
      (cursor) =>
        cursor.querySelector<HTMLElement>('[data-presence-label]')?.textContent,
    );
    expect(labels).toEqual(['Chrome · Mac', 'canvasPresence.anotherDevice']);
    expect(
      cursors[1]?.querySelector<HTMLElement>('[data-presence-label]')?.style
        .backgroundColor,
    ).toBe('var(--accent-red-text-fg)');
  });

  it('prefers a display name, follows the pointer, and removes the marker on leave', () => {
    act(() => root.render(<RemoteCursors />));
    apply({
      op: 'update',
      page: page('a', { displayName: 'Ada', pointer: { x: 1, y: 2 } }),
    });
    const cursor = () =>
      container.querySelector<HTMLElement>('[data-presence-cursor="a"]');
    expect(cursor()?.textContent).toBe('Ada');
    apply({ op: 'pointer', pageId: 'a', pointer: { x: 7, y: 9 } });
    expect(cursor()?.style.transform).toBe('translate(7px, 9px)');
    apply({ op: 'pointer', pageId: 'a', pointer: null });
    expect(cursor()).toBeNull();
    apply({ op: 'pointer', pageId: 'a', pointer: { x: 1, y: 1 } });
    expect(cursor()).not.toBeNull();
    apply({ op: 'leave', pageId: 'a' });
    expect(cursor()).toBeNull();
  });
});

describe('remote node outlines', () => {
  const render = (onRender = vi.fn()) => {
    act(() =>
      root.render(
        <Profiler id="outlines" onRender={onRender}>
          <RemoteNodeOutlines domNode={container} />
        </Profiler>,
      ),
    );
    return onRender;
  };
  const outline = (nodeId: string, pageId = 'a') =>
    container.querySelector<HTMLElement>(
      `[data-presence-outline="${nodeId}"][data-presence-page="${pageId}"]`,
    );

  it('outlines the nodes another page selects, drags or edits, in that page’s colour', () => {
    flow.viewport = { x: 10, y: 20, zoom: 2 };
    flow.nodes.set('n1', internalNode('n1', 100, 50));
    flow.nodes.set('n2', internalNode('n2', 500, 50));
    flow.nodes.set('n3', internalNode('n3', 900, 50));
    render();
    apply({
      op: 'update',
      page: page('a', {
        colorIndex: 3,
        selectedNodeIds: ['n1', 'n2', 'n3', 'gone'],
        draggingNodeIds: ['n2'],
        editingNodeIds: ['n3'],
      }),
    });

    const selected = outline('n1');
    expect(selected?.dataset.presenceActivity).toBe('selected');
    expect(selected?.style.left).toBe('210px');
    expect(selected?.style.top).toBe('120px');
    expect(selected?.style.width).toBe('600px');
    expect(selected?.style.height).toBe('400px');
    expect(selected?.style.outline).toContain('var(--accent-green-text-fg)');
    // Outside this page's own outline, which sits on the node's edge.
    expect(selected?.style.outlineOffset).toBe('3px');
    expect(selected?.style.pointerEvents).toBe('none');
    expect(outline('n2')?.dataset.presenceActivity).toBe('dragging');
    expect(outline('n3')?.dataset.presenceActivity).toBe('editing');
    // A node this page does not have is not outlined.
    expect(outline('gone')).toBeNull();

    const label = (nodeId: string) =>
      container.querySelector(`[data-presence-outline-label="${nodeId}"]`)
        ?.textContent;
    expect(label('n1')).toBe('Chrome · Mac');
    expect(label('n2')).toBe('canvasPresence.moving(Chrome · Mac)');
    expect(label('n3')).toBe('canvasPresence.editing(Chrome · Mac)');
  });

  it('stacks two pages’ outlines on one node and removes each page’s with that page', () => {
    flow.nodes.set('n1', internalNode('n1', 0, 0));
    render();
    apply({
      op: 'snapshot',
      pages: [
        page('a', { colorIndex: 0, selectedNodeIds: ['n1'] }),
        page('b', { colorIndex: 1, selectedNodeIds: ['n1'] }),
      ],
    });
    expect(outline('n1', 'a')?.style.outlineOffset).toBe('3px');
    expect(outline('n1', 'b')?.style.outlineOffset).toBe('6px');
    apply({ op: 'update', page: page('a', { colorIndex: 0 }) });
    expect(outline('n1', 'a')).toBeNull();
    expect(outline('n1', 'b')).not.toBeNull();
    apply({ op: 'leave', pageId: 'b' });
    expect(container.querySelector('[data-presence-outline]')).toBeNull();
  });

  it('does not re-render for pointer ticks', () => {
    flow.nodes.set('n1', internalNode('n1', 0, 0));
    const onRender = render();
    apply({ op: 'update', page: page('a', { selectedNodeIds: ['n1'] }) });
    const renders = onRender.mock.calls.length;
    for (let tick = 0; tick < 10; tick += 1)
      apply({ op: 'pointer', pageId: 'a', pointer: { x: tick, y: tick } });
    expect(onRender.mock.calls.length).toBe(renders);
    expect(outline('n1')).not.toBeNull();
  });
});

describe('presence paint', () => {
  it('maps every colour index onto one of the node accent tokens', () => {
    expect(presenceColor(0)).toBe('var(--accent-teal-text-fg)');
    expect(presenceColor(5)).toBe('var(--accent-amber-fg)');
    expect(presenceColor(6)).toBe('var(--accent-teal-text-fg)');
    expect(presenceColor(-1)).toBe('var(--accent-amber-fg)');
    // One per colour index the server hands out.
    expect(PRESENCE_COLOR_TOKENS).toHaveLength(
      CANVAS_PRESENCE_LIMITS.colorCount,
    );
  });

  it('uses teal, green, amber, orange, red and purple, and never white, grey or blue', () => {
    const accents = PRESENCE_COLOR_TOKENS.map(
      (token) => /^--accent-([a-z]+)-/.exec(token)?.[1],
    );
    expect([...accents].sort()).toEqual([
      'amber',
      'green',
      'orange',
      'purple',
      'red',
      'teal',
    ]);
  });

  it('keeps label text and outlines legible on the canvas in both themes', () => {
    // The tokens' values in `index.css`, read from the file so the check
    // follows the palette. Light is `:root`, dark is `.dark`.
    const css = readFileSync('src/index.css', 'utf8');
    const [light, dark] = css.split(/^\.dark\s*\{/m);
    const value = (block: string, token: string): string => {
      const match = new RegExp(`${token}:\\s*([^;]+);`).exec(block);
      if (!match) throw new Error(`Missing ${token}`);
      const alias = /^var\((--[\w-]+)\)$/.exec(match[1].trim());
      return alias ? value(block, alias[1]) : match[1].trim();
    };
    const luminance = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((at) => {
        const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
        return channel <= 0.03928
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string): number => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (high + 0.05) / (low + 0.05);
    };
    // Label text is `--fg-inverse`; the canvas is `--bg-default`, which the
    // dark theme gives as oklch(0.145 0 0), about #0a0a0a.
    const themes = [
      { block: light, text: value(light, '--fg-inverse'), canvas: '#f5f5f5' },
      { block: dark, text: value(dark, '--fg-inverse'), canvas: '#0a0a0a' },
    ];
    expect(value(light, '--bg-default')).toBe('#f5f5f5');
    expect(value(dark, '--bg-default')).toBe('oklch(0.145 0 0)');
    for (const theme of themes) {
      for (const token of PRESENCE_COLOR_TOKENS) {
        const color = value(theme.block, token);
        expect(color, token).toMatch(/^#[0-9a-f]{6}$/i);
        // WCAG AA for the 10px label text on the marker colour.
        expect(contrast(theme.text, color), `${token} label`).toBeGreaterThan(
          4.5,
        );
        // And comfortably above the 3:1 asked of a thin outline or icon.
        expect(
          contrast(color, theme.canvas),
          `${token} outline`,
        ).toBeGreaterThan(4.3);
      }
    }
  });

  it('gives a node its strongest activity once and labels only the first plain selection', () => {
    const { pointer: _pointer, ...remote } = page('a', {
      selectedNodeIds: ['n1', 'n2', 'n3'],
      draggingNodeIds: ['n3'],
    });
    expect(
      remoteNodeOutlines({ a: remote }).map((entry) => [
        entry.nodeId,
        entry.activity,
        entry.labelled,
      ]),
    ).toEqual([
      ['n3', 'dragging', true],
      ['n1', 'selected', true],
      ['n2', 'selected', false],
    ]);
  });
});

describe('editingNodeId', () => {
  it('names the node whose text control has focus, on the canvas or in the preview panel', () => {
    container.innerHTML = `
      <div class="react-flow__node" data-id="note-1">
        <div contenteditable="true"><p id="caret">x</p></div>
        <button id="button">b</button>
      </div>
      <div class="react-flow__node" data-id="text-1"><textarea id="area"></textarea></div>
      <div class="react-flow__node" data-id="frame-1">
        <input id="frame-title" readonly />
        <textarea id="frame-area" readonly></textarea>
      </div>
      <input id="toolbar" />`;
    const panel = document.createElement('div');
    panel.innerHTML = `
      <div data-search-node-id="note-2">
        <div contenteditable="true"><p id="panel-caret">x</p></div>
        <button id="panel-button">b</button>
      </div>
      <textarea id="chat"></textarea>`;
    document.body.append(panel);
    const find = (id: string) => document.querySelector(`#${id}`);
    try {
      expect(editingNodeId(container, find('caret'))).toBe('note-1');
      expect(editingNodeId(container, find('area'))).toBe('text-1');
      expect(editingNodeId(container, find('button'))).toBeNull();
      // A title shown in a read-only field is selected, not edited.
      expect(editingNodeId(container, find('frame-title'))).toBeNull();
      expect(editingNodeId(container, find('frame-area'))).toBeNull();
      (find('frame-title') as HTMLInputElement).readOnly = false;
      expect(editingNodeId(container, find('frame-title'))).toBe('frame-1');
      expect(editingNodeId(container, find('toolbar'))).toBeNull();
      expect(editingNodeId(container, find('panel-caret'))).toBe('note-2');
      expect(editingNodeId(container, find('panel-button'))).toBeNull();
      expect(editingNodeId(container, find('chat'))).toBeNull();
      expect(editingNodeId(container, document.body)).toBeNull();
      expect(editingNodeId(container, null)).toBeNull();
    } finally {
      panel.remove();
    }
  });
});
