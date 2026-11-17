// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Admission of `POST /api/canvas/:canvasId/execute`: the one place that
 * decides, before the engine runs, who a request speaks for and whether its
 * commands may be run for them.
 *
 * 1. **The source follows the credential, not the body.** A request that
 *    arrived with an agent or machine credential is an agent's and may not
 *    call itself `ui`; `system` is for the Server's own callers and is never
 *    accepted from outside. A person's session is `ui`, and may ask to be
 *    treated as an `agent` — the narrower scope — but that is all the body
 *    can change.
 * 2. **Commands are well formed.** Each is checked against the shape of its
 *    type (`canvasCommandShapeProblem`); a malformed command refuses the
 *    request with 400 instead of failing inside a handler.
 * 3. **A page does not write bodies through `execute`.** A node's body
 *    (`content`, `src`) is protected by its content revision, which only
 *    the content PUT checks for a page and only `expectRev` checks for an
 *    agent. So for `ui`: `MERGE_NODE_DATA` may neither set nor unset a body
 *    key, and a `RESTORE_NODES` that replaces existing nodes must keep their
 *    body (`keepDataKeys`). Creating a node, or restoring one that is gone,
 *    with its body stays allowed: nothing is overwritten.
 *
 * Which command *types* a source may issue is the engine's rule
 * (`isAllowedFor`), reported per command as `invalid-scope`.
 */

import { canvasCommandShapeProblem, type CanvasCommand } from '@huabu/shared';
import { CONTENT_REVISION_KEYS } from '@huabu/shared/canvas-engine';

export type ExecuteAdmission =
  | { ok: true; source: 'ui' | 'agent'; commands: CanvasCommand[] }
  | { ok: false; status: 400 | 403; code: string; message: string };

const BODY_KEYS: ReadonlySet<string> = new Set(CONTENT_REVISION_KEYS);

/** A body key a `ui` command would overwrite, or `null`. */
function uiBodyWrite(command: CanvasCommand): string | null {
  if (command.type === 'MERGE_NODE_DATA') {
    for (const entry of command.patches) {
      for (const key of [...Object.keys(entry.patch), ...(entry.unset ?? [])])
        if (BODY_KEYS.has(key)) return key;
    }
    return null;
  }
  if (command.type === 'RESTORE_NODES' && command.replace?.length) {
    const kept = new Set(command.keepDataKeys ?? []);
    for (const key of BODY_KEYS) if (!kept.has(key)) return key;
  }
  return null;
}

export function admitExecuteRequest(input: {
  /** `originator.source` as the body states it. */
  claimedSource: 'ui' | 'agent' | 'system';
  /** The request arrived with an agent or machine credential. */
  viaAgentCredential: boolean;
  commands: readonly unknown[];
}): ExecuteAdmission {
  if (input.claimedSource === 'system')
    return {
      ok: false,
      status: 403,
      code: 'SOURCE_NOT_ALLOWED',
      message: 'System command origin is reserved for internal callers',
    };
  if (input.viaAgentCredential && input.claimedSource !== 'agent')
    return {
      ok: false,
      status: 403,
      code: 'SOURCE_NOT_ALLOWED',
      message:
        'A request made with an agent credential is an agent request; it cannot use the ui origin',
    };
  const source = input.claimedSource;
  for (const [index, command] of input.commands.entries()) {
    const problem = canvasCommandShapeProblem(command);
    if (problem)
      return {
        ok: false,
        status: 400,
        code: 'INVALID_COMMAND',
        message: `commands[${index}]: ${problem}`,
      };
  }
  const commands = input.commands as CanvasCommand[];
  if (source === 'ui') {
    for (const [index, command] of commands.entries()) {
      const key = uiBodyWrite(command);
      if (key)
        return {
          ok: false,
          status: 400,
          code: 'UI_BODY_WRITE',
          message:
            `commands[${index}]: a page saves a node's ${key} through the node content request, ` +
            'which checks its revision; execute does not overwrite it',
        };
    }
  }
  return { ok: true, source, commands };
}
