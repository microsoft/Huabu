// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas Artifact API Types
 *
 * Wire types for the per-canvas artifact endpoints mounted under
 * `/api/canvas/:canvasId/artifact`. Schemas are the single source of
 * truth (`docs/architecture/api-design.md`); types are derived via `z.infer`.
 *
 * Pure runtime helpers (URL parsing / building) live in
 * `utils/artifact-url.ts` so the web bundle can import them without
 * dragging zod in.
 */

import { z } from 'zod';

/**
 * Body for `POST /api/canvas/:canvasId/artifact/clone-from`.
 *
 * Used by the cross-canvas paste flow: when a user pastes a node
 * carrying an artifact URL whose canvasId differs from the destination,
 * the destination canvas asks us to clone the underlying file so it
 * owns its own copy.
 */
export const cloneArtifactBodySchema = z.object({
  /** Canvas the file currently lives in (the URL's canvasId segment). */
  srcCanvasId: z.string().min(1),
  /** Filename portion of the source URL — i.e. `<artifactId><ext>`. */
  srcKey: z.string().min(1),
});
export type CloneArtifactRequest = z.infer<typeof cloneArtifactBodySchema>;
