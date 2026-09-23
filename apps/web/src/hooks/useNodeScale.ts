// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { contentScaleFor, getHeightPolicy } from '@huabu/shared/canvas-engine';

import useCanvasStore from '@/store/canvasStore';

/**
 * Returns a scale factor based on the node's current width relative to its
 * reference width.  Content containers can wrap their children with a CSS
 * `transform: scale(factor)` so text and layout scale proportionally when
 * the node is resized.
 *
 * Delegates to the shared `contentScaleFor` rather than recomputing the
 * ratio: the headless conversion from an intrinsic content height to a
 * node layout height has to apply the identical factor, and a second
 * formula here is a second place for it to drift — including the node
 * shell inset, which is easy to forget and changes where text wraps.
 *
 * Manual document bodies retain their 0.5 floor. Notes have no reference
 * width and use an untransformed actual-width viewport instead.
 */
export function useNodeScale(nodeId: string, nodeType: string): number {
  const policy = getHeightPolicy(nodeType);

  return useCanvasStore((state) => {
    if (!policy.refWidth) return 1;
    const node = state.nodes.find((n) => n.id === nodeId);
    const width = node?.style?.width as number | undefined;
    return contentScaleFor(policy, width);
  });
}
