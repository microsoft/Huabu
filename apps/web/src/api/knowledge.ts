import { API_CONFIG } from '../config/api';

export interface Source {
  source_id: string;
  workspace_id: string;
  type: 'web' | 'pdf' | 'note' | 'text';
  title: string | null;
  uri: string | null;
  created_at: number;
  updated_at: number;
  content_text: string;
  content_hash: string;
  meta_json: string | null;
}

export async function getSources(
  workspaceId: string = 'default',
): Promise<Source[]> {
  const response = await fetch(
    `${API_CONFIG.API_URL}/knowledge/sources?workspaceId=${workspaceId}`,
  );

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
