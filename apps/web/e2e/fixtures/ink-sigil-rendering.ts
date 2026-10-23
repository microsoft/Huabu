// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  getInkSigilStrokes,
  inkSigilFingerprint,
} from '@huabu/shared/canvas-engine';

import useCanvasStore from '@/store/canvasStore';
import { useToolStore } from '@/store/toolStore';

import type { CanvasNode } from '@/components/Nodes/types';
import type { SketchStroke } from '@huabu/shared';

export function seedInkSigilScene(split: boolean) {
  const strokes: SketchStroke[] = [
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
    points: Array.from({ length: 11 }, (_, i) => [
      points[0][0] + ((points[1][0] - points[0][0]) * i) / 10,
      points[0][1] + ((points[1][1] - points[0][1]) * i) / 10,
      0.5,
    ]),
    color: 'black',
    size: 4,
    createdAt: index * 500,
  }));
  const nodes: CanvasNode[] = [
    {
      id: 'background',
      type: 'frame',
      position: { x: 50, y: 100 },
      style: { width: 1100, height: 500 },
      data: { label: 'Background' },
    },
    {
      id: 'ink',
      type: 'sketch',
      position: { x: 100, y: 300 },
      style: { width: 40, height: 40 },
      data: {
        initialSize: { width: 40, height: 40 },
        strokes: split ? strokes.slice(0, 2) : strokes,
      },
    },
    ...(split
      ? [
          {
            id: 'other-ink',
            type: 'sketch',
            position: { x: 100, y: 300 },
            style: { width: 40, height: 40 },
            data: {
              initialSize: { width: 40, height: 40 },
              strokes: strokes.slice(2),
            },
          },
        ]
      : []),
    {
      id: 'target',
      type: 'note',
      position: { x: 700, y: 200 },
      style: { width: 300, height: 200 },
      data: { label: 'A long resource reference', content: 'Resource' },
    },
  ];
  strokes[0].resourceBinding = {
    id: 'reference',
    strokeIds: strokes.map((stroke) => stroke.id),
    fingerprint: inkSigilFingerprint(
      getInkSigilStrokes(nodes, new Set(strokes.map((stroke) => stroke.id))),
    ),
    targetNodeId: 'target',
    targetType: 'note',
    label: 'A long resource reference',
  };
  useToolStore.getState().setInputModePreference('pen');
  useCanvasStore.getState()._setStateNoAutosave({ nodes });
}

export function selectInk() {
  useCanvasStore.getState().selectNodes(['ink'], false);
}
