// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The TCP port the host HTTP server bound to, captured by an
 * `onListen` hook in {@link ./app.ts}.
 *
 * This is L1-owned: the canvas-scoped Remote File System reachback
 * (`HUABU_RFS_URL = http://127.0.0.1:<port>/api/rfs/<canvasId>`) uses
 * this port only for the local fallback when no public origin is configured.
 * The port lives here rather than being read back out of the L2 transport host.
 */
let serverPort = 0;

/** Called once by the `onListen` hook after the OS-level bind. */
export function setHostServerPort(port: number): void {
  serverPort = port;
}

/**
 * The bound TCP port, or `0` before the `onListen` hook has fired.
 * Used to build the local `HUABU_RFS_URL` fallback injected into agent
 * sessions.
 */
export function getHostServerPort(): number {
  return serverPort;
}
