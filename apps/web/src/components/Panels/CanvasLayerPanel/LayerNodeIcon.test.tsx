// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CanvasSearchNodeIcon, LayerNodeIcon } from './LayerNodeIcon';
import useCanvasStore from '../../../store/canvasStore';

import type { DataSourceNodeLike } from './types';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const initialNodes = useCanvasStore.getState().nodes;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useCanvasStore.setState({ nodes: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useCanvasStore.setState({ nodes: initialNodes });
});

function renderPair(type: string, data: DataSourceNodeLike['data']) {
  const node = { id: 'node', type, data, position: { x: 0, y: 0 } };
  act(() => {
    useCanvasStore.setState({ nodes: [node] });
    root.render(
      <>
        <div data-tree>
          <LayerNodeIcon node={node} />
        </div>
        <div data-search>
          <CanvasSearchNodeIcon nodeId="node" nodeType={type} isEdge={false} />
        </div>
      </>,
    );
  });
  expect(container.querySelector('[data-search]')?.innerHTML).toBe(
    container.querySelector('[data-tree]')?.innerHTML,
  );
}

describe('shared Layers node icons', () => {
  it.each([
    ['docx', 'file-text'],
    ['xlsx', 'sheet'],
    ['pptx', 'presentation'],
  ])('uses the same %s Office icon in search and the tree', (format, icon) => {
    renderPair('office', { label: 'Office', format });
    expect(
      container.querySelector(`[data-search] .lucide-${icon}`),
    ).not.toBeNull();
  });

  it('renders the same sketch thumbnail and falls back to Pencil for an empty sketch', () => {
    renderPair('sketch', {
      label: 'Sketch',
      initialSize: { width: 100, height: 100 },
      strokes: [
        {
          id: 'stroke',
          points: [
            [0, 0, 0.5],
            [50, 50, 0.5],
          ],
        },
      ],
    });
    expect(
      container.querySelector('[data-search] polyline')?.getAttribute('points'),
    ).toBe('0,0 50,50');
    renderPair('sketch', { label: 'Empty sketch', strokes: [] });
    expect(
      container.querySelector('[data-search] .lucide-pencil'),
    ).not.toBeNull();
  });

  it.each(['running', 'done', 'error'])(
    'shares the %s Agent status indicator',
    (status) => {
      renderPair('question', { label: 'Agent', status });
      expect(
        container.querySelector('[data-search] [role="status"]'),
      ).not.toBeNull();
    },
  );

  it('updates the search icon when live node data changes without a new query', () => {
    renderPair('office', { label: 'Office', format: 'docx' });
    act(() =>
      useCanvasStore.setState({
        nodes: [
          {
            id: 'node',
            type: 'office',
            position: { x: 0, y: 0 },
            data: { label: 'Office', format: 'xlsx' },
          },
        ],
      }),
    );
    expect(
      container.querySelector('[data-search] .lucide-sheet'),
    ).not.toBeNull();
  });

  it('removes the unread dot after the answer is viewed', () => {
    renderPair('question', { label: 'Agent', status: 'done' });
    act(() =>
      useCanvasStore.setState({
        nodes: [
          {
            id: 'node',
            type: 'question',
            position: { x: 0, y: 0 },
            data: { label: 'Agent', status: 'done', viewed: true },
          },
        ],
      }),
    );
    expect(container.querySelector('[data-search] [role="status"]')).toBeNull();
  });

  it('preserves type fallbacks for missing nodes and Spline for edge results', () => {
    act(() =>
      root.render(
        <>
          <div data-missing>
            <CanvasSearchNodeIcon
              nodeId="missing"
              nodeType="office"
              isEdge={false}
            />
          </div>
          <div data-edge>
            <CanvasSearchNodeIcon nodeId="missing" nodeType="frame" isEdge />
          </div>
        </>,
      ),
    );
    expect(
      container.querySelector('[data-missing] .lucide-file-type-corner'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-edge] .lucide-spline'),
    ).not.toBeNull();
  });
});
