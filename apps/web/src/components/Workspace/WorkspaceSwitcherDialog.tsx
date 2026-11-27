// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { OPEN_WORKSPACE_SWITCHER } from './useOpenWorkspaceSwitcher';
import {
  useWorkspaceSwitch,
  useWorkspaceSwitchRoute,
} from './useWorkspaceSwitch';
import {
  CreateWorkspaceFields,
  isOwnWorkspace,
  WorkspaceList,
} from './WorkspaceList';
import {
  useWorkspaceLabel,
  useWorkspaceStore,
} from '../../store/workspaceStore';
import { useWorkspaceSwitcherUiStore } from '../../store/workspaceSwitcherUiStore';
import { Button } from '../Common/Button';
import { cn } from '../Common/cn';
import { Modal } from '../Common/Modal';
import { Toggle } from '../Common/Toggle';

/**
 * The Switch Workspace dialog: the full chooser for named Workspaces. It says
 * what a Workspace is, lists the person's Workspaces with the same rows as the
 * quick switch, and can create one. An administrator can also show other
 * people's Workspaces, which stay hidden until they turn that on. Choosing a row only marks it; Switch commits, and
 * Cancel or Escape leaves everything as it was. Creating (or opening a
 * folder) keeps the dialog open until the new Workspace is current, so a
 * failure leaves the typed name in place to retry. Focus stays inside while
 * it is open and returns to whatever opened it.
 *
 * Mounted once at the router root; open it through
 * {@link useWorkspaceSwitcherUiStore} or `useOpenWorkspaceSwitcher`. Being
 * the switcher's one never-unmounting part, it also keeps the route every
 * Workspace switch acts on.
 */
export function WorkspaceSwitcherDialog() {
  useWorkspaceSwitchRoute();
  const isOpen = useWorkspaceSwitcherUiStore((s) => s.isOpen);
  const open = useWorkspaceSwitcherUiStore((s) => s.open);
  const location = useLocation();
  const navigate = useNavigate();

  // A desktop Space tab forwards its "Switch Workspace" here, to Home.
  const requested = (location.state as Record<string, unknown> | null)?.[
    OPEN_WORKSPACE_SWITCHER
  ];
  useEffect(() => {
    if (requested !== 'choose' && requested !== 'create') return;
    open(requested);
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: null,
    });
  }, [requested, open, navigate, location]);

  return isOpen ? <OpenWorkspaceSwitcherDialog /> : null;
}

function OpenWorkspaceSwitcherDialog() {
  const { t } = useTranslation();
  const intent = useWorkspaceSwitcherUiStore((s) => s.intent);
  const close = useWorkspaceSwitcherUiStore((s) => s.close);
  const everyWorkspace = useWorkspaceStore((s) => s.recentWorkspaces);
  const currentId = useWorkspaceStore((s) => s.workspaceId);
  const syncing = useWorkspaceStore((s) => s.isSyncing);
  const folders = useWorkspaceStore(
    (s) => s.capabilities?.folderWorkspaces === true,
  );
  const refreshWorkspaces = useWorkspaceStore((s) => s.refreshWorkspaces);
  const currentName = useWorkspaceLabel();
  const { busy, switchTo, create, openFolder } = useWorkspaceSwitch();
  const [selectedId, setSelectedId] = useState(currentId);
  const [renaming, setRenaming] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const firstFocus = useRef<HTMLElement | null>(null);
  const listLabel = useId();
  const [showOthers, setShowOthers] = useState(false);
  // Only an administrator has other people's Workspaces to show.
  const hasOthers = everyWorkspace.some(
    (workspace) => !isOwnWorkspace(workspace),
  );
  // The person's own first, so the current one is not buried among others'.
  const own = everyWorkspace.filter(isOwnWorkspace);
  const workspaces = showOthers
    ? [...own, ...everyWorkspace.filter((w) => !isOwnWorkspace(w))]
    : own;
  // Fade an edge of the list while rows lie beyond it, so a list that ends
  // on a whole row still reads as one that scrolls.
  const scroller = useRef<HTMLDivElement | null>(null);
  const [beyond, setBeyond] = useState({ above: false, below: false });
  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const above = element.scrollTop > 1;
    const below =
      element.scrollTop + element.clientHeight < element.scrollHeight - 1;
    setBeyond((last) =>
      last.above === above && last.below === below ? last : { above, below },
    );
  }, []);
  useEffect(() => {
    measure();
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, workspaces.length]);

  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  const selected = workspaces.find(
    (workspace) => workspace.workspaceId === selectedId,
  );
  const canSwitch =
    !!selected && selected.workspaceId !== currentId && !busy && !syncing;
  const commit = () => {
    if (!canSwitch) return;
    close();
    void switchTo(selected.workspaceId);
  };
  // Roles exist only where each person's access is decided per Workspace.
  const hasRoles = workspaces.some((workspace) => workspace.role !== undefined);

  return (
    <Modal
      isOpen
      title={t('workspace.switcher')}
      description={
        currentName
          ? t('workspace.dialogIntro', { workspace: currentName })
          : t('workspace.dialogIntroNone')
      }
      onClose={close}
      // A create in flight finishes or fails here, with its name kept.
      closeOnEscape={!renaming && !busy}
      closeOnBackdropClick={!busy}
      initialFocusRef={intent === 'create' ? nameInput : firstFocus}
      className="w-[540px] max-w-[calc(100vw-2rem)]"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={close}
            disabled={busy}
            className="shrink-0"
          >
            {t('actions.cancel')}
          </Button>
          {/* A long name is cut short here, never Cancel; the marked row and
              the button's accessible name carry it whole. */}
          <Button onClick={commit} disabled={!canSwitch} className="min-w-0">
            <span className="truncate">
              {canSwitch
                ? t('workspace.switchTo', { workspace: selected.name })
                : t('workspace.switch')}
            </span>
          </Button>
        </>
      }
    >
      <span id={listLabel} className="sr-only">
        {t('workspace.yourWorkspaces')}
      </span>
      {hasOthers && (
        <div className="text-fg-muted mt-4 flex items-center justify-end gap-2 text-xs">
          <span aria-hidden>{t('workspace.showOthers')}</span>
          <Toggle
            label={t('workspace.showOthers')}
            checked={showOthers}
            disabled={busy}
            onChange={(next) => {
              setShowOthers(next);
              // A hidden row cannot stay marked for Switch.
              if (!next && selected && !isOwnWorkspace(selected))
                setSelectedId(currentId);
            }}
          />
        </div>
      )}
      {/* Enter on a marked row switches, like the Switch button. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Enter is a shortcut for the footer's Switch button, which stays the accessible control. */}
      <div
        ref={scroller}
        onScroll={measure}
        // Leaves the rest of the dialog room, so only the list scrolls; 20rem
        // ends part-way through a row, which shows there is more.
        // `relative` keeps the rows' visually hidden radios and notes, which
        // are absolutely positioned, inside it; otherwise those of rows
        // scrolled out of view stretch the dialog's own scroll area.
        className={cn(
          'relative -mx-2 mt-4 max-h-[min(20rem,calc(100dvh-24rem))] overflow-y-auto px-2 py-0.5',
          beyond.above &&
            beyond.below &&
            '[mask-image:linear-gradient(to_bottom,transparent,black_3rem,black_calc(100%-3rem),transparent)]',
          beyond.above &&
            !beyond.below &&
            '[mask-image:linear-gradient(to_bottom,transparent,black_3rem)]',
          !beyond.above &&
            beyond.below &&
            '[mask-image:linear-gradient(to_bottom,black_calc(100%-3rem),transparent)]',
        )}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            event.target instanceof HTMLInputElement &&
            event.target.type === 'radio'
          ) {
            event.preventDefault();
            commit();
          }
        }}
      >
        <WorkspaceList
          ref={(element) => {
            firstFocus.current =
              element?.querySelector<HTMLElement>('input:checked') ??
              element?.querySelector<HTMLElement>('input') ??
              null;
          }}
          workspaces={workspaces}
          mode="select"
          selectedId={selectedId}
          onChoose={(workspace) => setSelectedId(workspace.workspaceId)}
          disabled={busy || syncing}
          density="comfortable"
          aria-labelledby={listLabel}
          onRenamingChange={setRenaming}
        />
      </div>
      <div className="border-edge-default mt-4 border-t pt-4">
        <CreateWorkspaceFields
          nameInputRef={nameInput}
          disabled={busy || syncing}
          hint={hasRoles ? t('workspace.createHint') : undefined}
          onCreate={(name) => {
            void create(name).then((created) => created && close());
          }}
          onOpenFolder={
            folders
              ? (path) => {
                  void openFolder(path).then((opened) => opened && close());
                }
              : undefined
          }
        />
      </div>
    </Modal>
  );
}
