import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { z } from 'zod';

import { ensureDefaultCanvas } from './canvas/canvas.filestore.js';
import {
  resetKnowledgeRepository,
  resetIngestService,
} from './knowledge/index.js';
import {
  getWorkspacePath,
  isWorkspaceConfigured,
  setWorkspacePath,
} from './workspace.js';

import type { FastifyPluginAsync } from 'fastify';

const execFileAsync = promisify(execFile);

/**
 * Run a command asynchronously and return trimmed stdout, or `null` on error.
 */
async function runAndTrim(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      encoding: 'utf-8',
      timeout: 120_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Open a native OS folder-picker dialog and return the selected path.
 * Runs the dialog process asynchronously so the Node event loop is not blocked.
 * Returns `null` when the user cancels.
 */
async function pickFolderNative(): Promise<string | null> {
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      // PowerShell folder browser dialog — returns the selected path or empty
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$d.Description = 'Select Sediment workspace folder'",
        '$d.ShowNewFolderButton = $true',
        "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { '' }",
      ].join('; ');
      return await runAndTrim('powershell', ['-NoProfile', '-Command', ps]);
    }

    if (platform === 'darwin') {
      // macOS: AppleScript folder chooser
      return await runAndTrim('osascript', [
        '-e',
        'tell application "System Events" to return POSIX path of (choose folder with prompt "Select Sediment workspace folder")',
      ]);
    }

    // Linux: zenity or kdialog
    const zenity = await runAndTrim('zenity', [
      '--file-selection',
      '--directory',
      '--title=Select Sediment workspace folder',
    ]);
    if (zenity) return zenity;

    return await runAndTrim('kdialog', [
      '--getexistingdirectory',
      process.env.HOME ?? '/',
      '--title',
      'Select Sediment workspace folder',
    ]);
  } catch {
    // User cancelled or dialog failed
    return null;
  }
}

/**
 * Guard: only allow requests from localhost.
 */
function isLocalhost(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const workspaceRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/workspace – return current workspace path and config status
  app.get('/workspace', async () => {
    const configured = isWorkspaceConfigured();
    return {
      path: configured ? getWorkspacePath() : null,
      configured,
    };
  });

  // POST /api/workspace/pick-folder – open native folder picker
  app.post('/workspace/pick-folder', async (request, reply) => {
    if (!isLocalhost(request.ip)) {
      return reply.status(403).send({
        message:
          'Forbidden: workspace settings can only be changed from localhost',
      });
    }

    const selected = await pickFolderNative();
    if (!selected) {
      return reply.send({ cancelled: true, path: null });
    }

    return reply.send({ cancelled: false, path: selected });
  });

  // POST /api/workspace/validate-path – check if a path exists on disk
  app.post('/workspace/validate-path', async (request, reply) => {
    if (!isLocalhost(request.ip)) {
      return reply.status(403).send({ message: 'Forbidden' });
    }

    const schema = z.object({
      path: z.string().min(1, 'Path is required'),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ message: parsed.error.issues[0]?.message });
    }

    const pathExists = existsSync(parsed.data.path);
    return reply.send({ path: parsed.data.path, exists: pathExists });
  });

  // PUT /api/workspace – update workspace path.
  // Restricted to requests originating from localhost: this server is a
  // local-only process and we do not want LAN peers to be able to redirect
  // storage to an arbitrary path on the user's machine.
  app.put('/workspace', async (request, reply) => {
    if (!isLocalhost(request.ip)) {
      return reply.status(403).send({
        message:
          'Forbidden: workspace settings can only be changed from localhost',
      });
    }

    const schema = z.object({
      path: z.string().min(1, 'Workspace path is required'),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ message: parsed.error.issues[0]?.message });
    }

    setWorkspacePath(parsed.data.path);
    // Reset knowledge singletons so they re-initialise against the new path
    resetKnowledgeRepository();
    resetIngestService();
    // Ensure a default canvas file exists in the new workspace
    ensureDefaultCanvas();
    return { path: getWorkspacePath() };
  });
};

export default workspaceRoutes;
