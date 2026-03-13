import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

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

/**
 * Open a native OS folder-picker dialog and return the selected path.
 * Blocks until the user selects a folder or cancels.
 * Returns `null` when the user cancels.
 */
function pickFolderNative(): string | null {
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      // PowerShell folder browser dialog — returns the selected path or empty
      const ps = `
        Add-Type -AssemblyName System.Windows.Forms
        $d = New-Object System.Windows.Forms.FolderBrowserDialog
        $d.Description = 'Select Sediment workspace folder'
        $d.ShowNewFolderButton = $true
        if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { '' }
      `.trim();
      const result = execSync(
        `powershell -NoProfile -Command "${ps.replace(/\n/g, '; ')}"`,
        { encoding: 'utf-8', timeout: 120_000 },
      ).trim();
      return result || null;
    }

    if (platform === 'darwin') {
      // macOS: AppleScript folder chooser
      const result = execSync(
        `osascript -e 'tell application "System Events" to return POSIX path of (choose folder with prompt "Select Sediment workspace folder")'`,
        { encoding: 'utf-8', timeout: 120_000 },
      ).trim();
      return result || null;
    }

    // Linux: zenity or kdialog
    try {
      const result = execSync(
        `zenity --file-selection --directory --title="Select Sediment workspace folder"`,
        { encoding: 'utf-8', timeout: 120_000 },
      ).trim();
      return result || null;
    } catch {
      // zenity not available — try kdialog
      const result = execSync(
        `kdialog --getexistingdirectory "$HOME" --title "Select Sediment workspace folder"`,
        { encoding: 'utf-8', timeout: 120_000 },
      ).trim();
      return result || null;
    }
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

    const selected = pickFolderNative();
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
