// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  FileCode2,
  ArrowUp,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { listDeviceFiles } from '@/api/device-files';
import { Button } from '@/components/Common/Button';
import { Select } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import useCanvasStore, { selectCanWriteCanvas } from '@/store/canvasStore';
import { usePanelStore } from '@/store/panelStore';
import {
  addFileReferenceNode,
  openFileReference,
} from '@/store/previewWorkspace/actions';
import { setDragPayload } from '@/utils/io/dragDrop';

import { FilesPanelEntryMenu } from './FilesPanelEntryMenu';

import type { FileListResult } from '@huabu/shared';

type Entry = FileListResult['entries'][number];
type Row =
  | { entry: Entry; depth: number; relativePath: string }
  | { more: string; depth: number };
const MAX_TREE_ENTRIES = 2000;

export function FilesPanel() {
  const { t } = useTranslation();
  const canvasId = useCanvasStore((state) => state.canvasId);
  const canWrite = useCanvasStore(selectCanWriteCanvas);
  const location = usePanelStore((state) => state.filesLocation);
  const openFiles = usePanelStore((state) => state.openFiles);
  const devices = useAcpProfilesStore((state) => state.connectedDevices);
  const profilesError = useAcpProfilesStore((state) => state.error);
  const source = location?.canvasId === canvasId ? location : null;
  const sourceAgentletId = source?.agentletId;
  const sourcePath = source?.path;
  const [device, setDevice] = useState(source?.agentletId ?? '');
  const [path, setPath] = useState(source?.path ?? '');
  const [showHidden, setShowHidden] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [pages, setPages] = useState<Record<string, FileListResult>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const listRef = useRef<VirtuosoHandle>(null);
  const pendingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const entriesLoaded = useRef(0);
  const selectedDevice = devices.find(
    (candidate) => candidate.agentletId === source?.agentletId,
  );
  useEffect(() => {
    void useAcpProfilesStore.getState().refresh();
  }, []);
  useEffect(() => {
    setDevice(source?.agentletId ?? '');
    setPath(source?.path ?? '');
  }, [source?.agentletId, source?.path]);

  useEffect(() => {
    const current = ++generation.current;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setPages({});
    setSelectedPath(null);
    setFocusIndex(null);
    setExpanded(new Set());
    setError(null);
    entriesLoaded.current = 0;
    if (!sourceAgentletId || !sourcePath) {
      pendingRef.current = false;
      setPending(false);
      return;
    }
    pendingRef.current = true;
    setPending(true);
    void listDeviceFiles(
      sourceAgentletId,
      { path: sourcePath, showHidden },
      abort.signal,
    )
      .then((result) => {
        if (current !== generation.current) return;
        entriesLoaded.current = result.entries.length;
        setPages({ [sourcePath]: result });
      })
      .catch((failure: unknown) => {
        if (current === generation.current && !abort.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : t('files.failed'),
          );
      })
      .finally(() => {
        if (current === generation.current) {
          pendingRef.current = false;
          setPending(false);
        }
      });
    return () => {
      generation.current = current + 1;
      abort.abort();
    };
  }, [sourceAgentletId, sourcePath, showHidden, refresh, t]);

  const load = async (directory: string, cursor?: string) => {
    if (!source || pendingRef.current) return;
    if (entriesLoaded.current >= MAX_TREE_ENTRIES) {
      setError(t('files.treeLimit'));
      return;
    }
    const current = generation.current;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await listDeviceFiles(
        source.agentletId,
        { path: directory, showHidden, ...(cursor ? { cursor } : {}) },
        abortRef.current?.signal,
      );
      if (current !== generation.current) return;
      if (entriesLoaded.current + result.entries.length > MAX_TREE_ENTRIES)
        throw new Error(t('files.treeLimit'));
      entriesLoaded.current += result.entries.length;
      setPages((previous) => ({
        ...previous,
        [directory]: {
          ...result,
          entries: cursor
            ? [
                ...new Map(
                  [
                    ...(previous[directory]?.entries ?? []),
                    ...result.entries,
                  ].map((entry) => [entry.path, entry]),
                ).values(),
              ]
            : result.entries,
        },
      }));
      setExpanded((previous) => new Set(previous).add(directory));
    } catch (failure) {
      if (current === generation.current)
        setError(
          failure instanceof Error ? failure.message : t('files.failed'),
        );
    } finally {
      if (current === generation.current) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  };
  const rows = useMemo(() => {
    const result: Row[] = [];
    const visited = new Set<string>();
    const rootPath = sourcePath ? pages[sourcePath]?.path : undefined;
    const separator = rootPath?.startsWith('/') ? '/' : '\\';
    const visit = (directory: string, depth: number, parent: string) => {
      if (visited.has(directory) || depth > 32) return;
      visited.add(directory);
      const page = pages[directory];
      for (const entry of page?.entries ?? []) {
        const relativePath = parent
          ? `${parent}${separator}${entry.name}`
          : entry.name;
        result.push({ entry, depth, relativePath });
        if (entry.kind === 'directory' && expanded.has(entry.path))
          visit(entry.path, depth + 1, relativePath);
      }
      if (page?.nextCursor) result.push({ more: directory, depth });
    };
    if (sourcePath) visit(sourcePath, 0, '');
    return result;
  }, [pages, expanded, sourcePath]);

  useEffect(() => {
    if (focusIndex === null || !rows[focusIndex]) return;
    const panel = panelRef.current;
    const focused = document.activeElement;
    let cancelled = false;
    listRef.current?.scrollIntoView({
      index: focusIndex,
      done: () => {
        if (cancelled || !panel) return;
        if (
          panel.contains(document.activeElement) ||
          (focused &&
            !focused.isConnected &&
            document.activeElement === document.body)
        )
          panel
            .querySelector<HTMLElement>(`[data-file-index="${focusIndex}"]`)
            ?.focus({ preventScroll: true });
        setFocusIndex(null);
      },
    });
    return () => {
      cancelled = true;
    };
  }, [focusIndex, rows]);

  const activate = (entry: Entry, preview: boolean) => {
    if (!source) return;
    try {
      const action = preview ? openFileReference : addFileReferenceNode;
      action(
        source.canvasId,
        {
          agentletId: source.agentletId,
          path: entry.path,
          deviceName: selectedDevice?.displayName,
        },
        entry.name,
      );
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('files.failed'));
    }
  };
  const root = source ? pages[source.path] : undefined;
  return (
    <section
      ref={panelRef}
      className="flex min-h-0 flex-1 flex-col"
      aria-label={t('files.title')}
      onKeyDownCapture={(event) => {
        if (!(event.target instanceof HTMLElement)) return;
        const indexValue = event.target
          .closest('[data-file-index]')
          ?.getAttribute('data-file-index');
        if (
          indexValue === undefined ||
          indexValue === null ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        const index = Number(indexValue);
        let next =
          event.key === 'ArrowDown'
            ? Math.min(rows.length - 1, index + 1)
            : event.key === 'ArrowUp'
              ? Math.max(0, index - 1)
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? rows.length - 1
                  : null;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1;
        while (next >= 0 && next < rows.length) {
          const row = rows[next];
          if (
            row &&
            ('more' in row
              ? !pending
              : row.entry.kind === 'file' ||
                (row.entry.kind === 'directory' && !pending))
          ) {
            setFocusIndex(next);
            return;
          }
          next += step;
        }
      }}
    >
      <form
        className="flex shrink-0 flex-col gap-2 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canvasId && device && path) {
            openFiles({ canvasId, agentletId: device, path });
            setRefresh((value) => value + 1);
          }
        }}
      >
        <Select
          options={devices.map((candidate) => ({
            value: candidate.agentletId,
            label: candidate.displayName,
          }))}
          value={device}
          onChange={(value) => {
            setDevice(value);
            setPath('');
          }}
          placeholder={t('files.selectDevice')}
          ariaLabel={t('files.selectDevice')}
        />
        <div className="flex gap-1">
          <TextInput
            value={path}
            onChange={(event) => setPath(event.target.value)}
            mono
            aria-label={t('files.path')}
            placeholder={t('files.path')}
            className="min-w-0 flex-1"
          />
          <Button size="sm" type="submit" disabled={!path || !device}>
            {t('files.open')}
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            title={t('files.up')}
            disabled={
              !source || !root || root.parentPath === root.path || pending
            }
            onClick={() => {
              if (source && root && canvasId)
                openFiles({
                  canvasId,
                  agentletId: source.agentletId,
                  path: root.parentPath,
                });
            }}
          >
            <ArrowUp />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            title={t('files.refresh')}
            disabled={!source || pending}
            onClick={() => {
              setRefresh((value) => value + 1);
              void useAcpProfilesStore.getState().refresh();
            }}
          >
            <RefreshCw />
          </Button>
          <label className="text-fg-muted ml-auto flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(event) => setShowHidden(event.target.checked)}
            />
            {t('files.showHidden')}
          </label>
        </div>
      </form>
      {profilesError || error ? (
        <div role="alert" className="text-danger px-3 pb-2 text-xs">
          {error ?? profilesError?.message}
        </div>
      ) : null}
      {source && !selectedDevice ? (
        <div role="status" className="text-warning px-3 pb-2 text-xs">
          {t('files.offline')}
        </div>
      ) : null}
      {pending ? (
        <div role="status" className="text-fg-muted px-3 pb-2 text-xs">
          {t('files.loading')}
        </div>
      ) : null}
      {!source ? (
        <p className="text-fg-muted p-3 text-xs">{t('files.choosePath')}</p>
      ) : null}
      {root && !rows.length ? (
        <p className="text-fg-muted p-3 text-xs">{t('files.empty')}</p>
      ) : null}
      <Virtuoso
        ref={listRef}
        className="min-h-0 flex-1"
        data={rows}
        computeItemKey={(_, row) =>
          'entry' in row ? `${row.depth}:${row.entry.path}` : `more:${row.more}`
        }
        itemContent={(index, row) => {
          if ('more' in row)
            return (
              <Button
                className="m-1"
                data-file-index={index}
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void load(row.more, pages[row.more]?.nextCursor)}
              >
                {t('files.more')}
              </Button>
            );
          const { entry, depth, relativePath } = row;
          const directory = entry.kind === 'directory';
          const Icon = directory
            ? expanded.has(entry.path)
              ? FolderOpen
              : Folder
            : /\.(?:[cm]?[jt]sx?|json|py|rs|[ch](?:pp|xx)?|go|java|css|html|sh|ya?ml)$/i.test(
                  entry.name,
                )
              ? FileCode2
              : FileText;
          return (
            <FilesPanelEntryMenu
              name={entry.name}
              path={entry.path}
              relativePath={relativePath}
              onOpen={
                entry.kind === 'file' ? () => activate(entry, true) : undefined
              }
              onAdd={
                entry.kind === 'file' ? () => activate(entry, false) : undefined
              }
              canAdd={canWrite}
              onCopyResult={(copied) =>
                setError(copied ? null : t('files.copyFailed'))
              }
            >
              <div
                className={`flex h-7 items-center gap-1 ${selectedPath === entry.path ? 'bg-hover' : ''}`}
                style={{ paddingLeft: depth * 14 + 8 }}
              >
                {directory ? (
                  <Button
                    variant="ghost"
                    data-file-index={index}
                    size="sm"
                    className="text-fg-default h-7 min-w-0 flex-1 justify-start rounded-sm px-1 text-xs"
                    disabled={pending}
                    aria-expanded={expanded.has(entry.path)}
                    onClick={() => {
                      if (depth >= 32) {
                        setError(t('files.treeLimit'));
                        return;
                      }
                      if (!pages[entry.path]) void load(entry.path);
                      else
                        setExpanded((previous) => {
                          const next = new Set(previous);
                          if (!next.delete(entry.path)) next.add(entry.path);
                          return next;
                        });
                    }}
                  >
                    {expanded.has(entry.path) ? (
                      <ChevronDown />
                    ) : (
                      <ChevronRight />
                    )}
                    <Icon />
                    <span className="truncate" title={entry.path}>
                      {entry.name}
                    </span>
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      data-file-index={index}
                      size="sm"
                      className="text-fg-default h-7 min-w-0 flex-1 justify-start rounded-sm pr-1 pl-6 text-xs"
                      disabled={entry.kind !== 'file'}
                      aria-label={t('files.openFile', { name: entry.name })}
                      aria-pressed={selectedPath === entry.path}
                      title={t('files.openHint')}
                      onFocus={() => setSelectedPath(entry.path)}
                      onClick={(event) => {
                        setSelectedPath(entry.path);
                        if (event.detail === 0) activate(entry, true);
                      }}
                      onDoubleClick={() => activate(entry, true)}
                      draggable={entry.kind === 'file' && canWrite}
                      onDragStart={(event) => {
                        if (!source || entry.kind !== 'file') return;
                        if (
                          !selectCanWriteCanvas(useCanvasStore.getState()) ||
                          useCanvasStore.getState().canvasId !== source.canvasId
                        ) {
                          event.preventDefault();
                          setError(t('files.creationReadOnly'));
                          return;
                        }
                        setDragPayload(event, {
                          kind: 'fileReference',
                          origin: { type: 'user-created' },
                          data: {
                            label: entry.name,
                            fileReference: {
                              agentletId: source.agentletId,
                              path: entry.path,
                              deviceName: selectedDevice?.displayName,
                            },
                          },
                        });
                      }}
                    >
                      <Icon className="text-fg-muted h-3.5 w-3.5 shrink-0" />
                      <span className="truncate" title={entry.path}>
                        {entry.name}
                      </span>
                    </Button>
                  </>
                )}
              </div>
            </FilesPanelEntryMenu>
          );
        }}
      />
    </section>
  );
}
