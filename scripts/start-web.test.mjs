// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'huabu-web-launcher-'));
  try {
    for (const directory of [
      'scripts',
      'packages/client-runtime/dist',
      'apps/server/dist-bundle',
      'node_modules',
    ])
      mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    cpSync(
      new URL('./start-web.mjs', import.meta.url),
      join(root, 'scripts/start-web.mjs'),
    );
    cpSync(
      dirname(require.resolve('dotenv/package.json')),
      join(root, 'node_modules/dotenv'),
      {
        recursive: true,
      },
    );
    // The launcher needs only this port of the separately built runtime.
    writeFileSync(
      join(root, 'packages/client-runtime/dist/bootstrap.js'),
      `import { resolve } from 'node:path';
       export const resolveServerDataDir = (root, configured) => resolve(root, configured || 'apps/server/data');`,
    );
    writeFileSync(
      join(root, 'apps/server/dist-bundle/server.js'),
      `console.log('LAUNCH_RESULT=' + JSON.stringify({
        sha: process.env.HUABU_DEPLOYED_SHA,
        root: process.env.HUABU_REPO_ROOT,
        web: process.env.WEB_DIST_PATH,
        data: process.env.HUABU_DATA_DIR,
      }));`,
    );
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function launch(root, env = {}, gitAvailable = false) {
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (key.startsWith('HUABU_') || key === 'WEB_DIST_PATH')
      delete inherited[key];
    if (!gitAvailable && key.toLowerCase() === 'path') inherited[key] = '';
  }
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts/start-web.mjs')],
    {
      cwd: tmpdir(),
      env: { ...inherited, ...env },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout
    .split(/\r?\n/u)
    .find((value) => value.startsWith('LAUNCH_RESULT='));
  assert.ok(line, result.stdout);
  return JSON.parse(line.slice('LAUNCH_RESULT='.length));
}

test('starts prebuilt artifacts without Git and preserves the image revision', async () => {
  await fixture((root) => {
    const sha = 'a'.repeat(40);
    const result = launch(root, { HUABU_DEPLOYED_SHA: sha });
    assert.equal(result.sha, sha);
    assert.equal(result.root, root);
    assert.equal(result.web, join(root, 'apps/web/dist'));
    assert.equal(result.data, join(root, 'apps/server/data'));
  });
});

test('starts without Git or a supplied revision', async () => {
  await fixture((root) => assert.equal(launch(root).sha, undefined));
});

test('loads a revision from .env while platform settings keep precedence', async () => {
  await fixture((root) => {
    writeFileSync(join(root, '.env'), `HUABU_DEPLOYED_SHA=${'b'.repeat(40)}\n`);
    assert.equal(launch(root).sha, 'b'.repeat(40));
    const result = launch(root, {
      HUABU_DEPLOYED_SHA: 'c'.repeat(40),
      WEB_DIST_PATH: 'custom/web',
      HUABU_DATA_DIR: join(root, 'persistent-data'),
    });
    assert.equal(result.sha, 'c'.repeat(40));
    assert.equal(result.web, join(root, 'custom/web'));
    assert.equal(result.data, join(root, 'persistent-data'));
  });
});

function initializeCheckout(root) {
  execFileSync('git', ['init', '-q', root]);
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Huabu Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${join(root, 'no-hooks')}`,
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ],
    { cwd: root },
  );
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  return sha;
}

test('discovers the startup revision in a source checkout', async () => {
  await fixture((root) => {
    const sha = initializeCheckout(root);
    assert.equal(launch(root, {}, true).sha, sha);
    assert.equal(
      launch(root, { HUABU_DEPLOYED_SHA: 'd'.repeat(40) }, true).sha,
      'd'.repeat(40),
    );
  });
});

// The legacy tmux entry is executable on Unix; Windows only uses the launcher.
test(
  'legacy redeployment discovers the new checkout revision in both environment modes',
  {
    skip: process.platform === 'win32',
  },
  async () => {
    await fixture((root) => {
      const sha = initializeCheckout(root);
      // Replace the destructive tmux/update boundary with a direct launch of the
      // real launcher. The real runner must drop the old server's revision in
      // both environment handoff modes before invoking this replacement entry.
      const hook = join(root, 'scripts', 'restart.mjs');
      writeFileSync(
        hook,
        `#!${process.execPath}\nawait import('./start-web.mjs');\n`,
      );
      chmodSync(hook, 0o755);
      for (const stdin of [false, true]) {
        const log = join(root, `runner-${stdin}.log`);
        const environment = {
          ...process.env,
          HUABU_SERVICE_MANAGER: '',
          HUABU_DEPLOYED_SHA: 'e'.repeat(40),
        };
        const result = spawnSync(
          process.execPath,
          [
            fileURLToPath(
              new URL('./canary-redeploy-runner.mjs', import.meta.url),
            ),
            hook,
            join(root, `status-${stdin}.json`),
            log,
            '100',
            'alpha',
            ...(stdin ? ['--environment-stdin'] : []),
          ],
          {
            env: environment,
            encoding: 'utf8',
            timeout: 10_000,
            ...(stdin
              ? {
                  input: `${JSON.stringify(environment)}\nHuabu redeploy runner accepted\n`,
                }
              : {}),
          },
        );
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        const output = readFileSync(log, 'utf8');
        const launched = output
          .split(/\r?\n/u)
          .find((line) => line.startsWith('LAUNCH_RESULT='));
        assert.ok(launched, output);
        assert.equal(
          JSON.parse(launched.slice('LAUNCH_RESULT='.length)).sha,
          sha,
        );
      }
    });
  },
);

// Exercise the real session environment: tmux can retain values that a new
// client no longer supplies. A private socket keeps every session test-owned.
test(
  'legacy tmux redeployment clears a retained server revision while another session survives',
  {
    skip: process.platform === 'win32',
  },
  async () => {
    await fixture(async (root) => {
      const sha = initializeCheckout(root);
      const staleSha = 'f'.repeat(40);
      const bin = join(root, 'bin');
      const socket = join(root, 'tmux.sock');
      const launchedPath = join(root, 'launched.json');
      const legacyLog = join(root, 'legacy.log');
      mkdirSync(bin);
      const environment = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HUABU_SERVICE_MANAGER: '',
      };
      delete environment.HUABU_DEPLOYED_SHA;
      // Keep host shell startup hooks and Node options out of the private server.
      delete environment.BASH_ENV;
      delete environment.ENV;
      delete environment.NODE_OPTIONS;
      delete environment.TMUX;
      delete environment.TMUX_PANE;
      const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
      const tmuxBinary = execFileSync('sh', ['-c', 'command -v tmux'], {
        encoding: 'utf8',
      }).trim();
      assert.ok(tmuxBinary, 'The Unix deployment regression requires tmux');
      function tmux(args, env = environment) {
        return execFileSync(tmuxBinary, ['-S', socket, ...args], {
          env,
          encoding: 'utf8',
          timeout: 5000,
        });
      }
      function executable(name, source) {
        writeFileSync(join(bin, name), `#!/bin/sh\n${source}\n`);
        chmodSync(join(bin, name), 0o755);
      }
      executable('tmux', `exec ${quote(tmuxBinary)} -S ${quote(socket)} "$@"`);
      // Installation/build, port inspection, and readiness are outside the
      // environment boundary. No host listener or installed app is touched.
      executable('lsof', 'exit 0');
      executable('node', 'exit 0');
      executable(
        'pnpm',
        `if [ "$1" = '--dir' ]; then exit 0; fi\n[ "$1" = 'start:web' ] || exit 2\nexec ${quote(process.execPath)} ${quote(join(root, 'scripts/start-web.mjs'))}`,
      );
      const script = join(root, 'scripts/start-huabu.sh');
      const source = readFileSync(
        new URL('./start-huabu.sh', import.meta.url),
        'utf8',
      );
      // Redirect only the legacy script's shared log into this owned fixture;
      // its actual tmux command and environment handling execute unchanged.
      assert.ok(source.includes("local log_file='/tmp/huabu-app.log'"));
      writeFileSync(
        script,
        source.replace(
          "local log_file='/tmp/huabu-app.log'",
          `local log_file=${quote(legacyLog)}`,
        ),
      );
      chmodSync(script, 0o755);
      writeFileSync(
        join(root, 'apps/server/dist-bundle/server.js'),
        `import { renameSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(launchedPath + '.tmp')}, JSON.stringify({ sha: process.env.HUABU_DEPLOYED_SHA }));
renameSync(${JSON.stringify(launchedPath + '.tmp')}, ${JSON.stringify(launchedPath)});
setInterval(() => {}, 1000);
`,
      );
      // Use real Git against a private local remote; ignore disposable runtime
      // assets so the real script's clean-checkout gate remains meaningful.
      writeFileSync(join(root, '.git/info/exclude'), '*\n');
      execFileSync('git', ['branch', '-M', 'alpha'], { cwd: root });
      execFileSync('git', ['init', '--bare', '-q', join(root, 'remote.git')]);
      execFileSync(
        'git',
        ['remote', 'add', 'origin', join(root, 'remote.git')],
        { cwd: root },
      );
      execFileSync('git', ['push', '-q', 'origin', 'alpha'], { cwd: root });
      try {
        tmux(
          [
            '-f',
            '/dev/null',
            'new-session',
            '-d',
            '-s',
            'keepalive',
            'sleep 60',
          ],
          { ...environment, HUABU_DEPLOYED_SHA: staleSha },
        );
        tmux(['set-option', '-g', 'default-shell', '/bin/bash']);
        tmux(['new-session', '-d', '-s', 'app', 'sleep 60']);
        const serverPid = tmux(['display-message', '-p', '#{pid}']).trim();
        assert.equal(
          tmux(['show-environment', '-g', 'HUABU_DEPLOYED_SHA']).trim(),
          `HUABU_DEPLOYED_SHA=${staleSha}`,
        );
        for (const stdin of [false, true]) {
          rmSync(launchedPath, { force: true });
          const result = spawnSync(
            process.execPath,
            [
              fileURLToPath(
                new URL('./canary-redeploy-runner.mjs', import.meta.url),
              ),
              script,
              join(root, `tmux-status-${stdin}.json`),
              join(root, `tmux-runner-${stdin}.log`),
              '100',
              'alpha',
              ...(stdin ? ['--environment-stdin'] : []),
            ],
            {
              env: environment,
              encoding: 'utf8',
              timeout: 15000,
              ...(stdin
                ? {
                    input: `${JSON.stringify(environment)}\nHuabu redeploy runner accepted\n`,
                  }
                : {}),
            },
          );
          assert.ifError(result.error);
          assert.equal(result.status, 0, result.stderr);
          const deadline = Date.now() + 5000;
          while (!existsSync(launchedPath) && Date.now() < deadline)
            await delay(20);
          assert.ok(existsSync(launchedPath), readFileSync(legacyLog, 'utf8'));
          const launched = JSON.parse(readFileSync(launchedPath, 'utf8'));
          assert.equal(launched.sha, sha);
          // The same server and keepalive survive; its global SHA deliberately
          // stays stale to prove the app clears the value inside its session.
          tmux(['has-session', '-t', 'keepalive']);
          assert.equal(
            tmux(['display-message', '-p', '#{pid}']).trim(),
            serverPid,
          );
          assert.equal(
            tmux(['show-environment', '-g', 'HUABU_DEPLOYED_SHA']).trim(),
            `HUABU_DEPLOYED_SHA=${staleSha}`,
          );
        }
      } finally {
        spawnSync(tmuxBinary, ['-S', socket, 'kill-server'], {
          env: environment,
          timeout: 5000,
        });
      }
    });
  },
);
