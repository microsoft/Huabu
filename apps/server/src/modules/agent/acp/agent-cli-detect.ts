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
 * installed a CLI. The route layer is loopback-only and unauthenticated
 * past the loopback check.
 */

import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';

import type { AcpAgentCliInfo } from '@sediment/shared';

const execFileP = promisify(execFile);

/** Hard cap per spawned probe so a wedged CLI never blocks the request. */
const PROBE_TIMEOUT_MS = 2_500;

interface KnownCli {
  id: string;
  displayName: string;
  binary: string;
  acpArgs: string[];
  /**
   * Recognized auto-approve flag for this CLI, or `null` if none is
   * exposed as a simple toggle. Claude has `--dangerously-skip-permissions`
   * but we intentionally do NOT surface it as a one-click toggle — users
   * who want it can build the command manually.
   */
  allowAllFlag: string | null;
  installHint: string;
}

/**
 * Canonical catalogue of ACP-capable CLIs the Settings UI knows how to
 * launch via agentlet. Order is the order shown in the UI.
 */
export const KNOWN_CLIS: readonly KnownCli[] = [
  {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    binary: 'copilot',
    acpArgs: ['--acp'],
    allowAllFlag: '--allow-all',
    installHint: 'npm install -g @github/copilot',
  },
  {
    id: 'claude',
    displayName: 'Claude Code',
    binary: 'claude',
    acpArgs: ['--acp'],
    allowAllFlag: null,
    installHint: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    binary: 'gemini',
    acpArgs: ['--acp'],
    allowAllFlag: null,
    installHint: 'npm install -g @google/gemini-cli',
  },
];

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
          allowAllFlag: cli.allowAllFlag,
          installed: false,
          installHint: cli.installHint,
        } satisfies AcpAgentCliInfo;
      }
      const version = await probeVersion(cli.binary);
      return {
        id: cli.id,
        displayName: cli.displayName,
        binary: cli.binary,
        acpArgs: [...cli.acpArgs],
        allowAllFlag: cli.allowAllFlag,
        installed: true,
        version: version || undefined,
        installHint: cli.installHint,
      } satisfies AcpAgentCliInfo;
    }),
  );
}
