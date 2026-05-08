import { API_CONFIG } from '../config/api';

type ArtifactType = 'image' | 'pdf' | 'video';

/**
 * Resolve an artifact path to a full URL.
 *
 * Handles both legacy absolute URLs and relative API paths.
 * Legacy fix: earlier versions stored absolute URLs with a hardcoded port
 * (e.g. `http://localhost:3000/api/...`). When the server port changed
 * those URLs broke. Re-base any absolute artifact URL onto the current
 * BASE_URL so existing data keeps working.
 */
export function resolveArtifactUrl(src: string): string {
  if (!src) return src;
  if (src.startsWith('data:')) return src;

  if (/^https?:\/\//.test(src)) {
    try {
      const { pathname } = new URL(src);
      if (
        pathname.startsWith('/api/canvas/') ||
        pathname.startsWith('/api/artifact/')
      ) {
        return `${API_CONFIG.BASE_URL}${pathname}`;
      }
    } catch {
      /* malformed URL — fall through */
    }
    return src;
  }

  return `${API_CONFIG.BASE_URL}${src}`;
}

async function uploadArtifact(
  file: File,
  type: ArtifactType,
  canvasId: string,
): Promise<string> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(
    `${API_CONFIG.API_URL}/canvas/${canvasId}/artifact/${type}`,
    {
      method: 'POST',
      body: formData,
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to upload ${type}: ${response.statusText}`);
  }

  const data = await response.json();
  return data.uri as string;
}

export async function uploadImage(
  file: File,
  canvasId: string,
): Promise<string> {
  return uploadArtifact(file, 'image', canvasId);
}

export async function uploadPdf(file: File, canvasId: string): Promise<string> {
  return uploadArtifact(file, 'pdf', canvasId);
}

export async function uploadVideo(
  file: File,
  canvasId: string,
): Promise<string> {
  return uploadArtifact(file, 'video', canvasId);
}
