// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// ── Spatial reasoning utilities ──────────────────────────────────
//
// Pure spatial primitives + queries on canvas nodes.
// Zero runtime dependencies — runs on both frontend and server.
//
// Layered:
//   geometry    Rect / Point / distances / overlap / direction
//   proximity   SpatialNode + nearby / inRect queries
//   clustering  union-find clusters, reading order, summary
//
// Web only consumes geometry primitives (sketch stroke
// clustering); the rest is server-side spatial agent context.

export * from './geometry.js';
export * from './proximity.js';
export * from './clustering.js';
