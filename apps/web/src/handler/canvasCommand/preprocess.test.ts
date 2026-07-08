import { describe, expect, it } from 'vitest';

import { buildPreprocessSnapshot } from './preprocess';

import type { Node } from '@xyflow/react';

describe('buildPreprocessSnapshot', () => {
  it('includes the current frame label so user-owned frame names stay protected', () => {
    const frame: Node = {
      id: 'frame-1',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: { label: 'Research Plan', labelSource: 'user' },
    };
    const child: Node = {
      id: 'note-1',
      type: 'note',
      parentId: frame.id,
      position: { x: 10, y: 10 },
      data: { label: 'Background' },
    };

    expect(buildPreprocessSnapshot(frame, () => [child])).toEqual({
      title: 'Research Plan',
      childLabels: ['Background'],
      labelSource: 'user',
    });
  });
});
