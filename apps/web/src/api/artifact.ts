import { API_CONFIG } from '../config/api';

type ArtifactType = 'image' | 'pdf' | 'video';

/**
 * Resolve an artifact path to a full URL.
 * Handles both legacy absolute URLs and new relative paths.
 */
export function resolveArtifactUrl(src: string): string {
  if (!src) return src;
  // Already absolute — return as-is
  if (/^https?:\/\//.test(src) || src.startsWith('data:')) return src;
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
