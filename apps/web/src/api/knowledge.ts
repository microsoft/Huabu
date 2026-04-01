import { API_CONFIG } from '@/config/api';

import type { Source, SourceOverview } from '@sediment/shared';

export async function getSources(): Promise<SourceOverview[]> {
  const response = await fetch(`${API_CONFIG.API_URL}/knowledge/sources`);

  if (!response.ok) {
    throw new Error('Failed to fetch sources');
  }

  return response.json();
}

export async function getSource(id: string): Promise<Source> {
  const response = await fetch(`${API_CONFIG.API_URL}/knowledge/source/${id}`);

  if (!response.ok) {
    throw new Error('Failed to fetch source');
  }

  return response.json();
}

export async function updateSource(
  id: string,
  updates: { title?: string },
): Promise<Source> {
  const response = await fetch(`${API_CONFIG.API_URL}/knowledge/source/${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    throw new Error('Failed to update source');
  }

  return response.json();
}

export interface SourceConflict {
  error: string;
  referencedBy: Array<{ canvasId: string; title: string | null }>;
}

/**
 * Check whether a source is referenced by any canvases.
 */
export async function checkSourceUsage(
  id: string,
): Promise<SourceConflict | null> {
  const response = await fetch(
    `${API_CONFIG.API_URL}/knowledge/source/${id}/usage`,
  );
  if (!response.ok) throw new Error('Failed to check source usage');
  const data = (await response.json()) as {
    referencedBy: Array<{ canvasId: string; title: string | null }>;
  };
  if (data.referencedBy.length === 0) return null;
  return {
    error: 'Source is referenced by canvases',
    referencedBy: data.referencedBy,
  };
}

export async function deleteSource(
  id: string,
  force?: boolean,
): Promise<{ success: boolean }> {
  const url = new URL(`${API_CONFIG.API_URL}/knowledge/source/${id}`);
  if (force) url.searchParams.set('force', '1');
  const response = await fetch(url.toString(), {
    method: 'DELETE',
  });

  if (response.status === 409) {
    const body = (await response.json()) as SourceConflict;
    throw Object.assign(new Error(body.error), { conflict: body });
  }

  if (!response.ok) {
    throw new Error('Failed to delete source');
  }

  return response.json();
}

export async function deleteUnusedSources(): Promise<{ deleted: number }> {
  const response = await fetch(
    `${API_CONFIG.API_URL}/knowledge/sources/unused`,
    { method: 'DELETE' },
  );

  if (!response.ok) {
    throw new Error('Failed to delete unused sources');
  }

  return response.json();
}
