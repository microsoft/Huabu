// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Check, Info, Pencil, X } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useWorkspaceStore } from '../../store/workspaceStore';
import { Button } from '../Common/Button';
import { cn } from '../Common/cn';
import { TextInput } from '../Common/TextInput';
import { toast } from '../Common/Toast';
import { Tooltip } from '../Common/Tooltip';

import type { WorkspaceDescriptor } from '../../api/workspace';
import type { TFunction } from 'i18next';

/**
 * The one list of named Workspaces (`capabilities.namedWorkspaces`), shared by
 * the first-launch page, the header's quick-switch popover and the Switch
 * Workspace dialog. Each row shows the Workspace's name, the caller's role and
 * Space count when the server sends them, marks the current one, and offers
 * rename where the caller may manage it. What choosing a row does is the
 * host's: switch at once, or mark it for the host's own Switch button.
 *
 * Folder Workspaces (Disk "Home folder" mode) keep their own path list on the
 * first-launch page; they are known by path, not by name.
 */

/**
 * Whether the person's own lists show it by default: Workspaces of their own
 * and those shared with them. Another person's Workspace an administrator
 * reaches only through that role (`adminAccessOnly`) is left out, unless it
 * is the current one, so the person still sees where they are.
 */
export function isOwnWorkspace(workspace: WorkspaceDescriptor): boolean {
  return workspace.active || !workspace.adminAccessOnly;
}

/**
 * The detail line's parts, such as `role: "Owner"` and `spaces: "8 Spaces"`;
 * either is left out when the server did not send it.
 */
export function workspaceDetail(
  t: TFunction,
  workspace: Pick<WorkspaceDescriptor, 'role' | 'spaceCount'>,
): { role?: string; spaces?: string } {
  return {
    role:
      workspace.role === undefined
        ? undefined
        : workspace.role === null
          ? t('workspace.sharedSpacesOnly')
          : t(`people.role.${workspace.role}`),
    spaces:
      workspace.spaceCount === undefined
        ? undefined
        : t('canvasList.canvasCount', { count: workspace.spaceCount }),
  };
}

type Density = 'compact' | 'comfortable';

/** The row's face: initial tile, name, detail line and the current mark. */
function WorkspaceRowFace({
  workspace,
  density,
}: {
  workspace: WorkspaceDescriptor;
  density: Density;
}) {
  const { t } = useTranslation();
  const { role, spaces } = workspaceDetail(t, workspace);
  // Another person's Workspace, reached as the administrator: the role is
  // theirs by that office, which the (i) explains on hover.
  const adminNote = workspace.adminAccessOnly
    ? t('workspace.adminAccessNote')
    : null;
  const comfortable = density === 'comfortable';
  return (
    <>
      <span
        aria-hidden
        className={cn(
          'flex shrink-0 items-center justify-center rounded-lg font-semibold',
          comfortable ? 'size-9 text-sm' : 'size-7 text-xs',
          workspace.active
            ? 'bg-info-bg text-info-fg'
            : 'bg-hover text-fg-muted',
        )}
      >
        {[...workspace.name.trim()][0]?.toLocaleUpperCase() ?? '?'}
      </span>
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span
          className={cn(
            'text-fg-default truncate',
            comfortable ? 'text-sm font-semibold' : 'text-sm font-medium',
          )}
        >
          {workspace.name}
        </span>
        {(role || spaces) && (
          <span className="text-fg-subtle flex min-w-0 items-center text-xs">
            {role && <span className="shrink-0">{role}</span>}
            {role && adminNote && (
              <>
                <Tooltip content={adminNote} contentClassName="max-w-64">
                  <Info
                    aria-hidden
                    size={12}
                    className="ml-1 shrink-0"
                    data-testid="admin-access-note"
                  />
                </Tooltip>
                <span className="sr-only"> ({adminNote})</span>
              </>
            )}
            {role && spaces && (
              <span className="shrink-0 whitespace-pre">{' · '}</span>
            )}
            {spaces && <span className="truncate">{spaces}</span>}
          </span>
        )}
      </span>
      {workspace.active &&
        (comfortable ? (
          <span className="text-info-fg shrink-0 text-xs font-semibold">
            {t('workspace.current')}
          </span>
        ) : (
          <Check
            size={16}
            className="text-info-fg shrink-0"
            role="img"
            aria-label={t('workspace.currentWorkspace')}
          />
        ))}
    </>
  );
}

/**
 * A row that can turn into a name field. The row's own control (`children`)
 * is shown until the pencil is pressed; the pencil is offered only when the
 * server says the caller may manage this Workspace. The list keeps which row
 * is being renamed, so only one is at a time.
 */
function RenamableWorkspaceRow({
  workspace,
  disabled,
  density,
  editing,
  onEditingChange,
  children,
}: {
  workspace: WorkspaceDescriptor;
  disabled: boolean;
  density: Density;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const [draft, setDraftState] = useState<string | null>(null);
  const setDraft = (next: string | null) => {
    setDraftState(next);
    if ((next !== null) !== editing) onEditingChange(next !== null);
  };
  // Another row starting a rename ends this one.
  useEffect(() => {
    if (!editing) setDraftState(null);
  }, [editing]);
  const [saving, setSaving] = useState(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  // Closing the editor removes the focused field, so keyboard focus returns
  // to this row's Rename button instead of falling to the page body.
  const refocus = useRef(false);
  useEffect(() => {
    if (draft !== null || !refocus.current) return;
    refocus.current = false;
    renameButton.current?.focus();
  }, [draft]);
  const close = () => {
    refocus.current = true;
    setDraft(null);
  };

  const save = async () => {
    const trimmed = draft?.trim();
    if (!trimmed) return;
    if (trimmed === workspace.name) {
      close();
      return;
    }
    setSaving(true);
    try {
      await renameWorkspace(workspace.workspaceId, trimmed);
      close();
    } catch (error) {
      console.error('[workspace-list] Could not rename Workspace:', error);
      toast(
        error instanceof Error && error.message
          ? error.message
          : t('workspace.renameFailed'),
        { tone: 'danger' },
      );
    } finally {
      setSaving(false);
    }
  };

  if (draft !== null) {
    return (
      <div className="flex items-center gap-1">
        <TextInput
          autoFocus
          aria-label={t('workspace.renameLabel', { workspace: workspace.name })}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter and Escape confirm or cancel an IME composition first.
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            if (event.key === 'Enter') {
              event.preventDefault();
              void save();
            }
            // The host stops its own Escape while a rename is open
            // (`onRenamingChange`), so this cancels the rename alone.
            if (event.key === 'Escape') close();
          }}
          disabled={saving}
          className="min-w-0 flex-1"
        />
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={saving || !draft.trim()}
        >
          {t('workspace.renameSave')}
        </Button>
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          onClick={close}
          disabled={saving}
          title={t('workspace.renameCancel')}
          aria-label={t('workspace.renameCancel')}
        >
          <X size={14} />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {children}
      {workspace.canManage && (
        <Button
          ref={renameButton}
          variant="ghost"
          iconOnly
          size="sm"
          // A finger-sized target where rows are (dialog, phone sheet).
          className={density === 'comfortable' ? 'size-10' : 'size-8'}
          onClick={() => setDraft(workspace.name)}
          disabled={disabled}
          title={t('workspace.rename')}
          aria-label={t('workspace.renameLabel', { workspace: workspace.name })}
        >
          <Pencil size={14} />
        </Button>
      )}
    </div>
  );
}

const ROW_CLASS =
  'flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50';

interface WorkspaceListProps {
  workspaces: WorkspaceDescriptor[];
  /**
   * `activate`: each row is a button and choosing it is final (the host
   * switches at once). `select`: the rows are one radio group and choosing
   * marks a row for the host's own Switch button.
   */
  mode: 'activate' | 'select';
  /** Called with the chosen row's Workspace. */
  onChoose: (workspace: WorkspaceDescriptor) => void;
  /** With `select`: the marked row's id. */
  selectedId?: string | null;
  /** While a switch or sync is in flight, no row can be chosen or renamed. */
  disabled?: boolean;
  /** `compact` for menus and the first-launch list; `comfortable` for the dialog. */
  density?: Density;
  /** Names the list, e.g. its section heading. */
  'aria-labelledby'?: string;
  /**
   * Whether a row's name field is open. A popover or dialog host keeps
   * Escape for that field meanwhile, so Escape cancels the rename first.
   */
  onRenamingChange?: (renaming: boolean) => void;
}

/**
 * The shared list. Rows keep the server's order, which is most recently used
 * first.
 */
export const WorkspaceList = forwardRef<HTMLDivElement, WorkspaceListProps>(
  function WorkspaceList(
    {
      workspaces,
      mode,
      onChoose,
      selectedId = null,
      disabled = false,
      density = 'compact',
      'aria-labelledby': labelledBy,
      onRenamingChange,
    },
    ref,
  ) {
    const group = useId();
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const renaming = renamingId !== null;
    const onRenamingChangeRef = useRef(onRenamingChange);
    onRenamingChangeRef.current = onRenamingChange;
    useEffect(() => {
      onRenamingChangeRef.current?.(renaming);
    }, [renaming]);
    const height =
      density === 'comfortable' ? 'min-h-14 py-2' : 'min-h-11 py-1.5';
    return (
      <div
        ref={ref}
        role={mode === 'select' ? 'radiogroup' : 'list'}
        aria-labelledby={labelledBy}
        className="flex flex-col gap-0.5"
      >
        {workspaces.map((workspace) => (
          <div
            key={workspace.workspaceId}
            role={mode === 'select' ? undefined : 'listitem'}
          >
            <RenamableWorkspaceRow
              workspace={workspace}
              disabled={disabled}
              density={density}
              editing={renamingId === workspace.workspaceId}
              onEditingChange={(editing) =>
                setRenamingId((current) =>
                  editing
                    ? workspace.workspaceId
                    : current === workspace.workspaceId
                      ? null
                      : current,
                )
              }
            >
              {mode === 'select' ? (
                <label
                  className={cn(
                    ROW_CLASS,
                    height,
                    'has-[input:focus-visible]:ring-info border has-[input:focus-visible]:ring-2',
                    workspace.workspaceId === selectedId
                      ? 'border-info bg-info-bg/60'
                      : 'hover:bg-hover border-transparent',
                    disabled && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <input
                    type="radio"
                    name={group}
                    className="sr-only"
                    value={workspace.workspaceId}
                    checked={workspace.workspaceId === selectedId}
                    disabled={disabled}
                    onChange={() => onChoose(workspace)}
                  />
                  <WorkspaceRowFace workspace={workspace} density={density} />
                </label>
              ) : (
                <button
                  type="button"
                  aria-current={workspace.active ? 'true' : undefined}
                  disabled={disabled}
                  onClick={() => onChoose(workspace)}
                  className={cn(
                    ROW_CLASS,
                    height,
                    'focus-visible:ring-info enabled:hover:bg-hover focus-visible:ring-2 focus-visible:outline-none',
                    workspace.active && 'bg-hover/60',
                  )}
                >
                  <WorkspaceRowFace workspace={workspace} density={density} />
                </button>
              )}
            </RenamableWorkspaceRow>
          </div>
        ))}
      </div>
    );
  },
);

/**
 * Create a named Workspace, and, where Workspaces are Disk folders
 * (`capabilities.folderWorkspaces`), open a folder on the Server as one. The
 * host decides what happens after (switching to it, closing a dialog).
 */
export function CreateWorkspaceFields({
  onCreate,
  onOpenFolder,
  disabled,
  hint,
  nameInputRef,
}: {
  onCreate: (name: string) => void;
  onOpenFolder?: (path: string) => void;
  disabled: boolean;
  /** A line under the name field, e.g. who will own the new Workspace. */
  hint?: string;
  nameInputRef?: React.Ref<HTMLInputElement>;
}) {
  const { t } = useTranslation();
  const nameId = useId();
  const folderId = useId();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');

  const create = () => {
    const trimmed = name.trim();
    if (trimmed) onCreate(trimmed);
  };
  const open = () => {
    const trimmed = folder.trim();
    if (trimmed && onOpenFolder) onOpenFolder(trimmed);
  };

  return (
    <>
      <label
        htmlFor={nameId}
        className="text-fg-subtle mb-1.5 block text-xs font-medium"
      >
        {t('workspace.newWorkspace')}
      </label>
      <div className="flex gap-2">
        <TextInput
          ref={nameInputRef}
          id={nameId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            if (event.key === 'Enter') {
              event.preventDefault();
              create();
            }
          }}
          placeholder={t('workspace.namePlaceholder')}
          disabled={disabled}
          className="min-w-0 flex-1"
        />
        <Button onClick={create} disabled={disabled || !name.trim()}>
          {t('workspace.create')}
        </Button>
      </div>
      {hint && <p className="text-fg-subtle mt-1.5 text-xs">{hint}</p>}

      {onOpenFolder && (
        <>
          <label
            htmlFor={folderId}
            className="text-fg-subtle mt-4 mb-1.5 block text-xs font-medium"
          >
            {t('workspace.openFolder')}
          </label>
          <div className="flex gap-2">
            <TextInput
              id={folderId}
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  open();
                }
              }}
              placeholder={t('workspace.pathPlaceholder')}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1"
            />
            <Button onClick={open} disabled={disabled || !folder.trim()}>
              {t('workspace.openFolderButton')}
            </Button>
          </div>
        </>
      )}
    </>
  );
}
