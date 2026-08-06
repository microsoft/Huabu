// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { RecentAction } from './context.js';

// ==================== Canvas Event Records ====================

/**
 * One line of `<canvasId>/.history/events.jsonl`.
 *
 * Today the only thing we persist is `RecentAction` — the same
 * discriminated union used in the live agent context. The wire / disk
 * shape is intentionally tiny: a millisecond timestamp plus the
 * structured payload. Discriminate on `payload.action` to narrow.
 */
export interface CanvasEventRecord {
  /** `Date.now()` at capture time (UTC ms). */
  ts: number;
  /** Structured user-action payload. */
  payload: RecentAction;
}

/**
 * Input shape for batch append: server fills in `ts` when callers omit
 * it (e.g. a frontend client that wants the server clock to be the
 * source of truth).
 */
export interface CanvasEventInput {
  ts?: number;
  payload: RecentAction;
}
