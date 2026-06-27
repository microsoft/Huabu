#!/usr/bin/env node
/**
 * Setup entry point for the hackmd-publisher Agent Team.
 *
 * Usage:
 *   node agent-setup.mjs unpack --harness claude
 *   node agent-setup.mjs validate
 *   node agent-setup.mjs doctor
 */

import { runSetup } from '@agentlet/agent-team';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

runSetup({
  onInstall(harness, workspaceDir) {
    const hackmdBin = join(workspaceDir, 'node_modules', '.bin', 'hackmd');
    if (!existsSync(hackmdBin)) {
      console.log('  Installing hackmd-cli...');
      execSync('npm init -y && npm install hackmd-cli', {
        cwd: workspaceDir,
        stdio: 'inherit',
      });
    }
  },

  onValidate(harness, workspaceDir) {
    const hackmdBin = join(workspaceDir, 'node_modules', '.bin', 'hackmd');
    if (!existsSync(hackmdBin)) {
      throw new Error('hackmd-cli is not installed in workspace');
    }
  },

  onDoctor(harness, workspaceDir, ctx) {
    const envFile = join(ctx.packageDir, '.env');
    if (!existsSync(envFile)) {
      ctx.log.warn('.env file missing — copy .env.example and fill in credentials');
    } else {
      ctx.log.success('.env file present');
    }
  },
});
