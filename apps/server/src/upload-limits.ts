/**
 * Shared upload size limit for multipart file uploads (canvas imports,
 * artifact uploads, etc.).
 *
 * Canvas bundles embed their `.artifacts/` directory (PDFs, images, web
 * snapshots), so a single import can easily run into the hundreds of MB.
 * The default is intentionally generous; operators can tune it via
 * `HUABU_MAX_UPLOAD_BYTES` (a positive integer number of bytes).
 */
const DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

export const MAX_UPLOAD_BYTES: number = (() => {
  const raw = process.env.HUABU_MAX_UPLOAD_BYTES;
  if (!raw) return DEFAULT_MAX_UPLOAD_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_MAX_UPLOAD_BYTES;
})();
