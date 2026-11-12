// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// Unpackaged Electron can also inherit a GUI launcher's PATH without nvm.
export async function ensureShellPath(): Promise<void> {
  if (process.platform === 'win32') return;
  const rawShell = process.env.SHELL?.trim();
  const shellPath =
    rawShell && isAbsolute(rawShell) && existsSync(rawShell)
      ? rawShell
      : '/bin/sh';
  const MARKER = '__HUABU_PATH__:';
  try {
    const harvested = await new Promise<string>((resolve, reject) => {
      execFile(
        shellPath,
        ['-ilc', `printf '%s' "${MARKER}$PATH"`],
        { timeout: 3_000, windowsHide: true },
        (err, stdout) => {
          if (err) return reject(err);
          const idx = stdout.lastIndexOf(MARKER);
          if (idx === -1)
            return reject(new Error('PATH marker missing from shell output'));
          resolve(stdout.slice(idx + MARKER.length).trim());
        },
      );
    });
    if (!harvested) return;
    const existing = (process.env.PATH ?? '').split(':').filter(Boolean);
    const seen = new Set(existing);
    const additions: string[] = [];
    for (const entry of harvested.split(':')) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      additions.push(entry);
    }
    if (additions.length === 0) return;
    process.env.PATH = [...additions, ...existing].join(':');
    console.log(
      `[desktop] augmented PATH from ${shellPath} (+${additions.length} entries)`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[desktop] login-shell PATH probe failed (${shellPath}): ${message}`,
    );
  }
}
