// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @deprecated Forwarding shim — the Disk backend owns its layout now.
 *
 * Inside the storage module, import from
 * `storage/backends/disk/layout.js`. Application code should use
 * `space(canvasId).diskTree` or the workspace-owned paths when those express
 * the capability it needs. This file exists for the remaining explicit Disk
 * layout reads while they migrate; it must never contain logic, and no new
 * call site may import it (enforced by the module-boundary test).
 */

export * from './backends/disk/layout.js';
