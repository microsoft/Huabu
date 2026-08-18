// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface SpacePreviewViewportState {
  x: number;
  y: number;
  zoom: number;
}

const STORAGE_VERSION = 1;

function storageKey(hostCanvasId: string, previewNodeId: string): string {
  return `huabu.spacePreviewViewport.${hostCanvasId}.${previewNodeId}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function readSpacePreviewViewport(
  hostCanvasId: string,
  previewNodeId: string,
): SpacePreviewViewportState | null {
  if (!hostCanvasId || !previewNodeId) return null;
  try {
    const raw = localStorage.getItem(storageKey(hostCanvasId, previewNodeId));
    if (!raw) return null;
    const record = JSON.parse(raw) as Record<string, unknown>;
    const viewport = record.viewport as Record<string, unknown> | undefined;
    if (
      record.version !== STORAGE_VERSION ||
      !viewport ||
      !isFiniteNumber(viewport.x) ||
      !isFiniteNumber(viewport.y) ||
      !isFiniteNumber(viewport.zoom) ||
      viewport.zoom <= 0
    ) {
      return null;
    }
    return { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
  } catch {
    return null;
  }
}

export function writeSpacePreviewViewport(
  hostCanvasId: string,
  previewNodeId: string,
  viewport: SpacePreviewViewportState,
): void {
  if (!hostCanvasId || !previewNodeId) return;
  try {
    localStorage.setItem(
      storageKey(hostCanvasId, previewNodeId),
      JSON.stringify({ version: STORAGE_VERSION, viewport }),
    );
  } catch {
    // Local UI persistence must not interrupt preview interaction.
  }
}
