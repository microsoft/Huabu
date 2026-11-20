// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Admission of `POST /api/canvas/:canvasId/execute`: the one place that
 * decides, before the engine runs, who a request speaks for and whether its
 * commands may be run for them.
 *
 * 1. **The source follows the credential.** A request that arrived with an
 *    agent or machine credential is an agent's, a person's session is `ui`.
 *    A request cannot say which: its body has no field for it
 *    (`executeRequestOriginatorSchema` refuses one), and `system` is only
 *    ever the Server's own callers.
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

import {
  canvasCommandShapeProblem,
  type CanvasCommand,
  type CanvasExecuteEditRef,
} from '@huabu/shared';
import { CONTENT_REVISION_KEYS } from '@huabu/shared/canvas-engine';

/** One edit of an admitted request. */
export interface AdmittedEdit {
  basis?: string;
  after?: CanvasExecuteEditRef[];
  commands: CanvasCommand[];
}

export type ExecuteAdmission =
  | { ok: true; source: 'ui' | 'agent'; edits: AdmittedEdit[] }
  | { ok: false; status: 400; code: string; message: string };

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
  /** The request arrived with an agent or machine credential. */
  viaAgentCredential: boolean;
  edits: readonly {
    basis?: string | undefined;
    after?: CanvasExecuteEditRef[] | undefined;
    commands: readonly unknown[];
  }[];
}): ExecuteAdmission {
  const source = input.viaAgentCredential ? 'agent' : 'ui';
  for (const [editIndex, edit] of input.edits.entries()) {
    for (const [index, command] of edit.commands.entries()) {
      const problem = canvasCommandShapeProblem(command);
      if (problem)
        return {
          ok: false,
          status: 400,
          code: 'INVALID_COMMAND',
          message: `edits[${editIndex}].commands[${index}]: ${problem}`,
        };
    }
  }
  const edits: AdmittedEdit[] = input.edits.map((edit) => ({
    ...(edit.basis !== undefined ? { basis: edit.basis } : {}),
    ...(edit.after?.length ? { after: edit.after } : {}),
    commands: edit.commands as CanvasCommand[],
  }));
  if (source === 'ui') {
    for (const [editIndex, edit] of edits.entries()) {
      for (const [index, command] of edit.commands.entries()) {
        const key = uiBodyWrite(command);
        if (key)
          return {
            ok: false,
            status: 400,
            code: 'UI_BODY_WRITE',
            message:
              `edits[${editIndex}].commands[${index}]: a page saves a node's ${key} through the node content request, ` +
              'which checks its revision; execute does not overwrite it',
          };
      }
    }
  }
  return { ok: true, source, edits };
}
