// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Position } from '@xyflow/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import {
  StepEdgeRoutingProvider,
  useStepEdgeRoute,
} from './StepEdgeRoutingContext';

import type { Edge, EdgeProps, Node } from '@xyflow/react';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const nodes: Node[] = [
  {
    id: 'source',
    position: { x: 0, y: 0 },
    style: { width: 100, height: 100 },
    data: {},
  },
  {
    id: 'blocker',
    position: { x: 250, y: 0 },
    style: { width: 100, height: 100 },
    data: {},
  },
  {
    id: 'target',
    position: { x: 600, y: 0 },
    style: { width: 100, height: 100 },
    data: {},
  },
];

function baseEdgeProps(overrides: Partial<EdgeProps> = {}): EdgeProps {
  return {
    id: 'e1',
    source: 'source',
    target: 'target',
    sourceX: 100,
    sourceY: 50,
    targetX: 600,
    targetY: 50,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    ...overrides,
  } as EdgeProps;
}

describe('StepEdgeRoutingProvider', () => {
  it('routes explicit step and legacy smoothstep edges while leaving default bezier and straight untouched', () => {
    const seen: Record<string, string | undefined> = {};

    function Probe({
      name,
      edgeProps,
    }: {
      name: string;
      edgeProps: EdgeProps;
    }) {
      const route = useStepEdgeRoute(edgeProps);
      seen[name] = route?.status;
      return null;
    }

    const edges: Edge[] = [
      { id: 'default', source: 'source', target: 'target' },
      {
        id: 'straight',
        source: 'source',
        target: 'target',
        data: { edgeStyle: { lineType: 'straight' } },
      },
      {
        id: 'step',
        source: 'source',
        target: 'target',
        data: { edgeStyle: { lineType: 'step' } },
      },
      {
        id: 'legacy',
        source: 'source',
        target: 'target',
        type: 'smoothstep',
      },
    ];

    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <StepEdgeRoutingProvider nodes={nodes} edges={edges}>
          <Probe name="default" edgeProps={baseEdgeProps({ id: 'default' })} />
          <Probe
            name="straight"
            edgeProps={baseEdgeProps({
              id: 'straight',
              data: { edgeStyle: { lineType: 'straight' } },
            })}
          />
          <Probe
            name="step"
            edgeProps={baseEdgeProps({
              id: 'step',
              data: { edgeStyle: { lineType: 'step' } },
            })}
          />
          <Probe
            name="legacy"
            edgeProps={baseEdgeProps({ id: 'legacy', type: 'smoothstep' })}
          />
        </StepEdgeRoutingProvider>,
      );
    });

    expect(seen).toEqual({
      default: undefined,
      straight: undefined,
      step: 'routed',
      legacy: 'routed',
    });

    act(() => root.unmount());
  });
});
