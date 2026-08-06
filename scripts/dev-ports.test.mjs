// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import net from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findAvailablePort, isPortFree } from './dev-ports.mjs';

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('advances past an occupied preferred port', async () => {
  const server = net.createServer();
  try {
    const occupiedPort = await findAvailablePort(41_000);
    await listen(server, occupiedPort);
    assert.equal(await isPortFree(occupiedPort), false);

    const selectedPort = await findAvailablePort(occupiedPort);
    assert.ok(selectedPort > occupiedPort);
  } finally {
    await close(server);
  }
});

test('rejects invalid preferred ports', async () => {
  await assert.rejects(() => findAvailablePort(0), /Invalid preferred port/);
  await assert.rejects(
    () => findAvailablePort(65_536),
    /Invalid preferred port/,
  );
});
