// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Which commands a source may issue: the one rule, applied by the engine
 * before any handler runs.
 *
 * `ui` (a person's page) and `system` (the Server's own bookkeeping) may
 * issue every command. `agent` may issue the commands of the agent schema
 * and none of the page-only forms:
 *
 * - no UI-only command type (`UI_ONLY_CANVAS_COMMAND_TYPES`): they depend on
 *   a page's view state, a person's protection choice, a renderer's
 *   measurement or a page's undo history;
 * - no `noteId` on `INITIALIZE_PDF_NOTE`: a page states the id it already
 *   shows, an agent reads the id from the result;
 * - no `unset` on `MERGE_NODE_DATA`: a page's way to state a removal, an
 *   agent clears with `null`.
 *
 * A command that is not allowed is reported as not applied with reason
 * `invalid-scope`; handlers do not check the source themselves.
 */

import { UI_ONLY_CANVAS_COMMAND_TYPES } from '../types/canvas/command.js';

import type {
  CanvasCommand,
  CanvasExecutionSource,
} from '../types/canvas/index.js';

const UI_ONLY_TYPES: ReadonlySet<string> = new Set(
  UI_ONLY_CANVAS_COMMAND_TYPES,
);

/** Whether `source` may issue `command`. */
export function isAllowedFor(
  source: CanvasExecutionSource,
  command: CanvasCommand,
): boolean {
  if (source !== 'agent') return true;
  if (UI_ONLY_TYPES.has(command.type)) return false;
  if (command.type === 'INITIALIZE_PDF_NOTE')
    return command.noteId === undefined;
  if (command.type === 'MERGE_NODE_DATA')
    return !(
      Array.isArray(command.patches) &&
      command.patches.some((entry) => (entry?.unset?.length ?? 0) > 0)
    );
  return true;
}
