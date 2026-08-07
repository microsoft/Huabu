// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import net from 'node:net';

const DEFAULT_SCAN_RANGE = 50;
const MAX_PORT = 65_535;

function probeBind(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * Probe both binding modes because Windows may allow a loopback bind while
 * the same wildcard port is already occupied (or vice versa).
 */
export async function isPortFree(port) {
  if (!(await probeBind('127.0.0.1', port))) return false;
  if (!(await probeBind('0.0.0.0', port))) return false;
  return true;
}

/**
 * Select a port before launching a service. A competing bind can still win
 * after this probe; callers surface that rare startup error normally.
 */
export async function findAvailablePort(
  startPort,
  excludedPorts = new Set(),
  scanRange = DEFAULT_SCAN_RANGE,
) {
  if (!Number.isInteger(startPort) || startPort < 1 || startPort > MAX_PORT) {
    throw new Error(`Invalid preferred port: ${startPort}`);
  }
  const endPort = Math.min(startPort + scanRange - 1, MAX_PORT);
  for (let port = startPort; port <= endPort; port += 1) {
    if (excludedPorts.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in ${startPort}..${endPort}`);
}
