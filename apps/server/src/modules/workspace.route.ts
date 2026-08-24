// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validatePathSchema, workspacePathSchema } from '@huabu/shared';

import { resetPreprocessDispatcher } from './preprocessing/index.js';
import { getStructuredStore, resetStorageCache } from './storage/index.js';
import {
  activateWorkspacePath,
  WorkspaceActivationInProgressError,
  WorkspaceActivationTimeoutError,
} from './workspace-activation.js';
import {
  getWorkspaceHandle,
  getWorkspacePath,
  isManagedMode,
} from './workspace.js';

import type {
  ApiErrorBody,
  ApiResult,
  PickFolderResult,
  ValidatePathRequest,
  ValidatePathResponse,
  WorkspaceInfo,
  WorkspacePathRequest,
} from '@huabu/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

/**
 * Run a command and return its stdout, or null on failure.
 * Used to detect optional helpers like `osascript` / `zenity` / `kdialog`.
 */
async function runAndTrim(cmd: string, args: string[]): Promise<string | null> {
  try {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const code: number = await new Promise((resolve) => {
      child.on('close', (c) => resolve(c ?? 1));
      child.on('error', () => resolve(1));
    });
    if (code !== 0) return null;
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Whether the server can actually display a native folder picker.
 * On headless Linux (no $DISPLAY) we short-circuit so the client can
 * fall back to a text-input UI immediately instead of waiting 120s.
 */
function canShowNativePicker(): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return true;
  }
  return !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
}

/**
 * Open a native OS folder-picker dialog and return the selected path.
 */
async function pickFolderNative(): Promise<string | null> {
  if (process.platform === 'darwin') {
    const script =
      'POSIX path of (choose folder with prompt "Select Huabu Home folder")';
    return runAndTrim('osascript', ['-e', script]);
  }
  if (process.platform === 'win32') {
    // PowerShell FolderBrowserDialog. FolderBrowserDialog has no TopMost
    // property, so without an owner window it opens *behind* the active
    // window (e.g. the browser) and looks like nothing happened. We give
    // it a hidden, always-on-top owner form so the dialog surfaces to the
    // foreground.
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$owner = New-Object System.Windows.Forms.Form;',
      '$owner.TopMost = $true;',
      '$owner.ShowInTaskbar = $false;',
      '$owner.Opacity = 0;',
      '$owner.Show();',
      '$owner.Activate();',
      '$f = New-Object System.Windows.Forms.FolderBrowserDialog;',
      '$f.Description = "Select Huabu Home folder";',
      '$result = $f.ShowDialog($owner);',
      '$owner.Dispose();',
      'if ($result -eq "OK") { Write-Output $f.SelectedPath }',
    ].join(' ');
    return runAndTrim('powershell', ['-NoProfile', '-STA', '-Command', ps]);
  }
  // Linux: try zenity then kdialog
  const zenity = await runAndTrim('zenity', [
    '--file-selection',
    '--directory',
    '--title=Select Huabu Home folder',
  ]);
  if (zenity) return zenity;
  const kdialog = await runAndTrim('kdialog', [
    '--getexistingdirectory',
    process.env.HOME ?? tmpdir(),
    '--title',
    'Select Huabu Home folder',
  ]);
  return kdialog;
}

/**
 * Free-mode admin operations touch the host filesystem (folder picker,
 * arbitrary path validation). Restrict them to localhost so a LAN peer
 * cannot redirect storage to an arbitrary location on the host.
 *
 * In managed mode these endpoints remain registered but return 403.
 */
function isLocalhost(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// ────────────────────────────────────────────────────────────────────
// Unified response shape
//
// Success bodies are returned as plain payloads (`WorkspaceInfo`,
// `ValidatePathResponse`, `PickFolderResult`). Errors use the shared
// `ApiErrorBody` envelope with HTTP 4xx status codes — the same shape
// the rest of the API uses, so the client's `apiFetch` handles them
// uniformly. `PickFolderResult` retains its own `{ ok }` discriminator
// because "cancelled" / "no-picker" are *business* outcomes returned
// with HTTP 200, not error conditions.
// ────────────────────────────────────────────────────────────────────

function sendError(
  reply: FastifyReply,
  status: number,
  message: string,
  code?: string,
  details?: unknown,
): FastifyReply {
  const body: ApiErrorBody = {
    message,
    ...(code ? { code } : {}),
    ...(details !== undefined ? { details } : {}),
  };
  return reply.status(status).send(body);
}

/** Build the canonical success payload describing the current workspace. */
async function buildWorkspaceState(): Promise<WorkspaceInfo> {
  const managed = isManagedMode();
  const workspace = getWorkspaceHandle();
  const configured = workspace !== null;
  return {
    mode: managed ? 'managed' : 'free',
    configured,
    workspaceId: workspace?.workspaceId ?? null,
    // Free-mode active absolute path. Never exposed in managed mode.
    path: workspace && !managed ? getWorkspacePath() : null,
    // Persisted display label. Safe to send in either mode.
    name: workspace?.name ?? null,
    worldCanvasId: configured
      ? await getStructuredStore().spaces().worldId()
      : null,
    capabilities: {
      canChangeWorkspace: !managed,
      nativePicker: !managed && canShowNativePicker(),
    },
  };
}

const workspaceRoutes: FastifyPluginAsync = async (app) => {
  // ────────────────────────────────────────────────────────────────
  // GET /api/workspace — read-only state + capabilities
  // Always available (clients need to know the mode).
  // ────────────────────────────────────────────────────────────────
  app.get<{ Reply: ApiResult<WorkspaceInfo> }>('/', async () =>
    buildWorkspaceState(),
  );

  // ────────────────────────────────────────────────────────────
  // The endpoints below mutate the active workspace and only exist
  // in free mode. Managed mode rejects them with 403.
  // ────────────────────────────────────────────────────────────

  app.post<{ Reply: ApiResult<PickFolderResult> }>(
    '/pick-folder',
    async (request, reply) => {
      if (isManagedMode()) {
        return sendError(reply, 403, 'Workspace is locked');
      }
      if (!isLocalhost(request.ip)) {
        return sendError(
          reply,
          403,
          'Forbidden: workspace settings can only be changed from localhost',
        );
      }
      if (!canShowNativePicker()) {
        // Not a true error — the client falls back to a manual path input.
        return reply.send({ ok: false, reason: 'no-picker' as const });
      }
      const selected = await pickFolderNative();
      if (!selected) {
        return reply.send({ ok: false, reason: 'cancelled' as const });
      }
      return reply.send({ ok: true, path: selected });
    },
  );

  app.post<{
    Body: ValidatePathRequest;
    Reply: ApiResult<ValidatePathResponse>;
  }>('/validate-path', async (request, reply) => {
    if (isManagedMode()) {
      return sendError(reply, 403, 'Workspace is locked');
    }
    if (!isLocalhost(request.ip)) {
      return sendError(reply, 403, 'Forbidden');
    }
    const parsed = validatePathSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        parsed.error.issues[0]?.message ?? 'Invalid request body',
      );
    }
    const pathExists = existsSync(path.resolve(parsed.data.path));
    return reply.send({ path: parsed.data.path, exists: pathExists });
  });

  app.put<{
    Body: WorkspacePathRequest;
    Reply: ApiResult<WorkspaceInfo>;
  }>('/', async (request, reply) => {
    if (isManagedMode()) {
      return sendError(
        reply,
        403,
        'Workspace is locked by the server (managed mode). Restart with a different HUABU_WORKSPACE to switch.',
      );
    }
    if (!isLocalhost(request.ip)) {
      return sendError(
        reply,
        403,
        'Forbidden: workspace settings can only be changed from localhost',
      );
    }
    const parsed = workspacePathSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        parsed.error.issues[0]?.message ?? 'Invalid request body',
      );
    }
    try {
      await activateWorkspacePath(parsed.data.path);
      // Reset singletons that cache filesystem handles for the old workspace.
      resetStorageCache();
      resetPreprocessDispatcher();
      return await buildWorkspaceState();
    } catch (e) {
      if (e instanceof WorkspaceActivationTimeoutError) {
        return sendError(
          reply,
          504,
          e.message,
          'WORKSPACE_ACTIVATION_TIMEOUT',
          {
            seconds: e.timeoutSeconds,
          },
        );
      }
      if (e instanceof WorkspaceActivationInProgressError) {
        return sendError(
          reply,
          409,
          e.message,
          'WORKSPACE_ACTIVATION_IN_PROGRESS',
        );
      }
      return sendError(reply, 400, (e as Error).message);
    }
  });
};

export default workspaceRoutes;
