/**
 * @deprecated Forwarding shim — the legacy Disk store lives under
 * `backends/disk/legacy/canvas-store.js` now.
 *
 * Import the class and its result types from `storage/index.js` (the public
 * facade) instead. This file exists only so the existing `CanvasStore` type
 * imports keep resolving while they migrate; it must never contain logic, and
 * no new call site may import it (enforced by the module-boundary test).
 */

export * from './backends/disk/legacy/canvas-store.js';
