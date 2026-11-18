#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Usage: pnpm pr:check [<pr-number>]
//
// Waits for every check on the PR to finish, then reports failing checks and
// open code-scanning (CodeQL) alerts. The `CodeQL` check is a GitHub App check,
// not an Actions run, so `gh run list` never shows it; and alerts below the
// merge-blocking severity leave the check green. Reading both here is what
// keeps an agent from declaring "CI is green" while CodeQL has findings.
//
// Exit codes: 0 clean, 1 failing checks or open alerts, 2 could not run.

import { execFileSync } from 'node:child_process';

const POLL_MS = 15_000;
const TIMEOUT_MS = 30 * 60_000;

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `gh pr checks` exits 8 while checks are pending but still prints the JSON.
function readChecks(pr) {
  try {
    return ghJson(['pr', 'checks', pr, '--json', 'name,bucket,link']);
  } catch (error) {
    const stdout = error.stdout?.toString().trim();
    if (stdout) return JSON.parse(stdout);
    throw error;
  }
}

async function main() {
  let pr = process.argv[2];
  try {
    if (!pr) pr = String(ghJson(['pr', 'view', '--json', 'number']).number);
  } catch {
    fail('No PR for the current branch; pass a PR number: pnpm pr:check <n>');
  }
  if (!/^\d+$/.test(pr)) fail(`Invalid PR number: ${pr}`);

  const repo = ghJson([
    'repo',
    'view',
    '--json',
    'nameWithOwner',
  ]).nameWithOwner;
  const deadline = Date.now() + TIMEOUT_MS;

  let checks = readChecks(pr);
  // Right after a push, checks may not be registered yet.
  while (
    (checks.length === 0 || checks.some((c) => c.bucket === 'pending')) &&
    Date.now() < deadline
  ) {
    const pending = checks.filter((c) => c.bucket === 'pending').length;
    console.log(`Waiting for checks on #${pr} (${pending} pending)...`);
    await sleep(POLL_MS);
    checks = readChecks(pr);
  }
  if (checks.some((c) => c.bucket === 'pending')) {
    fail(`Timed out waiting for checks on #${pr}.`);
  }

  const failed = checks.filter(
    (c) => c.bucket === 'fail' || c.bucket === 'cancel',
  );
  const hasCodeQlCheck = checks.some((c) => c.name === 'CodeQL');

  const alerts = ghJson([
    'api',
    `repos/${repo}/code-scanning/alerts?ref=refs/pull/${pr}/head&state=open&per_page=100`,
  ]);

  console.log(
    `\nChecks on #${pr}: ${checks.length - failed.length} ok, ${failed.length} failing`,
  );
  for (const c of failed) console.log(`  FAIL ${c.name}  ${c.link}`);
  if (!hasCodeQlCheck) {
    console.log(
      '  WARN no `CodeQL` check found; code scanning may not have run on this PR yet.',
    );
  }

  console.log(`\nOpen CodeQL alerts on refs/pull/${pr}/head: ${alerts.length}`);
  for (const a of alerts) {
    const loc = a.most_recent_instance?.location;
    const where = loc ? `${loc.path}:${loc.start_line}` : '?';
    const severity = a.rule?.security_severity_level ?? a.rule?.severity ?? '?';
    console.log(
      `  [${severity}] ${a.rule?.id} ${where}\n    ${a.most_recent_instance?.message?.text ?? ''}\n    ${a.html_url}`,
    );
  }

  process.exit(failed.length > 0 || alerts.length > 0 ? 1 : 0);
}

main().catch((error) =>
  fail(`pr:check failed: ${error.stderr || error.message}`),
);
