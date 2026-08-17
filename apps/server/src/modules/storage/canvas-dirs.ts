// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @deprecated Forwarding shim — the Disk backend owns this directory index.
 *
 * Inside the storage module, import from
 * `storage/backends/disk/canvas-dirs.js`. This file exists only so the
 * existing application-level Disk capability imports keep resolving while
 * they migrate; it must never contain logic, and no new call site may import
 * it (enforced by the module-boundary test).
 */

export * from './backends/disk/canvas-dirs.js';
