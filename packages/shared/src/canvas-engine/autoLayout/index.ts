/**
 * @file CanvasPage module barrel export.
 */

export { placeNode } from './coordinator.js';
export type { LayoutOptions, LayoutResult, LayoutGraph } from './types.js';
export { DEFAULT_LAYOUT_OPTIONS } from './engine.js';
export { applyLayoutResult } from './applier.js';
