import { API_CONFIG } from '../config/api';

type ArtifactType = 'image' | 'pdf' | 'video';

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
  // Backend returns full path like /api/artifact/xxx.png
  return `${API_CONFIG.BASE_URL}${data.uri}`;
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
