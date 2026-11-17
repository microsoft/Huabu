// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  ChevronRight,
  ChevronDown,
  FileText,
  ArrowUp,
  RefreshCw,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso } from 'react-virtuoso';

import { Button } from '@/components/Common/Button';
import { cn } from '@/components/Common/cn';
import { FolderPickerButton } from '@/components/Common/FolderPickerButton';
import { Select } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import useCanvasStore, { selectCanWriteCanvas } from '@/store/canvasStore';
import { filesPathKey, usePanelStore } from '@/store/panelStore';
import { openPreviewFile } from '@/store/previewWorkspace/actions';
import {
  selectActiveTab,
  usePreviewWorkspaceStore,
} from '@/store/previewWorkspace/store';
import { addFileReferenceNode, fileReferenceData } from '@/utils/deviceFile';
import { setDragPayload } from '@/utils/io/dragDrop';

import {
  buildFileTreeRows,
  DeviceFileTree,
  type FileEntry,
} from './deviceFileTree';
import { FilesPanelEntryMenu } from './FilesPanelEntryMenu';

export function FilesPanel() {
  const { t } = useTranslation();
  const canvasId = useCanvasStore((state) => state.canvasId);
  const location = usePanelStore((state) => state.filesLocation);
  const openFiles = usePanelStore((state) => state.openFiles);
  const devices = useAcpProfilesStore((state) => state.connectedDevices);
  const profilesError = useAcpProfilesStore((state) => state.error);
  const canWrite = useCanvasStore(selectCanWriteCanvas);
  // The remembered directory browsing was started from, until it has loaded.
  const [rememberedStart, setRememberedStart] = useState<string | null>(null);
  const localDeviceId = useAcpProfilesStore(
    (state) => state.folderPickerAgentletId,
  );
  const source = location?.canvasId === canvasId ? location : null;
  const sourceAgentletId = source?.agentletId;
  const sourcePath = source?.path;
  const previewedPath = usePreviewWorkspaceStore((state) => {
    const target = selectActiveTab(state)?.target;
    return target?.kind === 'file' && target.agentletId === sourceAgentletId
      ? target.path
      : null;
  });
  const device = sourceAgentletId ?? '';
  const [path, setPath] = useState(source?.path ?? '');
  const [showHidden, setShowHidden] = useState(false);
  // Failures of panel actions (copy, folder picker); listing failures live
  // in the tree.
  const [actionError, setActionError] = useState<string | null>(null);
  const [tree] = useState(() => new DeviceFileTree());
  const snapshot = useSyncExternalStore(tree.subscribe, tree.getSnapshot);
  const { pages, expanded, loading, reloading } = snapshot;
  const rows = useMemo(() => buildFileTreeRows(snapshot), [snapshot]);
  const selectedDevice = devices.find(
    (candidate) => candidate.agentletId === sourceAgentletId,
  );
  useEffect(() => {
    void useAcpProfilesStore.getState().refresh();
  }, []);
  useEffect(() => {
    setPath(sourcePath ?? '');
    setActionError(null);
  }, [sourceAgentletId, sourcePath]);

  useEffect(() => {
    if (sourceAgentletId && sourcePath)
      tree.open(sourceAgentletId, sourcePath, showHidden);
    else tree.close();
  }, [tree, sourceAgentletId, sourcePath, showHidden]);
  useEffect(() => () => tree.close(), [tree]);

  /** Where browsing starts on a device: its last directory here, else its root. */
  const browse = useCallback(
    (agentletId: string, useRemembered = true) => {
      if (!canvasId) return;
      const remembered = useRemembered
        ? usePanelStore.getState().filesLastPaths[
            filesPathKey(canvasId, agentletId)
          ]
        : undefined;
      const platform = useAcpProfilesStore
        .getState()
        .connectedDevices.find(
          (candidate) => candidate.agentletId === agentletId,
        )?.platform;
      setRememberedStart(remembered ?? null);
      openFiles({
        canvasId,
        agentletId,
        path: remembered ?? (platform?.startsWith('win') ? 'C:\\' : '/'),
      });
    },
    [canvasId, openFiles],
  );
  // Nobody should have to know a path to get started: with nothing open yet,
  // start on this machine when it is connected, else on the first device.
  const firstDeviceId =
    devices.find((candidate) => candidate.agentletId === localDeviceId)
      ?.agentletId ?? devices[0]?.agentletId;
  useEffect(() => {
    if (!source && firstDeviceId) browse(firstDeviceId);
  }, [source, firstDeviceId, browse]);
  // A remembered directory may be gone by now; start at the root instead.
  const rootFailed =
    snapshot.error?.kind === 'root' && snapshot.error.path === sourcePath;
  const fallingBack = rootFailed && rememberedStart === sourcePath;
  useEffect(() => {
    if (rememberedStart === null) return;
    if (fallingBack && sourceAgentletId) browse(sourceAgentletId, false);
    else if (rememberedStart !== sourcePath || snapshot.root === sourcePath)
      setRememberedStart(null);
  }, [
    fallingBack,
    rememberedStart,
    snapshot.root,
    sourceAgentletId,
    sourcePath,
    browse,
  ]);

  const reference = (entry: FileEntry) => ({
    agentletId: sourceAgentletId ?? '',
    path: entry.path,
    deviceName: selectedDevice?.displayName,
  });
  const root = source && snapshot.root ? pages[snapshot.root] : undefined;
  const treeError = snapshot.error
    ? snapshot.error.kind === 'limit'
      ? t('files.treeLimit')
      : (snapshot.error.message ?? t('files.failed'))
    : null;
  // While a remembered directory falls back to the root, its failure is not
  // the user's to act on.
  const error = actionError ?? (fallingBack ? null : treeError);
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={t('files.title')}
    >
      <form
        className="flex shrink-0 flex-col gap-2 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canvasId || !device || !path) return;
          // Opening the directory already on screen re-lists it.
          if (path === sourcePath) tree.refresh();
          else openFiles({ canvasId, agentletId: device, path });
        }}
      >
        <Select
          options={devices.map((candidate) => ({
            value: candidate.agentletId,
            label: candidate.displayName,
          }))}
          value={device}
          onChange={(value) => browse(value)}
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
          <FolderPickerButton
            targetAgentletId={device}
            enabled={!!device}
            onPicked={(picked) => {
              if (canvasId && device)
                openFiles({ canvasId, agentletId: device, path: picked });
            }}
            onError={setActionError}
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
            disabled={!source || !root || root.parentPath === root.path}
            onClick={() => {
              if (source && root && canvasId) {
                // Keep the directory being left open under its parent.
                tree.keepOpen(root.path);
                openFiles({
                  canvasId,
                  agentletId: source.agentletId,
                  path: root.parentPath,
                });
              }
            }}
          >
            <ArrowUp />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            title={t('files.refresh')}
            disabled={!source}
            onClick={() => {
              tree.refresh();
              void useAcpProfilesStore.getState().refresh();
            }}
          >
            <RefreshCw
              className={reloading ? 'motion-safe:animate-spin' : undefined}
            />
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
      {source && !snapshot.root && reloading ? (
        <p role="status" className="text-fg-muted p-3 text-xs">
          {t('files.loading')}
        </p>
      ) : null}
      {!source ? (
        <p className="text-fg-muted p-3 text-xs">
          {devices.length ? t('files.choosePath') : t('files.noDevice')}
        </p>
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
                disabled={loading.has(row.more)}
                onClick={() => tree.loadMore(row.more)}
              >
                {t('files.more')}
              </Button>
            );
          const { entry, depth, relativePath } = row;
          const directory = entry.kind === 'directory';
          return (
            <FilesPanelEntryMenu
              name={entry.name}
              path={entry.path}
              relativePath={relativePath}
              onCopyResult={(copied) =>
                setActionError(copied ? null : t('files.copyFailed'))
              }
              onAddToCanvas={
                entry.kind === 'file' && canWrite
                  ? () => addFileReferenceNode(reference(entry))
                  : undefined
              }
            >
              <div
                className="hover:bg-hover flex h-8 items-center gap-1 pr-2"
                style={{ paddingLeft: depth * 14 + 8 }}
              >
                {directory ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-w-0 flex-1 justify-start truncate"
                    aria-busy={loading.has(entry.path)}
                    aria-expanded={expanded.has(entry.path)}
                    onClick={() => tree.toggle(entry.path, depth)}
                  >
                    {/* The arrow turns at once and stays put: swapping in a
                        spinner flashes on every fast listing. Only a slow
                        one starts to pulse. */}
                    {loading.has(entry.path) ? (
                      <ChevronDown className="motion-safe:animate-pulse motion-safe:[animation-delay:400ms]" />
                    ) : expanded.has(entry.path) ? (
                      <ChevronDown />
                    ) : (
                      <ChevronRight />
                    )}
                    <span className="truncate">{entry.name}</span>
                  </Button>
                ) : entry.kind === 'file' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'min-w-0 flex-1 justify-start truncate font-normal',
                      previewedPath === entry.path && 'bg-info-bg',
                    )}
                    aria-current={previewedPath === entry.path || undefined}
                    title={entry.path}
                    draggable
                    onClick={() => openPreviewFile(reference(entry))}
                    onDragStart={(event) =>
                      setDragPayload(event, {
                        kind: 'fileReference',
                        origin: { type: 'user-created' },
                        data: fileReferenceData(reference(entry)),
                      })
                    }
                  >
                    <FileText className="text-fg-muted" />
                    <span className="truncate">{entry.name}</span>
                  </Button>
                ) : (
                  <span
                    className="text-fg-muted flex h-7 min-w-0 flex-1 items-center gap-1.5 px-2 text-xs"
                    title={entry.path}
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{entry.name}</span>
                  </span>
                )}
              </div>
            </FilesPanelEntryMenu>
          );
        }}
      />
    </section>
  );
}
