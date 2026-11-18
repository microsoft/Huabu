#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2];
if (!image)
  throw new Error('Usage: node scripts/test-web-container.mjs <image>');

const name = `huabu-web-smoke-${randomBytes(8).toString('hex')}`;
const volume = `${name}-data`;
const childEnv = {
  ...process.env,
  HUABU_SECRET_KEY: randomBytes(32).toString('base64'),
  HUABU_BASIC_AUTH_PASS: randomBytes(24).toString('hex'),
};
const authorization = `Basic ${Buffer.from(`container-test:${childEnv.HUABU_BASIC_AUTH_PASS}`).toString('base64')}`;

function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    env: childEnv,
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function unusedPort() {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

// Node fetch normalizes Host to the URL authority; the core HTTP client lets
// this local probe model the public Host forwarded by a reverse proxy.
function get(url, headers, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const request = httpGet(
      url,
      { headers, signal: AbortSignal.timeout(timeout) },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            contentType: response.headers['content-type'] ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
  });
}

const user = docker([
  'image',
  'inspect',
  '--format',
  '{{.Config.User}}',
  image,
]);
assert.equal(user, 'node', 'The runtime must use the unprivileged Node user');
docker(['volume', 'create', volume]);
let previousCiphertext;
try {
  for (let boot = 1; boot <= 2; boot++) {
    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    // Model a reverse proxy's public Host while keeping the test socket local.
    const publicHost = `huabu-container.test:${port}`;
    const headers = { authorization, host: publicHost };
    docker([
      'run',
      '--detach',
      '--name',
      name,
      '--publish',
      `127.0.0.1:${port}:8080`,
      '--mount',
      `type=volume,source=${volume},target=/home`,
      '--env',
      'HUABU_SECRET_KEY',
      '--env',
      'HUABU_BASIC_AUTH_PASS',
      '--env',
      'HUABU_BASIC_AUTH_USER=container-test',
      '--env',
      'HUABU_IDENTITY_PROVIDER=local',
      '--env',
      `HUABU_PUBLIC_ORIGIN=http://${publicHost}`,
      image,
    ]);
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = await get(
          `${origin}/api/deployment/readiness`,
          headers,
          2000,
        );
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* Wait for the listener. */
      }
      if (
        docker(['inspect', '--format', '{{.State.Running}}', name]) !== 'true'
      )
        throw new Error('Container exited before becoming ready');
      await delay(500);
    }
    assert.ok(ready, 'Container did not become ready');
    const page = await get(origin, headers);
    assert.equal(page.status, 200);
    const html = page.body;
    assert.match(html, /<!doctype html|<html/i);
    const script = html.match(/<script[^>]+src="([^"]+)"/u)?.[1];
    assert.ok(script, 'The built SPA must reference its JavaScript');
    const asset = await get(new URL(script, origin), headers);
    assert.equal(asset.status, 200);
    assert.match(asset.contentType, /javascript/iu);
    const ciphertext = docker([
      'exec',
      name,
      'node',
      '-e',
      "const fs=require('node:fs');const crypto=require('node:crypto');if(fs.existsSync('/app/.git'))process.exit(1);console.log(crypto.createHash('sha256').update(fs.readFileSync('/home/huabu-data/encrypted-secrets.json')).digest('hex'));",
    ]);
    if (previousCiphertext)
      assert.equal(
        ciphertext,
        previousCiphertext,
        'Replacement must retain the encrypted credentials',
      );
    previousCiphertext = ciphertext;
    docker(['stop', '--time', '10', name]);
    assert.equal(
      docker(['inspect', '--format', '{{.State.ExitCode}}', name]),
      '0',
    );
    docker(['rm', name]);
    console.log(
      `Container boot ${boot}: UI, assets, persistence and graceful shutdown passed`,
    );
  }
} catch (error) {
  try {
    console.error(docker(['logs', name]));
  } catch {
    /* No container was created. */
  }
  throw error;
} finally {
  try {
    docker(['rm', '--force', name]);
  } catch {
    /* Already removed. */
  }
  docker(['volume', 'rm', volume]);
}
