// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  FileCode2,
  FileText,
  Monitor,
  RefreshCw,
  TextCursorInput,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

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
import {
  addFileReferenceNode,
  closePreviewFile,
  openFileReference,
  openPreviewFile,
} from '@/store/previewWorkspace/actions';
import {
  selectActiveTab,
  usePreviewWorkspaceStore,
} from '@/store/previewWorkspace/store';
import { deviceFileName, fileReferenceData } from '@/utils/deviceFile';
import { copyToClipboard } from '@/utils/io/clipboard';
import {
  downloadDeviceFile,
  formatDeviceDownloadError,
} from '@/utils/io/deviceFileDownload';
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

const CODE_FILE =
  /\.(?:[cm]?[jt]sx?|json|py|rs|[ch](?:pp|xx)?|go|java|css|html|sh|ya?ml)$/i;

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
  // Failures of panel actions (copy, folder picker, download); listing failures
  // live in the tree.
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloadingPaths, setDownloadingPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const downloadControllers = useRef<Map<string, AbortController>>(new Map());
  const [tree] = useState(() => new DeviceFileTree());
  const snapshot = useSyncExternalStore(tree.subscribe, tree.getSnapshot);
  const { pages, expanded, loading, reloading } = snapshot;
  const rows = useMemo(() => buildFileTreeRows(snapshot), [snapshot]);
  // The row keyboard navigation is moving to; it may not be mounted yet.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const listRef = useRef<VirtuosoHandle>(null);
  const selectedDevice = devices.find(
    (candidate) => candidate.agentletId === sourceAgentletId,
  );
  useEffect(() => {
    void useAcpProfilesStore.getState().refresh();
    const controllers = downloadControllers.current;
    return () => {
      for (const controller of controllers.values()) {
        controller.abort();
      }
      controllers.clear();
    };
  }, []);
  useEffect(() => {
    setActionError(null);
    setFocusIndex(null);
  }, [sourceAgentletId, sourcePath]);
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
  /** Put a reference card for `entry` in the Space, opening it when asked. */
  const addToSpace = (entry: FileEntry, open: boolean) => {
    if (!source) return;
    try {
      (open ? openFileReference : addFileReferenceNode)(
        source.canvasId,
        reference(entry),
        entry.name,
      );
      // The node's own Preview takes over from the node-free one.
      if (open) closePreviewFile(reference(entry));
      setActionError(null);
    } catch (failure) {
      setActionError(
        failure instanceof Error ? failure.message : t('files.failed'),
      );
    }
  };
  /** Download `entry` to the browser without importing it into the Space. */
  const downloadEntry = async (entry: FileEntry) => {
    if (!sourceAgentletId || entry.kind !== 'file') return;
    const key = `${sourceAgentletId}\0${entry.path}`;
    if (downloadControllers.current.has(key)) return;
    const abort = new AbortController();
    downloadControllers.current.set(key, abort);
    setDownloadingPaths((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    setActionError(null);
    try {
      await downloadDeviceFile(sourceAgentletId, entry.path, {
        signal: abort.signal,
      });
    } catch (failure) {
      if (!abort.signal.aborted) {
        setActionError(formatDeviceDownloadError(failure, t));
      }
    } finally {
      downloadControllers.current.delete(key);
      setDownloadingPaths((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };
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
        // Rows that are neither a file nor a folder have nothing to focus.
        const step = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1;
        while (next >= 0 && next < rows.length) {
          const row = rows[next];
          if (
            row &&
            ('more' in row ||
              row.entry.kind === 'file' ||
              row.entry.kind === 'directory')
          ) {
            setFocusIndex(next);
            return;
          }
          next += step;
        }
      }}
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
              disabled={!source || reloading}
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
                data-file-index={index}
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
              onDownload={
                entry.kind === 'file'
                  ? () => void downloadEntry(entry)
                  : undefined
              }
              downloading={
                entry.kind === 'file' &&
                Boolean(sourceAgentletId) &&
                downloadingPaths.has(`${sourceAgentletId}\0${entry.path}`)
              }
              onOpen={
                entry.kind === 'file'
                  ? () => addToSpace(entry, true)
                  : undefined
              }
              onAdd={
                entry.kind === 'file'
                  ? () => addToSpace(entry, false)
                  : undefined
              }
              canAdd={canWrite}
            >
              {directory ? (
                <button
                  type="button"
                  data-file-index={index}
                  className={ROW_CLASS}
                  style={{ paddingLeft: indent }}
                  aria-busy={loading.has(entry.path)}
                  aria-expanded={expanded.has(entry.path)}
                  onClick={() => tree.toggle(entry.path, depth)}
                >
                  {/* The arrow follows the click at once and stays put:
                      swapping in a spinner flashes on every fast listing.
                      Only a slow one starts to pulse. */}
                  <span className={ROW_ICON_SLOT_CLASS}>
                    {expanded.has(entry.path) ? (
                      <ChevronDown
                        className={cn(
                          'h-3 w-3',
                          loading.has(entry.path) &&
                            'motion-safe:animate-pulse motion-safe:[animation-delay:400ms]',
                        )}
                      />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                  </span>
                  <span className="truncate" title={entry.path}>
                    {entry.name}
                  </span>
                </button>
              ) : entry.kind === 'file' ? (
                <button
                  type="button"
                  data-file-index={index}
                  className={cn(
                    ROW_CLASS,
                    previewedPath === entry.path &&
                      SIDEBAR_ROW_SELECTED_FOREGROUND_CLASS,
                  )}
                  style={{ paddingLeft: indent }}
                  aria-current={previewedPath === entry.path || undefined}
                  draggable={canWrite}
                  onClick={() => openPreviewFile(reference(entry))}
                  onDragStart={(event) => {
                    // Write access may have changed since this row rendered.
                    const canvas = useCanvasStore.getState();
                    if (
                      !selectCanWriteCanvas(canvas) ||
                      canvas.canvasId !== source?.canvasId
                    ) {
                      event.preventDefault();
                      setActionError(t('files.creationReadOnly'));
                      return;
                    }
                    setDragPayload(event, {
                      kind: 'fileReference',
                      origin: { type: 'user-created' },
                      data: fileReferenceData(reference(entry)),
                    });
                  }}
                >
                  <span
                    className={cn(
                      ROW_ICON_SLOT_CLASS,
                      previewedPath === entry.path && 'text-inherit',
                    )}
                  >
                    {CODE_FILE.test(entry.name) ? (
                      <FileCode2 className="h-3.5 w-3.5" />
                    ) : (
                      <FileText className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <span className="truncate" title={entry.path}>
                    {entry.name}
                  </span>
                </button>
              ) : (
                <span
                  className={cn(ROW_CLASS, 'text-fg-subtle cursor-default')}
                  style={{ paddingLeft: indent }}
                >
                  <span className={ROW_ICON_SLOT_CLASS}>
                    <FileText className="h-3.5 w-3.5" />
                  </span>
                  <span className="truncate" title={entry.path}>
                    {entry.name}
                  </span>
                </span>
              )}
            </FilesPanelEntryMenu>
          );
        }}
      />
    </section>
  );
}
