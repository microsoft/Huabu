// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Host-side probe for known ACP-capable CLI binaries.
 *
 * Used by `GET /api/acp/agent-cli` to power the "Detected agents"
 * cards in the Settings UI. For each entry in {@link KNOWN_CLIS}
 * we run a lightweight `which` / `where` lookup and (when found)
 * read the first line of `<binary> --version` so the UI can show
 * the user which version is installed.
 *
 * Probes are run in parallel with a per-call timeout so a slow or
 * hung CLI never blocks the whole detection. Failure of any single
 * probe leaves that entry marked `installed: false` and never throws.
 *
 * This module performs no caching — detection is cheap (a couple of
 * spawn syscalls) and a stale cache would mislead users who just
 * installed a CLI. The route layer restricts this host-side probe to the
 * locally trusted or Basic-authenticated owner.
 */

import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';

import { KNOWN_CLIS } from './known-agents.js';

import type { AcpAgentCliInfo } from '@huabu/shared';

const execFileP = promisify(execFile);

/** Hard cap per spawned probe so a wedged CLI never blocks the request. */
const PROBE_TIMEOUT_MS = 2_500;

/**
 * Resolve a binary name against PATH. Returns the resolved absolute
 * path on success, `null` if the binary is not found or the lookup
 * itself fails for any reason.
 */
async function whichBinary(binary: string): Promise<string | null> {
  const isWin = platform() === 'win32';
  const lookup = isWin ? 'where' : 'which';
  try {
    const { stdout } = await execFileP(lookup, [binary], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const firstLine = stdout.split(/\r?\n/)[0]?.trim();
    return firstLine ? firstLine : null;
  } catch {
    return null;
  }
}

/**
 * Read the first line of `<binary> --version`. Returns the trimmed
 * line on success, empty string on probe failure (so the caller can
 * distinguish "installed but version unknown" from "not installed").
 */
async function probeVersion(binary: string): Promise<string> {
  try {
    const { stdout } = await execFileP(binary, ['--version'], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const firstLine = stdout.split(/\r?\n/)[0]?.trim() ?? '';
    return firstLine;
  } catch {
    return '';
  }
}

/**
 * Run all detection probes in parallel. Returns one {@link AcpAgentCliInfo}
 * per known CLI; UI / route layer is responsible for filtering out
 * `installed === false` entries when only installed agents should be shown.
 */
export async function detectAgentClis(): Promise<AcpAgentCliInfo[]> {
  return Promise.all(
    KNOWN_CLIS.map(async (cli) => {
      const resolved = await whichBinary(cli.binary);
      if (resolved === null) {
        return {
          id: cli.id,
          displayName: cli.displayName,
          binary: cli.binary,
          acpArgs: [...cli.acpArgs],
          autoApprove: cli.autoApprove
            ? { ...cli.autoApprove, args: [...cli.autoApprove.args] }
            : null,
          installed: false,
          installHint: cli.installHint,
        } satisfies AcpAgentCliInfo;
      }
      const version = cli.skipVersionProbe
        ? ''
        : await probeVersion(cli.binary);
      return {
        id: cli.id,
        displayName: cli.displayName,
        binary: cli.binary,
        acpArgs: [...cli.acpArgs],
        autoApprove: cli.autoApprove
          ? { ...cli.autoApprove, args: [...cli.autoApprove.args] }
          : null,
        installed: true,
        version: version || undefined,
        installHint: cli.installHint,
      } satisfies AcpAgentCliInfo;
    }),
  );
}
