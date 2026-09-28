// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from 'vitest';

import { nodesInSelection } from '@/components/Panels/Canvas/areaSelection';
import { useNodeCollapseStore } from '@/store/nodeCollapseStore';

import type { ReactFlowInstance } from '@xyflow/react';

function instance(): Pick<ReactFlowInstance, 'getNodes'> {
  return {
    getNodes: () => [
      {
        id: 'question-1',
        type: 'question',
        position: { x: 0, y: 0 },
        measured: { width: 200, height: 100 },
        data: {},
      },
      {
        id: 'note-1',
        type: 'note',
        position: { x: 100, y: 100 },
        measured: { width: 40, height: 40 },
        data: {},
      },
    ],
  };
}

function getSelectedNodeIdsFromFlowPolygon(
  points: Array<{ x: number; y: number }>,
  flow: Pick<ReactFlowInstance, 'getNodes'>,
) {
  return nodesInSelection(flow.getNodes(), { kind: 'polygon', points });
}

beforeEach(() => {
  useNodeCollapseStore.setState({ marks: {} });
});

describe('Lasso visible-node hit testing', () => {
  it('keeps ordinary React Flow footprint intersection behavior', () => {
    expect(
      getSelectedNodeIdsFromFlowPolygon(
        [
          { x: 105, y: 105 },
          { x: 130, y: 105 },
          { x: 130, y: 130 },
          { x: 105, y: 130 },
        ],
        instance(),
      ),
    ).toContain('note-1');
  });

  it('selects a collapsed Question by its visible Agent mark', () => {
    useNodeCollapseStore.setState({
      marks: {
        'question-1': {
          cx: 310,
          cy: 310,
          radius: 15,
          progress: 1,
          footprint: { x: 0, y: 0, width: 200, height: 100 },
        },
      },
    });

    expect(
      getSelectedNodeIdsFromFlowPolygon(
        [
          { x: 290, y: 290 },
          { x: 330, y: 290 },
          { x: 330, y: 330 },
          { x: 290, y: 330 },
        ],
        instance(),
      ),
    ).toContain('question-1');
  });

  it('does not select the hidden Question footprint when its mark moved away', () => {
    useNodeCollapseStore.setState({
      marks: {
        'question-1': {
          cx: 310,
          cy: 310,
          radius: 15,
          progress: 1,
          footprint: { x: 0, y: 0, width: 200, height: 100 },
        },
      },
    });

    expect(
      getSelectedNodeIdsFromFlowPolygon(
        [
          { x: 10, y: 10 },
          { x: 50, y: 10 },
          { x: 50, y: 50 },
          { x: 10, y: 50 },
        ],
        instance(),
      ),
    ).not.toContain('question-1');
  });
});
