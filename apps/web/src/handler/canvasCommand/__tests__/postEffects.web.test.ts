// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `runWebPostEffects`: what a page does after a command batch. It releases
 * the save bookkeeping of deleted nodes and closes their previews. It asks
 * for no preprocessing: the server starts that where the batch is committed
 * (`docs/architecture/node-preprocessing.md` §4).
 */

import { describe, expect, it, vi } from 'vitest';

import { runWebPostEffects } from '../postEffects.web';

import type { PendingEffects } from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

function node(id: string, type: string): Node {
  return { id, type, position: { x: 0, y: 0 }, data: {} } as Node;
}

function run(
  mutatedNodes: Node[],
  deletedNodeIds: string[],
  forgetNodeContent: (nodeId: string) => void,
  validatePreviewNodes: (liveNodeIds: ReadonlySet<string>) => void,
) {
  runWebPostEffects({
    effects: {
      mutatedNodes,
      deletedNodeIds,
      contentEditedNodeIds: [],
      deferredFitFrameIds: [],
    } as unknown as PendingEffects,
    getNodes: () => [],
    getEdges: () => [],
    setNodes: () => undefined,
    forgetNodeContent,
    validatePreviewNodes,
  });
}

describe('runWebPostEffects', () => {
  it('does nothing for created or changed nodes', () => {
    const forget = vi.fn();
    const validate = vi.fn();
    run(
      [node('a', 'note'), node('w', 'web'), node('p', 'pdf')],
      [],
      forget,
      validate,
    );
    expect(forget).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });

  it('releases a deleted node’s save state and validates Preview Workspace against live nodes', () => {
    const forget = vi.fn();
    const validate = vi.fn();
    run([], ['deleted'], forget, validate);

    expect(forget).toHaveBeenCalledWith('deleted');
    expect(validate).toHaveBeenCalledOnce();
    expect([...validate.mock.calls[0]![0]]).toEqual([]);
  });
});
