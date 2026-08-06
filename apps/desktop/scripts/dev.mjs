// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Cross-platform Electron launcher.
// Removes ELECTRON_RUN_AS_NODE (which would otherwise make Electron run as a
// plain Node process) before spawning the Electron GUI. This replaces the
// Unix-only `env -u ELECTRON_RUN_AS_NODE electron .` invocation so the dev
// script also works on Windows.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env,
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});
