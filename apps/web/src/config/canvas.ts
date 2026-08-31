// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas layout and grid configuration.
 *
 * GRID_SIZE is shared between the visual background grid, React Flow's
 * snap-to-grid behaviour, and all programmatic layout routines so that nodes
 * always align to the same visual grid.
 */

// Layout-grid primitives are owned by the shared canvas-engine so that
// the headless executor and the web renderer agree on snapping & padding.
export { GRID_SIZE, snapToGrid } from '@huabu/shared/canvas-engine';

import { GRID_SIZE } from '@huabu/shared/canvas-engine';

/** Convenience tuple expected by React Flow's `snapGrid` prop. */
export const SNAP_GRID: [number, number] = [GRID_SIZE, GRID_SIZE];

/**
 * Zoom range applied to React Flow as well as our custom trackpad-pinch and
 * touch-pinch handlers. Keeping a single source of truth ensures all gesture
 * paths clamp to the same limits.
 */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 5;

/** Screen-space movement required before a touch gesture becomes a drag. */
export const TOUCH_DRAG_ACTIVATION_PX = 8;

/** Screen-space movement required before a pen gesture becomes a drag. */
export const PEN_DRAG_ACTIVATION_PX = 4;

/** Mouse keeps React Flow's existing crisp desktop drag behavior. */
export const MOUSE_DRAG_ACTIVATION_PX = 1;

/**
 * Sketch tool — pointer-up stroke merging (Microsoft Whiteboard /
 * Procreate behaviour). When the user finishes a stroke, instead of
 * always creating a brand-new sketch node, we look for the nearest
 * nearby sketch region and append the stroke onto it. Merging is purely
 * spatial (time plays no role); the threshold below decides what
 * "nearby" means. See
 * `apps/web/src/components/Nodes/sketch/sketchMerge.ts` for the
 * matching algorithm.
 */

/**
 * Maximum gap (in **screen-space px**) between the new stroke's bbox
 * and a candidate node's current bbox. Distance is axis-aligned and
 * collapses to zero whenever the two rectangles overlap.
 *
 * Defined in screen-space so the on-screen "snap radius" stays the
 * same regardless of zoom (matches user intuition: "this much space on
 * my screen"). The caller is expected to convert it to flow-space via
 * `SKETCH_STROKE_MERGE_MAX_DISTANCE_SCREEN_PX / zoom` before passing
 * it to `findMergeTarget`. Mirrors the same screen-space treatment the
 * eraser brush radius uses (see `SKETCH_ERASER_RADIUS_SCREEN_PX`).
 */
export const SKETCH_STROKE_MERGE_MAX_DISTANCE_SCREEN_PX = 80;

/**
 * Eraser brush radius (in **screen-space px**) used by the sketch tool's
 * erase mode. Defined in screen-space — and intentionally decoupled from
 * the picked stroke size — so the on-screen target stays predictable
 * regardless of canvas zoom or whatever thickness the user last drew
 * with. `SketchOverlay` converts to flow-space (`/ zoom`) before hit-
 * testing existing strokes.
 *
 * This is the *default* eraser radius applied to a fresh `sketchDraft`.
 * The actual radius is user-adjustable via the eraser slider in
 * `SketchSettingsPanel` and lives on `toolStore.sketchDraft.eraserSize`.
 */
export const SKETCH_ERASER_RADIUS_SCREEN_PX = 12;

/** Minimum eraser brush radius (screen-space px) exposed to the user. */
export const SKETCH_ERASER_RADIUS_MIN_PX = 4;

/** Maximum eraser brush radius (screen-space px) exposed to the user. */
export const SKETCH_ERASER_RADIUS_MAX_PX = 64;

/**
 * Smart-snap — alignment guide & auto-snap behaviour shown while a
 * user is dragging one or more nodes.
 *
 * Defined in screen-space (rather than flow-space) so the perceived
 * "snap radius" stays constant regardless of zoom — same treatment
 * the sketch eraser radius uses. The engine converts to flow-space
 * via `SNAP_THRESHOLD_SCREEN_PX / zoom` before running candidate
 * comparisons.
 */
export const SNAP_THRESHOLD_SCREEN_PX = 6;

/**
 * Maximum number of guide overlays rendered per frame. The engine
 * already collapses overlapping guides per-axis, but a hard cap keeps
 * the SVG layer cheap on dense canvases where many candidates would
 * tie for the same snap distance.
 */
export const SNAP_MAX_GUIDES_PER_FRAME = 8;
