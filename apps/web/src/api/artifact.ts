import { API_CONFIG } from '../config/api';

type ArtifactType = 'image' | 'pdf' | 'video';

/**
 * Resolve an artifact path to a full URL.
 *
 * Handles both legacy absolute URLs and new relative paths.
 * Legacy fix: earlier versions stored absolute URLs with a hardcoded port
 * (e.g. `http://localhost:3000/api/artifact/…`). When the server port
 * changed these URLs broke. This function re-bases any absolute artifact
 * URL onto the current BASE_URL so existing data keeps working.
 */
export function resolveArtifactUrl(src: string): string {
  if (!src) return src;
  if (src.startsWith('data:')) return src;

  // Legacy absolute URLs (e.g. http://localhost:3000/api/artifact/…) —
  // extract the path and re-base onto the current BASE_URL so stale
  // port numbers don't break images.
  if (/^https?:\/\//.test(src)) {
    try {
      const { pathname } = new URL(src);
      if (pathname.startsWith('/api/artifact/')) {
        return `${API_CONFIG.BASE_URL}${pathname}`;
      }
    } catch {
      /* malformed URL — fall through */
    }
    return src;
  }

  // Relative path like /api/artifact/xxx.png — prepend base URL
  return `${API_CONFIG.BASE_URL}${src}`;
}

async function uploadArtifact(file: File, type: ArtifactType): Promise<string> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${API_CONFIG.API_URL}/artifact/${type}`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload ${type}: ${response.statusText}`);
  }

  const data = await response.json();
  // Backend returns relative path like /api/artifact/xxx.png — store as-is.
  // Frontend resolves to absolute URL at render time via resolveArtifactUrl().
  return data.uri as string;
}

export async function uploadImage(file: File): Promise<string> {
  return uploadArtifact(file, 'image');
}

export async function uploadPdf(file: File): Promise<string> {
  return uploadArtifact(file, 'pdf');
}

export async function uploadVideo(file: File): Promise<string> {
  return uploadArtifact(file, 'video');
}
