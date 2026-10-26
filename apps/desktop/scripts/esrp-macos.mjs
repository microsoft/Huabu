import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const architectures = ['arm64', 'x64'];
const appName = 'Huabu.app';
const bundleId = 'com.huabu.app';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  );
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function sha512(bytes) {
  return createHash('sha512').update(bytes).digest('base64');
}

export function validateSignature(details, expectedTeam) {
  assert.match(
    details,
    /^Identifier=com\.huabu\.app$/m,
    'Unexpected application identifier',
  );
  assert.match(
    details,
    /^Authority=Developer ID Application:/m,
    'Expected Developer ID Application signing',
  );
  assert.match(details, /flags=.*\bruntime\b/, 'Hardened runtime is required');
  assert.match(
    details,
    /^Timestamp=.+/m,
    'Secure signing timestamp is required',
  );
  const team = details.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1];
  assert.ok(team, 'Missing signing TeamIdentifier');
  if (expectedTeam) assert.equal(team, expectedTeam, 'Signing team changed');
  return team;
}

export function validateEntitlements(entitlements) {
  assert.equal(
    entitlements['com.apple.security.cs.allow-jit'],
    true,
    'Electron requires the JIT entitlement',
  );
  assert.notEqual(
    entitlements['com.apple.security.get-task-allow'],
    true,
    'Release apps must not enable debugging',
  );
}

function verifyApp(app, arch, expectedTeam, notarized = false) {
  run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    app,
  ]);
  const team = validateSignature(
    run('/usr/bin/codesign', ['--display', '--verbose=4', app]),
    expectedTeam,
  );
  assert.equal(
    run('/usr/bin/plutil', [
      '-extract',
      'CFBundleIdentifier',
      'raw',
      '-o',
      '-',
      path.join(app, 'Contents/Info.plist'),
    ]).trim(),
    bundleId,
  );
  assert.equal(
    run('/usr/bin/lipo', [
      '-archs',
      path.join(app, 'Contents/MacOS/Huabu'),
    ]).trim(),
    arch === 'x64' ? 'x86_64' : 'arm64',
  );
  for (const executable of [
    app,
    path.join(app, 'Contents/Frameworks/Huabu Helper (Renderer).app'),
  ]) {
    const result = spawnSync(
      '/usr/bin/codesign',
      ['--display', '--entitlements', ':-', executable],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const entitlements = run(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', '-'],
      { input: result.stdout },
    );
    validateEntitlements(JSON.parse(entitlements));
  }
  if (notarized) {
    run('/usr/bin/xcrun', ['stapler', 'validate', app]);
    run('/usr/sbin/spctl', [
      '--assess',
      '--type',
      'execute',
      '--verbose=2',
      app,
    ]);
  }
  return team;
}

export function archiveArguments(destination) {
  return ['-r', '-y', destination, appName];
}

async function extract(archive, destination) {
  await mkdir(destination, { recursive: false });
  run('/usr/bin/ditto', ['-x', '-k', archive, destination]);
  return path.join(destination, appName);
}

async function archiveApps(root) {
  const hashes = {};
  for (const arch of architectures) {
    const input = path.join(root, 'sign-input', arch);
    await mkdir(input, { recursive: true });
    const zip = path.join(input, 'Huabu.zip');
    const prepared = path.join(
      root,
      'prepared',
      arch === 'x64' ? 'mac' : 'mac-arm64',
    );
    run('/usr/bin/zip', archiveArguments(zip), { cwd: prepared });
    hashes[arch] = sha512(await readFile(zip));
  }
  await writeFile(
    path.join(root, 'unsigned-hashes.json'),
    JSON.stringify(hashes),
  );
}

async function prepareNotarization(root) {
  const hashes = JSON.parse(
    await readFile(path.join(root, 'unsigned-hashes.json'), 'utf8'),
  );
  const teams = {};
  await mkdir(path.join(root, 'signed'), { recursive: true });
  for (const arch of architectures) {
    const zip = path.join(root, 'sign-input', arch, 'Huabu.zip');
    assert.notEqual(
      sha512(await readFile(zip)),
      hashes[arch],
      `ESRP did not replace the ${arch} signing input ZIP`,
    );
    const app = await extract(zip, path.join(root, 'signed', arch));
    teams[arch] = verifyApp(app, arch, teams.arm64);
    const input = path.join(root, 'notarize-input', arch);
    await mkdir(input, { recursive: true });
    await copyFile(zip, path.join(input, 'Huabu.zip'));
  }
  await writeFile(path.join(root, 'signing-teams.json'), JSON.stringify(teams));
}

export function packagingOptions(app, arch, output) {
  assert.ok(architectures.includes(arch), 'Unsupported architecture');
  return {
    projectDir: desktop,
    prepackaged: app,
    publish: 'never',
    config: {
      directories: { output },
      mac: { identity: null, notarize: false },
    },
  };
}

export async function mergeReleaseMetadata(directories, output, version) {
  const metadata = [];
  const names = new Set();
  for (const directory of directories) {
    const info = YAML.parse(
      await readFile(path.join(directory, 'latest-mac.yml'), 'utf8'),
    );
    assert.equal(info.version, version, 'Unexpected macOS release version');
    assert.ok(
      Array.isArray(info.files) && info.files.length === 2,
      'Expected one DMG and one ZIP per architecture',
    );
    assert.deepEqual(info.files.map((file) => path.extname(file.url)).sort(), [
      '.dmg',
      '.zip',
    ]);
    for (const file of info.files) {
      assert.equal(
        path.basename(file.url),
        file.url,
        'Release asset must be a basename',
      );
      assert.ok(
        !/[\\/]/.test(file.url),
        'Release asset must not contain a path',
      );
      assert.ok(
        !names.has(file.url),
        `Duplicate macOS release asset: ${file.url}`,
      );
      names.add(file.url);
      const bytes = await readFile(path.join(directory, file.url));
      assert.equal(bytes.length, file.size, `Incorrect size: ${file.url}`);
      assert.equal(sha512(bytes), file.sha512, `Incorrect hash: ${file.url}`);
      await readFile(path.join(directory, `${file.url}.blockmap`));
    }
    metadata.push(info);
  }
  await mkdir(output, { recursive: true });
  for (const [index, info] of metadata.entries()) {
    for (const file of info.files) {
      for (const name of [file.url, `${file.url}.blockmap`]) {
        await copyFile(
          path.join(directories[index], name),
          path.join(output, name),
        );
      }
    }
  }
  const merged = {
    ...metadata[0],
    files: metadata.flatMap((info) => info.files),
  };
  const primary = merged.files.find((file) => file.url === merged.path);
  assert.ok(primary, 'Missing primary update asset');
  assert.equal(primary.sha512, merged.sha512, 'Incorrect primary update hash');
  await writeFile(path.join(output, 'latest-mac.yml'), YAML.stringify(merged));
}

async function packageApps(root, output) {
  const teams = JSON.parse(
    await readFile(path.join(root, 'signing-teams.json'), 'utf8'),
  );
  const { build, Platform, Arch } = await import('electron-builder');
  const directories = [];
  await mkdir(path.join(root, 'notarized'), { recursive: true });
  await mkdir(path.join(root, 'verify'), { recursive: true });
  for (const arch of architectures) {
    const app = await extract(
      path.join(root, 'notarize-input', arch, 'Huabu.zip'),
      path.join(root, 'notarized', arch),
    );
    verifyApp(app, arch, teams[arch]);
    const ticket = spawnSync('/usr/bin/xcrun', ['stapler', 'validate', app], {
      encoding: 'utf8',
    });
    if (ticket.status !== 0) run('/usr/bin/xcrun', ['stapler', 'staple', app]);
    verifyApp(app, arch, teams[arch], true);
    const directory = path.join(root, 'packages', arch);
    await build({
      ...packagingOptions(app, arch, directory),
      targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch[arch]),
    });
    verifyApp(app, arch, teams[arch], true);
    const info = YAML.parse(
      await readFile(path.join(directory, 'latest-mac.yml'), 'utf8'),
    );
    const zip = info.files.find((file) => file.url.endsWith('.zip'));
    const dmg = info.files.find((file) => file.url.endsWith('.dmg'));
    assert.ok(zip && dmg, 'Missing macOS distribution assets');
    const extracted = await extract(
      path.join(directory, zip.url),
      path.join(root, 'verify', arch),
    );
    verifyApp(extracted, arch, teams[arch], true);
    const mount = path.join(root, `mount-${arch}`);
    await mkdir(mount);
    run('/usr/bin/hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-mountpoint',
      mount,
      path.join(directory, dmg.url),
    ]);
    try {
      verifyApp(path.join(mount, appName), arch, teams[arch], true);
    } finally {
      run('/usr/bin/hdiutil', ['detach', mount]);
    }
    directories.push(directory);
  }
  const { version } = JSON.parse(
    await readFile(path.join(desktop, 'package.json'), 'utf8'),
  );
  await mergeReleaseMetadata(directories, output, version);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.equal(
    process.platform,
    'darwin',
    'Apple release preparation requires macOS',
  );
  const [stage, root, output] = process.argv.slice(2);
  assert.ok(
    root && path.isAbsolute(root),
    'Expected an absolute ESRP staging directory',
  );
  if (stage === 'archive') await archiveApps(root);
  else if (stage === 'verify-signed') await prepareNotarization(root);
  else if (stage === 'package') {
    assert.ok(
      output && path.isAbsolute(output),
      'Expected an absolute release directory',
    );
    await packageApps(root, output);
  } else throw new Error(`Unknown Apple release stage: ${stage}`);
}
