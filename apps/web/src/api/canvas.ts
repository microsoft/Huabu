import { API_CONFIG } from '../config/api';

import type {
  GetCanvasResponse,
  PutCanvasRequest,
  PutCanvasResponse,
} from '@sediment/shared';

export async function getCanvas(
  canvasId: string,
): Promise<GetCanvasResponse | null> {
  try {
    const response = await fetch(`${API_CONFIG.API_URL}/canvas/${canvasId}`);
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`Failed to get canvas: ${response.statusText}`);
    }
    return (await response.json()) as GetCanvasResponse;
  } catch (error) {
    console.error('Failed to get canvas:', error);
    return null;
  }
}

export async function putCanvas(
  canvasId: string,
  request: PutCanvasRequest,
): Promise<PutCanvasResponse> {
  const response = await fetch(`${API_CONFIG.API_URL}/canvas/${canvasId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    if (response.status === 409) {
      const error = (await response.json()) as {
        message: string;
        serverVersion: number;
      };
      throw new Error(
        `Canvas version mismatch. Server version: ${error.serverVersion}`,
      );
    }
    throw new Error(`Failed to save canvas: ${response.statusText}`);
  }

  return (await response.json()) as PutCanvasResponse;
}
