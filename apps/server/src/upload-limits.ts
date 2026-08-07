// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared upload size limit for multipart file uploads (canvas imports,
 * artifact uploads, etc.).
 *
 * Canvas bundles embed their `.artifacts/` directory (PDFs, images, web
 * snapshots), so a single import can easily run into the hundreds of MB.
 * The limit is intentionally generous.
 */
export const MAX_UPLOAD_BYTES: number = 500 * 1024 * 1024; // 500 MB
