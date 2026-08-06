// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const headerLines = [
  'Copyright (c) Microsoft Corporation.',
  'Licensed under the MIT license.',
];

const commentStyleBySuffix = new Map([
  ['.c', 'slash'],
  ['.cc', 'slash'],
  ['.cpp', 'slash'],
  ['.cs', 'slash'],
  ['.cts', 'slash'],
  ['.cxx', 'slash'],
  ['.h', 'slash'],
  ['.hpp', 'slash'],
  ['.java', 'slash'],
  ['.js', 'slash'],
  ['.jsx', 'slash'],
  ['.mjs', 'slash'],
  ['.mts', 'slash'],
  ['.ts', 'slash'],
  ['.tsx', 'slash'],
  ['.py', 'hash'],
  ['.pyi', 'hash'],
  ['.pyw', 'hash'],
  ['.ps1', 'hash'],
  ['.sh', 'hash'],
  ['.css', 'block'],
  ['.html', 'html'],
  ['.less', 'block'],
  ['.scss', 'block'],
  ['.svelte', 'html'],
  ['.vue', 'html'],
]);

function expectedHeader(style) {
  if (style === 'hash') {
    return headerLines.map((line) => `# ${line}`);
  }
  if (style === 'block') {
    return ['/*', ...headerLines.map((line) => ` * ${line}`), ' */'];
  }
  if (style === 'html') {
    return ['<!--', ...headerLines.map((line) => `  ${line}`), '-->'];
  }
  return headerLines.map((line) => `// ${line}`);
}

// Vendored / subtree code keeps its upstream headers: external/ is pushed
// back to the agentlet and agenetes repositories, and agent-teams/ ships
// self-contained third-party plugin scripts.
const excludedPrefixes = ['external/', 'agent-teams/'];

const trackedPaths = execFileSync('git', ['ls-files', '-z'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
  .filter((path) => !excludedPrefixes.some((prefix) => path.startsWith(prefix)))
  .filter((path) => commentStyleBySuffix.has(extname(path).toLowerCase()))
  .sort();

const failures = [];

for (const trackedPath of trackedPaths) {
  const absolutePath = resolve(repoRoot, trackedPath);
  if (!existsSync(absolutePath)) {
    continue;
  }

  const suffix = extname(trackedPath).toLowerCase();
  const expected = expectedHeader(commentStyleBySuffix.get(suffix));
  let contents;
  try {
    contents = readFileSync(absolutePath, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    failures.push(
      `${trackedPath}: unable to read tracked source file (${error.code ?? 'unknown error'})`,
    );
    continue;
  }
  const lines = contents.split(/\r?\n/);
  const start = lines[0]?.startsWith('#!') ? 1 : 0;

  if (!expected.every((line, index) => lines[start + index] === line)) {
    failures.push(
      `${trackedPath}: expected lines ${start + 1}-${start + expected.length} to be ${expected.join(' / ')}`,
    );
    continue;
  }

  const blankLineIndex = start + expected.length;
  if (lines.length > blankLineIndex && lines[blankLineIndex] !== '') {
    failures.push(
      `${trackedPath}: expected a blank line after the license header`,
    );
  }
}

if (failures.length > 0) {
  console.error('Source header check failed:');
  for (const failure of failures) {
    console.error(` - ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log('All tracked source files have the required license header.');
}
