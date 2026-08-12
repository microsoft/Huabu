// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `runWebPostEffects` preprocessing fan-out (the P0.5 label-churn fix).
 *
 * Editor-authored nodes (`note` / `text`) must NOT trigger preprocessing on
 * every keystroke content edit — that re-derived + renamed the `.md` on every
 * keystroke pause. Those content edits (which arrive in `contentEditedNodeIds`)
 * are settled instead when the user leaves the editor (settle →
 * `settleNodePreprocess`). But a one-time create / duplicate / import mutation
 * is NOT a content edit (it never appears in `contentEditedNodeIds`), so it
 * still fans out once. Every other node type always fans out on mutation. See
 * `docs/architecture/node-preprocessing.md` §4 (Triggers & state).
 */

import { describe, expect, it, vi } from 'vitest';

import { runWebPostEffects } from '../postEffects.web';

import type { PendingEffects } from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

function node(id: string, type: string): Node {
  return { id, type, position: { x: 0, y: 0 }, data: {} } as Node;
}

function effectsWith(
  mutatedNodes: Node[],
  contentEditedNodeIds: string[] = [],
): PendingEffects {
  return {
    mutatedNodes,
    deletedNodeIds: [],
    contentEditedNodeIds,
    deferredFitFrameIds: [],
  } as unknown as PendingEffects;
}

function run(
  mutatedNodes: Node[],
  triggerPreprocessing: (n: Node) => void,
  contentEditedNodeIds: string[] = [],
  validatePreviewNodes: (liveNodeIds: ReadonlySet<string>) => void = () =>
    undefined,
  deletedNodeIds: string[] = [],
) {
  runWebPostEffects({
    effects: {
      ...effectsWith(mutatedNodes, contentEditedNodeIds),
      deletedNodeIds,
    },
    canvasId: 'c1',
    getNodes: () => [],
    getEdges: () => [],
    setNodes: () => undefined,
    triggerPreprocessing,
    forgetNodeContent: () => undefined,
    validatePreviewNodes,
  });
}

describe('runWebPostEffects — settle-triggered types skip content-edit preprocess', () => {
  it('does NOT trigger preprocess for note / text on a keystroke content edit', () => {
    const trigger = vi.fn();
    run([node('a', 'note'), node('b', 'text')], trigger, ['a', 'b']);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('DOES trigger preprocess once for note / text on create / import (not a content edit)', () => {
    const trigger = vi.fn();
    const note = node('a', 'note');
    const text = node('b', 'text');
    run([note, text], trigger, []);
    expect(trigger).toHaveBeenCalledTimes(2);
    expect(trigger).toHaveBeenCalledWith(note);
    expect(trigger).toHaveBeenCalledWith(text);
  });

  it('still triggers preprocess for artifact / other types on mutation', () => {
    const trigger = vi.fn();
    const web = node('w', 'web');
    const pdf = node('p', 'pdf');
    run([web, pdf], trigger);
    expect(trigger).toHaveBeenCalledTimes(2);
    expect(trigger).toHaveBeenCalledWith(web);
    expect(trigger).toHaveBeenCalledWith(pdf);
  });

  it('skips an authored content edit, keeps the rest, in a mixed batch', () => {
    const trigger = vi.fn();
    const note = node('n', 'note');
    const web = node('w', 'web');
    run([note, web], trigger, ['n']);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(web);
    expect(trigger).not.toHaveBeenCalledWith(note);
  });

  it('validates Preview Workspace against live nodes after deletion', () => {
    const validate = vi.fn();
    run([], vi.fn(), [], validate, ['deleted']);

    expect(validate).toHaveBeenCalledOnce();
    expect([...validate.mock.calls[0]![0]]).toEqual([]);
  });
});
