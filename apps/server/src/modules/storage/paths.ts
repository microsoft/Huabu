/**
 * @deprecated Forwarding shim — the Workspace layout owns these now.
 *
 * Import from `modules/workspace/disk/paths.js` instead. This file exists
 * only so the many existing physical-Disk capability imports keep resolving
 * while they migrate; it must never contain logic, and no new call site may
 * import it (enforced by the module-boundary test).
 */

export * from '../workspace/disk/paths.js';
