/**
 * Canvas API types for server-client communication
 *
 * This file re-exports all canvas-related types from the canvas/ subdirectory.
 * The types have been organized into logical modules for better maintainability:
 *
 * - canvas/node.ts: Node data structures and type guards
 * - canvas/edge.ts: Edge types and styling
 * - canvas/source.ts: Per-canvas API response types
 * - canvas/layout.ts: CanvasPage calculation types
 * - canvas/operation.ts: Canvas operation types (for programmatic manipulation)
 * - canvas/canvas-api.ts: REST API request/response types
 */

export * from './canvas/index.js';
