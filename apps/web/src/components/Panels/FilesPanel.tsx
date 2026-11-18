// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  FileText,
  Monitor,
  RefreshCw,
  TextCursorInput,
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
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import { FolderPickerButton } from '@/components/Common/FolderPickerButton';
import {
  MENU_SECTION_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
} from '@/components/Common/menuStyles';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import useCanvasStore, { selectCanWriteCanvas } from '@/store/canvasStore';
import {
  filesPathKey,
  lastFilesDevice,
  usePanelStore,
} from '@/store/panelStore';
import { openPreviewFile } from '@/store/previewWorkspace/actions';
import {
  selectActiveTab,
  usePreviewWorkspaceStore,
} from '@/store/previewWorkspace/store';
import {
  addFileReferenceNode,
  deviceFileName,
  fileReferenceData,
} from '@/utils/deviceFile';
import { copyToClipboard } from '@/utils/io/clipboard';
import { setDragPayload } from '@/utils/io/dragDrop';

import {
  buildFileTreeRows,
  DeviceFileTree,
  type FileEntry,
} from './deviceFileTree';
import { FilesPanelEntryMenu } from './FilesPanelEntryMenu';
import {
  SIDEBAR_ROW_ICON_CLASS,
  SIDEBAR_ROW_SELECTED_FOREGROUND_CLASS,
} from './sidebarRowStyles';

/** The clickable part of a row; its highlight belongs to the row around it. */
const ROW_CLASS =
  'text-fg-default flex h-full w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md pr-1 text-left text-sm font-normal outline-none';
/** Width of the icon slot (`w-4`) plus the gap after it (`gap-1.5`). */
const ROW_INDENT_PX = 22;
/** Fixed-width slot, so names line up whether a row has an arrow or an icon. */
const ROW_ICON_SLOT_CLASS = cn(
  'flex h-6 w-4 shrink-0 items-center justify-center',
  SIDEBAR_ROW_ICON_CLASS,
);

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
  // The path being typed, while the location is edited by hand.
  const [typedPath, setTypedPath] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
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
  // Nobody should have to know a path to get started. With nothing open yet,
  // return to the device this Space browsed last; failing that, start on
  // this machine when it is connected, else on the first device.
  const lastDeviceId = usePanelStore((state) =>
    canvasId ? lastFilesDevice(canvasId, state.filesLastPaths) : undefined,
  );
  const firstDeviceId = (
    [lastDeviceId, localDeviceId]
      .map((id) => devices.find((candidate) => candidate.agentletId === id))
      .find(Boolean) ?? devices[0]
  )?.agentletId;
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
  // The listing reports the directory's real path; until it arrives, show
  // the one that was asked for.
  const currentPath = root?.path ?? sourcePath;
  // A filesystem root reports itself as its own parent.
  const parent =
    root && root.parentPath !== root.path ? root.parentPath : undefined;
  const locationName = currentPath
    ? deviceFileName(currentPath)
    : t('files.selectDevice');
  /** Open `directory` on this device, or re-list it when already there. */
  const go = (directory: string) => {
    if (!canvasId || !sourceAgentletId) return;
    if (directory === sourcePath) {
      tree.refresh();
      return;
    }
    // Going up, leave the folder just left open so it stays in view.
    if (directory === parent && root) tree.keepOpen(root.path);
    openFiles({ canvasId, agentletId: sourceAgentletId, path: directory });
  };
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
      {/* Insets match the Layers panel, so both line up under the tabs. */}
      <div className="flex h-8 shrink-0 items-center gap-0.5 px-2">
        {/* The location leads the header: its menu holds the way up and the
            occasional actions. */}
        {typedPath === null ? (
          <DropdownMenu
            aria-label={t('files.location')}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            triggerWrapperClassName="min-w-0 flex-1"
            trigger={
              <button
                type="button"
                className="text-fg-default hover:bg-hover focus-visible:ring-info flex h-6.5 max-w-full items-center gap-1 rounded-md px-2.5 text-sm font-medium outline-none focus-visible:ring-2"
                title={currentPath ?? undefined}
                aria-label={`${t('files.location')}: ${locationName}`}
              >
                <span className="truncate">{locationName}</span>
                {/* A slow listing shows here; a fast one changes nothing. */}
                <ChevronDown
                  className={cn(
                    'text-fg-subtle h-3 w-3 shrink-0',
                    reloading &&
                      'motion-safe:animate-pulse motion-safe:[animation-delay:400ms]',
                  )}
                />
              </button>
            }
          >
            {/* The full path says where this folder sits, and is there to be
                copied; going up is rare enough to be one step at a time. */}
            {currentPath ? (
              <>
                <DropdownMenuItem
                  className="text-fg-muted max-w-64 font-mono text-xs"
                  trailing={<Copy className="text-fg-subtle" aria-hidden />}
                  onClick={() => {
                    setMenuOpen(false);
                    void copyToClipboard(currentPath).then(
                      () => toast(t('files.pathCopied'), { tone: 'success' }),
                      () => setActionError(t('files.copyFailed')),
                    );
                  }}
                >
                  {currentPath}
                </DropdownMenuItem>
                <div role="separator" className={MENU_SEPARATOR_CLASS} />
              </>
            ) : null}
            <DropdownMenuItem
              icon={<ArrowUp />}
              disabled={!parent}
              onClick={() => {
                setMenuOpen(false);
                if (parent) go(parent);
              }}
            >
              {t('files.openParent')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<TextCursorInput />}
              disabled={!sourceAgentletId}
              onClick={() => {
                setMenuOpen(false);
                setTypedPath(currentPath ?? '');
              }}
            >
              {t('files.enterPath')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<RefreshCw />}
              disabled={!source}
              onClick={() => {
                setMenuOpen(false);
                tree.refresh();
                void useAcpProfilesStore.getState().refresh();
              }}
            >
              {t('files.refresh')}
            </DropdownMenuItem>
            <DropdownMenuItem
              role="menuitemcheckbox"
              aria-checked={showHidden}
              icon={<Eye />}
              trailing={
                showHidden ? (
                  <Check size={14} className="text-info-fg" aria-hidden />
                ) : undefined
              }
              onClick={() => {
                setMenuOpen(false);
                setShowHidden((value) => !value);
              }}
            >
              {t('files.showHidden')}
            </DropdownMenuItem>
          </DropdownMenu>
        ) : (
          <form
            className="min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              const next = typedPath.trim();
              setTypedPath(null);
              if (next) go(next);
            }}
          >
            <TextInput
              autoFocus
              value={typedPath}
              onChange={(event) => setTypedPath(event.target.value)}
              onFocus={(event) => event.target.select()}
              onBlur={() => setTypedPath(null)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setTypedPath(null);
              }}
              mono
              aria-label={t('files.path')}
              placeholder={t('files.path')}
              className="h-6.5 w-full py-0"
            />
          </form>
        )}
        {/* Which machine is being browsed is a separate choice from where on
            it; with a single device its name would only be noise. */}
        <DropdownMenu
          aria-label={t('files.selectDevice')}
          align="bottom-right"
          open={deviceMenuOpen}
          onOpenChange={setDeviceMenuOpen}
          triggerWrapperClassName="ml-auto flex min-w-0 shrink"
          trigger={
            <Button
              variant="ghost"
              size="sm"
              iconOnly={devices.length < 2}
              className="text-fg-muted max-w-28 min-w-0"
              title={selectedDevice?.displayName ?? t('files.selectDevice')}
            >
              <Monitor />
              {devices.length > 1 ? (
                <span className="truncate">
                  {selectedDevice?.displayName ?? t('files.selectDevice')}
                </span>
              ) : null}
            </Button>
          }
        >
          {devices.length ? (
            devices.map((candidate) => (
              <DropdownMenuItem
                key={candidate.agentletId}
                role="menuitemradio"
                aria-checked={candidate.agentletId === sourceAgentletId}
                icon={<Monitor />}
                trailing={
                  candidate.agentletId === sourceAgentletId ? (
                    <Check size={14} className="text-info-fg" aria-hidden />
                  ) : undefined
                }
                onClick={() => {
                  setDeviceMenuOpen(false);
                  if (candidate.agentletId !== sourceAgentletId)
                    browse(candidate.agentletId);
                }}
              >
                {candidate.displayName}
              </DropdownMenuItem>
            ))
          ) : (
            <p className={MENU_SECTION_LABEL_CLASS}>{t('files.noDevice')}</p>
          )}
        </DropdownMenu>
        <FolderPickerButton
          variant="ghost"
          targetAgentletId={sourceAgentletId ?? ''}
          enabled={!!sourceAgentletId}
          onPicked={go}
          onError={setActionError}
        />
      </div>
      {profilesError || error ? (
        <div role="alert" className="text-danger px-4.5 pb-2 text-xs">
          {error ?? profilesError?.message}
        </div>
      ) : null}
      {source && !selectedDevice ? (
        <div role="status" className="text-warning px-4.5 pb-2 text-xs">
          {t('files.offline')}
        </div>
      ) : null}
      {source && !snapshot.root && reloading ? (
        <p role="status" className="text-fg-muted px-4.5 py-3 text-xs">
          {t('files.loading')}
        </p>
      ) : null}
      {!source ? (
        <p className="text-fg-muted px-4.5 py-3 text-xs">
          {devices.length ? t('files.choosePath') : t('files.noDevice')}
        </p>
      ) : null}
      {root && !rows.length ? (
        <p className="text-fg-muted px-4.5 py-3 text-xs">{t('files.empty')}</p>
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
                className="text-fg-muted my-px"
                style={{ marginLeft: 8 + row.depth * ROW_INDENT_PX }}
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
          // One level in is the icon slot plus its gap, so a child's icon starts
          // exactly where its parent's name does.
          const indent = depth * ROW_INDENT_PX + 6;
          return (
            <FilesPanelEntryMenu
              name={entry.name}
              path={entry.path}
              relativePath={relativePath}
              onCopyResult={(copied) =>
                setActionError(copied ? null : t('files.copyFailed'))
              }
              selected={previewedPath === entry.path}
              onOpenHere={directory ? () => go(entry.path) : undefined}
              onAddToCanvas={
                entry.kind === 'file' && canWrite
                  ? () => addFileReferenceNode(reference(entry))
                  : undefined
              }
            >
              {directory ? (
                <button
                  type="button"
                  className={ROW_CLASS}
                  style={{ paddingLeft: indent }}
                  aria-busy={loading.has(entry.path)}
                  aria-expanded={expanded.has(entry.path)}
                  onClick={() => tree.toggle(entry.path, depth)}
                >
                  {/* The arrow turns at once and stays put: swapping in a
                      spinner flashes on every fast listing. Only a slow one
                      starts to pulse. */}
                  <span className={ROW_ICON_SLOT_CLASS}>
                    {loading.has(entry.path) ? (
                      <ChevronDown className="h-3 w-3 motion-safe:animate-pulse motion-safe:[animation-delay:400ms]" />
                    ) : expanded.has(entry.path) ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                  </span>
                  <span className="truncate">{entry.name}</span>
                </button>
              ) : entry.kind === 'file' ? (
                <button
                  type="button"
                  className={cn(
                    ROW_CLASS,
                    previewedPath === entry.path &&
                      SIDEBAR_ROW_SELECTED_FOREGROUND_CLASS,
                  )}
                  style={{ paddingLeft: indent }}
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
                  <span
                    className={cn(
                      ROW_ICON_SLOT_CLASS,
                      previewedPath === entry.path && 'text-inherit',
                    )}
                  >
                    <FileText className="h-3.5 w-3.5" />
                  </span>
                  <span className="truncate">{entry.name}</span>
                </button>
              ) : (
                <span
                  className={cn(ROW_CLASS, 'text-fg-subtle cursor-default')}
                  style={{ paddingLeft: indent }}
                  title={entry.path}
                >
                  <span className={ROW_ICON_SLOT_CLASS}>
                    <FileText className="h-3.5 w-3.5" />
                  </span>
                  <span className="truncate">{entry.name}</span>
                </span>
              )}
            </FilesPanelEntryMenu>
          );
        }}
      />
    </section>
  );
}
