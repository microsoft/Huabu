// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  Plus,
  ArrowUp,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso } from 'react-virtuoso';

import { listDeviceFiles } from '@/api/device-files';
import { Button } from '@/components/Common/Button';
import { Select } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import useCanvasStore from '@/store/canvasStore';
import { usePanelStore } from '@/store/panelStore';
import { setDragPayload } from '@/utils/io/dragDrop';

import type { FileListResult } from '@huabu/shared';

type Entry = FileListResult['entries'][number];
type Row = { entry: Entry; depth: number } | { more: string; depth: number };
const MAX_TREE_ENTRIES = 2000;

export function FilesPanel() {
  const { t } = useTranslation();
  const canvasId = useCanvasStore((state) => state.canvasId);
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
    const visit = (directory: string, depth: number) => {
      if (visited.has(directory) || depth > 32) return;
      visited.add(directory);
      const page = pages[directory];
      for (const entry of page?.entries ?? []) {
        result.push({ entry, depth });
        if (entry.kind === 'directory' && expanded.has(entry.path))
          visit(entry.path, depth + 1);
      }
      if (page?.nextCursor) result.push({ more: directory, depth });
    };
    if (sourcePath) visit(sourcePath, 0);
    return result;
  }, [pages, expanded, sourcePath]);

  const add = (entry: Entry) => {
    if (!source) return;
    useCanvasStore.getState().addNode({
      nodeType: 'fileReference',
      data: {
        label: entry.name,
        origin: { type: 'user-created' },
        fileReference: {
          agentletId: source.agentletId,
          path: entry.path,
          deviceName: selectedDevice?.displayName,
        },
      },
      size: { width: 400, height: 180 },
    });
  };
  const root = source ? pages[source.path] : undefined;
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={t('files.title')}
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
        className="min-h-0 flex-1"
        data={rows}
        computeItemKey={(_, row) =>
          'entry' in row ? `${row.depth}:${row.entry.path}` : `more:${row.more}`
        }
        itemContent={(_, row) => {
          if ('more' in row)
            return (
              <Button
                className="m-1"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void load(row.more, pages[row.more]?.nextCursor)}
              >
                {t('files.more')}
              </Button>
            );
          const { entry, depth } = row;
          const directory = entry.kind === 'directory';
          const Icon = directory ? Folder : FileText;
          return (
            <div
              className="hover:bg-hover flex h-8 items-center gap-1 pr-2"
              style={{ paddingLeft: depth * 14 + 8 }}
            >
              {directory ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-w-0 flex-1 justify-start truncate"
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
                  <span className="truncate">{entry.name}</span>
                </Button>
              ) : (
                <>
                  <span
                    className="text-fg-default flex min-w-0 flex-1 items-center gap-1.5 pl-2 text-xs"
                    draggable={entry.kind === 'file'}
                    onDragStart={(event) => {
                      if (!source || entry.kind !== 'file') return;
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
                  </span>
                  {entry.kind === 'file' ? (
                    <Button
                      size="sm"
                      iconOnly
                      variant="ghost"
                      title={t('files.add', { name: entry.name })}
                      onClick={() => add(entry)}
                    >
                      <Plus />
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          );
        }}
      />
    </section>
  );
}
