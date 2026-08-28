// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Preview Workspace persistence.
 *
 * Layout is local UI state, so it lives in `localStorage` next to the
 * per-Canvas viewport record rather than on the server. The rules follow
 * `docs/architecture`-adjacent proposal §12.1: one namespaced record per
 * Canvas, identity only, written on leave, deleted with its Canvas, and
 * bounded by a capped most-recently-used index of Canvas IDs.
 */

import {
  DEFAULT_SPLIT_RATIO,
  MAX_PREVIEW_GROUPS,
  createEmptyWorkspace,
  findTabByTarget,
  repairTransientTabs,
  type CanvasPreviewWorkspace,
  type PreviewGroup,
  type PreviewTab,
  type PreviewTarget,
} from './model';
import { forgetPreviewScrollCanvas } from './scrollMemory';

const WORKSPACE_VERSION = 1;

const workspaceStorageKey = (canvasId: string) =>
  `huabu.previewWorkspace.${canvasId}`;

const INDEX_KEY = 'huabu.previewWorkspace.index';

/**
 * How many Canvases keep a layout record. Falling off the list only costs
 * a tab arrangement — no content lives here — so eviction is non-destructive.
 */
export const MAX_PERSISTED_CANVASES = 50;

type PersistedWorkspace = {
  version: number;
  workspace: CanvasPreviewWorkspace;
};

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private mode / disabled storage behaves as "no stored layout".
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A full or unavailable quota must never break the workspace.
  }
}

function removeRaw(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to do if storage is unavailable.
  }
}

function parseTarget(value: unknown, canvasId: string): PreviewTarget | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.canvasId !== canvasId) return null;

  if (
    candidate.kind === 'node' &&
    typeof candidate.nodeId === 'string' &&
    candidate.nodeId.length > 0
  ) {
    return { kind: 'node', canvasId, nodeId: candidate.nodeId };
  }
  if (
    candidate.kind === 'chat' &&
    typeof candidate.threadId === 'string' &&
    candidate.threadId.length > 0
  ) {
    return { kind: 'chat', canvasId, threadId: candidate.threadId };
  }
  return null;
}

function parseTabs(
  value: unknown,
  canvasId: string,
): Record<string, PreviewTab> {
  if (!value || typeof value !== 'object') return {};
  const tabs: Record<string, PreviewTab> = {};

  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!id || !raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    const target = parseTarget(candidate.target, canvasId);
    // An entry that cannot be resolved is dropped rather than blocking the
    // rest of the layout, matching how the editor treats a tab whose
    // serializer is gone.
    if (!target) continue;

    tabs[id] = {
      id,
      target,
      transient: candidate.transient === true,
      lastActiveSeq:
        typeof candidate.lastActiveSeq === 'number' &&
        Number.isFinite(candidate.lastActiveSeq)
          ? candidate.lastActiveSeq
          : 0,
    };
  }

  return tabs;
}

function parseGroups(
  value: unknown,
  tabs: Record<string, PreviewTab>,
): PreviewGroup[] {
  if (!Array.isArray(value)) return [];

  const seenTabIds = new Set<string>();
  const groups: PreviewGroup[] = [];

  for (const raw of value.slice(0, MAX_PREVIEW_GROUPS)) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || !candidate.id) continue;

    const tabIds = Array.isArray(candidate.tabIds)
      ? candidate.tabIds.filter(
          (id): id is string =>
            typeof id === 'string' && !!tabs[id] && !seenTabIds.has(id),
        )
      : [];
    for (const id of tabIds) seenTabIds.add(id);

    const activeTabId =
      typeof candidate.activeTabId === 'string' &&
      tabIds.includes(candidate.activeTabId)
        ? candidate.activeTabId
        : (tabIds[0] ?? null);

    groups.push({ id: candidate.id, tabIds, activeTabId });
  }

  return groups;
}

function parseWorkspace(
  raw: string | null,
  canvasId: string,
): CanvasPreviewWorkspace | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspace> | null;
    if (!parsed || parsed.version !== WORKSPACE_VERSION) return null;

    const source = parsed.workspace as
      | Partial<CanvasPreviewWorkspace>
      | undefined;
    if (!source) return null;

    const tabs = parseTabs(source.tabs, canvasId);
    const groups = parseGroups(source.groups, tabs).filter(
      (group, index) => index === 0 || group.tabIds.length > 0,
    );
    if (groups.length === 0) return null;

    // Tabs orphaned by group repair would otherwise be unreachable state.
    const referenced = new Set(groups.flatMap((g) => g.tabIds));
    for (const id of Object.keys(tabs)) {
      if (!referenced.has(id)) delete tabs[id];
    }

    const activeGroupId =
      typeof source.activeGroupId === 'string' &&
      groups.some((g) => g.id === source.activeGroupId)
        ? source.activeGroupId
        : groups[0].id;

    const splitRatio =
      typeof source.splitRatio === 'number' &&
      Number.isFinite(source.splitRatio)
        ? source.splitRatio
        : DEFAULT_SPLIT_RATIO;

    const activationSeq =
      typeof source.activationSeq === 'number' &&
      Number.isFinite(source.activationSeq)
        ? source.activationSeq
        : Math.max(0, ...Object.values(tabs).map((t) => t.lastActiveSeq));

    return repairTransientTabs({
      tabs,
      groups,
      activeGroupId,
      splitRatio,
      activationSeq,
    });
  } catch {
    // Corrupt entries are treated as missing layout.
    return null;
  }
}

function readIndex(): string[] {
  const raw = readRaw(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && !!id);
  } catch {
    return [];
  }
}

function writeIndex(canvasIds: string[]): void {
  writeRaw(INDEX_KEY, JSON.stringify(canvasIds));
}

/**
 * Records a Canvas as most recently used and deletes the layout of any
 * Canvas pushed past the cap.
 */
function touchIndex(canvasId: string): void {
  const next = [canvasId, ...readIndex().filter((id) => id !== canvasId)];
  const evicted = next.slice(MAX_PERSISTED_CANVASES);
  for (const id of evicted) {
    removeRaw(workspaceStorageKey(id));
    forgetPreviewScrollCanvas(id);
  }
  writeIndex(next.slice(0, MAX_PERSISTED_CANVASES));
}

export function readWorkspace(canvasId: string): CanvasPreviewWorkspace | null {
  if (!canvasId) return null;
  return parseWorkspace(readRaw(workspaceStorageKey(canvasId)), canvasId);
}

export function writeWorkspace(
  canvasId: string,
  workspace: CanvasPreviewWorkspace,
): void {
  if (!canvasId) return;

  const payload: PersistedWorkspace = {
    version: WORKSPACE_VERSION,
    workspace,
  };
  writeRaw(workspaceStorageKey(canvasId), JSON.stringify(payload));
  touchIndex(canvasId);
}

/** Drops a Canvas's layout. Called when the Canvas itself is deleted. */
export function deleteWorkspace(canvasId: string): void {
  if (!canvasId) return;
  removeRaw(workspaceStorageKey(canvasId));
  forgetPreviewScrollCanvas(canvasId);
  const next = readIndex().filter((id) => id !== canvasId);
  writeIndex(next);
}

export function readPersistedCanvasIndex(): string[] {
  return readIndex();
}

/**
 * Builds the first workspace for a Canvas that only has pre-workspace Chat
 * state, so the migration does not present an empty right side to users who
 * had a conversation open.
 *
 * The unbound Canvas Chat becomes the base tab; a Question replay that was
 * open at the time becomes a second, active node tab.
 */
export function seedWorkspaceFromLegacyChat(
  canvasId: string,
  legacy: { chatThreadId?: string; questionNodeId?: string },
  newIds: { groupId?: string; chatTabId?: string; nodeTabId?: string } = {},
): CanvasPreviewWorkspace | null {
  if (!canvasId) return null;
  if (!legacy.chatThreadId && !legacy.questionNodeId) return null;

  let workspace = createEmptyWorkspace(newIds.groupId);
  const groupId = workspace.groups[0].id;

  const append = (target: PreviewTarget, tabId: string) => {
    if (findTabByTarget(workspace, target)) return;
    const seq = workspace.activationSeq + 1;
    workspace = {
      ...workspace,
      tabs: {
        ...workspace.tabs,
        [tabId]: { id: tabId, target, transient: false, lastActiveSeq: seq },
      },
      groups: workspace.groups.map((g) =>
        g.id === groupId
          ? { ...g, tabIds: [...g.tabIds, tabId], activeTabId: tabId }
          : g,
      ),
      activationSeq: seq,
    };
  };

  if (legacy.chatThreadId) {
    append(
      { kind: 'chat', canvasId, threadId: legacy.chatThreadId },
      newIds.chatTabId ?? `${groupId}-chat`,
    );
  }
  if (legacy.questionNodeId) {
    append(
      { kind: 'node', canvasId, nodeId: legacy.questionNodeId },
      newIds.nodeTabId ?? `${groupId}-question`,
    );
  }

  return workspace;
}
