// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @deprecated Forwarding shim — the Disk backend owns its layout now.
 *
 * Import from `storage/backends/disk/layout.js` if you are inside the storage
 * module; everyone else wants `spaceDirectory()` from `storage/index.js` or
 * the workspace-owned paths in `modules/workspace/paths.js`. This file
 * exists only so the remaining physical-Disk capability imports keep
 * resolving while they migrate; it must never contain logic, and no new call
 * site may import it (enforced by the module-boundary test).
 */

export * from './backends/disk/layout.js';
