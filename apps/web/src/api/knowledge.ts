import { API_CONFIG } from '../config/api';

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

export async function deleteSource(id: string): Promise<{ success: boolean }> {
  const response = await fetch(`${API_CONFIG.API_URL}/knowledge/source/${id}`, {
    method: 'DELETE',
  });

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
