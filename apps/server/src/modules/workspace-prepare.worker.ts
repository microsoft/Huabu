// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Child-process entry point for isolated workspace preparation. */

import { prepareWorkspaceOnDisk } from './workspace-prepare.js';

type PreparationResult = { ok: true } | { ok: false; message: string };

function finish(result: PreparationResult, exitCode: number): void {
  if (!process.send) {
    process.exit(exitCode);
    return;
  }
  process.send(result, () => {
    process.disconnect();
    process.exit(exitCode);
  });
}

const workspacePath = process.argv[2];

if (!workspacePath) {
  finish({ ok: false, message: 'Workspace path argument is required' }, 1);
} else {
  try {
    prepareWorkspaceOnDisk(workspacePath);
    finish({ ok: true }, 0);
  } catch (error) {
    finish(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      },
      1,
    );
  }
}
