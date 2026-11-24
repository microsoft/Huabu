// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What preprocessing derives for a video and keeps with the Space's
 * structure. The pipeline's own request and result types are server-side, in
 * `apps/server/src/modules/preprocessing/types.ts`: the server starts
 * preprocessing itself, so no request for it crosses the wire.
 */

import { z } from 'zod';

export const videoCoverPatchSchema = z.object({
  /** Accepted Space-local JPEG reference; null explicitly clears a stale cover. */
  coverUrl: z.string().nullable().optional(),
  /** Exact accepted source, or null when clearing the cover. */
  coverSourceSrc: z.string().nullable().optional(),
});
