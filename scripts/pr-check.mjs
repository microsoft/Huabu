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
// Exit codes: 0 clean, 1 failing checks or open alerts, 2 could not run or CodeQL
// did not run (missing or skipped), so the result is unverified.

import { execFileSync } from 'node:child_process';

const POLL_MS = 15_000;
const TIMEOUT_MS = 30 * 60_000;
const CODEQL_CHECK = 'CodeQL';
const GH_MAX_BUFFER = 256 * 1024 * 1024;
const PR_REFS = ['head', 'merge'];

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // The default 1 MiB cap would abort on a large paginated alert list.
    maxBuffer: GH_MAX_BUFFER,
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

// `gh pr checks` exits 8 while checks are pending but still prints the JSON,
// and exits 1 with "no checks reported" before any check has registered.
function readChecks(pr) {
  try {
    return ghJson(['pr', 'checks', pr, '--json', 'name,bucket,link']);
  } catch (error) {
    const stdout = error.stdout?.toString().trim();
    if (stdout) return JSON.parse(stdout);
    if (/no checks reported/i.test(error.stderr?.toString() ?? '')) return [];
    throw error;
  }
}

// This repository's code scanning records PR analyses against
// `refs/pull/<n>/head`; other setups use `refs/pull/<n>/merge`. Read both so
// neither layout can hide findings, following pagination for each.
function readAlerts(repo, pr) {
  const byNumber = new Map();
  for (const ref of PR_REFS) {
    const pages = ghJson([
      'api',
      '--paginate',
      '--slurp',
      `repos/${repo}/code-scanning/alerts?ref=refs/pull/${pr}/${ref}&state=open&per_page=100`,
    ]);
    for (const alert of pages.flat()) byNumber.set(alert.number, alert);
  }
  return [...byNumber.values()];
}

// Settled means every check has finished and the `CodeQL` check is among
// them. Without that check the scan is unverified and must not count as clean.
function isSettled(checks) {
  return (
    checks.some((c) => c.name === CODEQL_CHECK) &&
    !checks.some((c) => c.bucket === 'pending')
  );
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
  while (!isSettled(checks) && Date.now() < deadline) {
    const pending = checks.filter((c) => c.bucket === 'pending').length;
    const codeql = checks.some((c) => c.name === CODEQL_CHECK)
      ? ''
      : `, \`${CODEQL_CHECK}\` check not registered yet`;
    console.log(
      `Waiting for checks on #${pr} (${pending} pending${codeql})...`,
    );
    await sleep(POLL_MS);
    checks = readChecks(pr);
  }
  if (checks.some((c) => c.bucket === 'pending')) {
    fail(`Timed out waiting for checks on #${pr}.`);
  }
  if (!checks.some((c) => c.name === CODEQL_CHECK)) {
    fail(
      `No \`${CODEQL_CHECK}\` check appeared on #${pr}; code scanning is unverified, so this is not a clean result.`,
    );
  }

  const failed = checks.filter(
    (c) => c.bucket === 'fail' || c.bucket === 'cancel',
  );
  const alerts = readAlerts(repo, pr);

  console.log(
    `\nChecks on #${pr}: ${checks.length - failed.length} ok, ${failed.length} failing`,
  );
  for (const c of failed) console.log(`  FAIL ${c.name}  ${c.link}`);

  console.log(`\nOpen CodeQL alerts on #${pr}: ${alerts.length}`);
  for (const a of alerts) {
    const loc = a.most_recent_instance?.location;
    const where = loc ? `${loc.path}:${loc.start_line}` : '?';
    const severity = a.rule?.security_severity_level ?? a.rule?.severity ?? '?';
    console.log(
      `  [${severity}] ${a.rule?.id} ${where}\n    ${a.most_recent_instance?.message?.text ?? ''}\n    ${a.html_url}`,
    );
  }

  // A skipped scan found nothing because it looked at nothing.
  const codeqlSkipped = checks.some(
    (c) => c.name === CODEQL_CHECK && c.bucket === 'skipping',
  );
  if (codeqlSkipped) {
    console.log(
      `\nThe \`${CODEQL_CHECK}\` check was skipped on #${pr}; code scanning is unverified, so this is not a clean result.`,
    );
  }

  // Set the code instead of calling process.exit() so a piped report is
  // fully flushed before the process ends.
  if (failed.length > 0 || alerts.length > 0) process.exitCode = 1;
  else if (codeqlSkipped) process.exitCode = 2;
}

main().catch((error) =>
  fail(`pr:check failed: ${error.stderr || error.message}`),
);
