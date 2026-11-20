// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { LayoutList, Plus } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useOpenWorkspaceSwitcher } from './useOpenWorkspaceSwitcher';
import { useWorkspaceSwitch } from './useWorkspaceSwitch';
import { WorkspaceList } from './WorkspaceList';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { Button } from '../Common/Button';
import { Modal } from '../Common/Modal';
import { Popover } from '../Common/Popover';

import type { WorkspaceDescriptor } from '../../api/workspace';

/** Below Tailwind's `sm` breakpoint the quick switch is a bottom sheet. */
const PHONE_WIDTH = '(max-width: 639px)';

function subscribePhoneWidth(onChange: () => void) {
  const query = window.matchMedia(PHONE_WIDTH);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function usePhoneWidth(): boolean {
  return useSyncExternalStore(
    subscribePhoneWidth,
    () => window.matchMedia(PHONE_WIDTH).matches,
    () => false,
  );
}

interface WorkspaceSwitcherPopoverProps {
  /** The Workspace label that opened it; the popover sits below it. */
  reference: HTMLElement;
  /**
   * Close it. `restoreFocus` is true when keyboard focus should go back to
   * the label (Escape, Cancel, or handing over to the dialog), and false
   * when the person clicked elsewhere and focus is already theirs.
   */
  onClose: (restoreFocus: boolean) => void;
}

/**
 * Quick switch: the Spaces header's Workspace label opens this list of the
 * person's Workspaces. Choosing one switches at once; Escape, a click outside
 * or Cancel leaves everything as it was. Its footer hands over to the Switch
 * Workspace dialog to create a Workspace or see them all. At phone width it is
 * a bottom sheet with a Cancel button.
 */
export function WorkspaceSwitcherPopover({
  reference,
  onClose,
}: WorkspaceSwitcherPopoverProps) {
  const { t } = useTranslation();
  const phone = usePhoneWidth();
  const titleId = useId();
  const workspaces = useWorkspaceStore((s) => s.recentWorkspaces);
  const syncing = useWorkspaceStore((s) => s.isSyncing);
  const refreshWorkspaces = useWorkspaceStore((s) => s.refreshWorkspaces);
  const openSwitcher = useOpenWorkspaceSwitcher();
  const { switchTo } = useWorkspaceSwitch();
  const [renaming, setRenaming] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  // Roles, Space counts and names may have changed since the last switch.
  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  const choose = (workspace: WorkspaceDescriptor) => {
    onClose(true);
    if (!workspace.active) void switchTo(workspace.workspaceId);
  };
  const handOver = (intent: 'choose' | 'create') => {
    // Focus the label first, so the dialog gives focus back to it on close.
    onClose(true);
    openSwitcher(intent);
  };

  const body = (
    <>
      <WorkspaceList
        ref={list}
        workspaces={workspaces}
        mode="activate"
        onChoose={choose}
        disabled={syncing}
        density={phone ? 'comfortable' : 'compact'}
        aria-labelledby={titleId}
        onRenamingChange={setRenaming}
      />
      <div role="separator" className="bg-edge-default mx-0.5 my-2 h-px" />
      <div className="flex flex-col gap-0.5">
        <FooterButton
          icon={<Plus aria-hidden size={14} />}
          onClick={() => handOver('create')}
        >
          {t('workspace.newWorkspaceEllipsis')}
        </FooterButton>
        <FooterButton
          icon={<LayoutList aria-hidden size={14} />}
          onClick={() => handOver('choose')}
        >
          {t('workspace.allWorkspaces')}
        </FooterButton>
      </div>
      <p className="text-fg-subtle mx-2.5 mt-2 mb-1 text-xs leading-relaxed">
        {t('workspace.explainer')}
      </p>
    </>
  );

  if (phone) {
    return (
      <Modal
        isOpen
        title={t('workspace.switcher')}
        onClose={() => onClose(true)}
        closeOnEscape={!renaming}
        className="max-h-[85dvh] w-full max-w-none self-end rounded-t-2xl rounded-b-none px-4 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
      >
        <div
          aria-hidden
          className="bg-edge-default absolute top-1.5 left-1/2 h-1 w-9 -translate-x-1/2 rounded-full"
        />
        <div className="absolute top-2 right-2">
          <Button
            variant="ghost"
            tone="info"
            className="min-h-11"
            onClick={() => onClose(true)}
          >
            {t('actions.cancel')}
          </Button>
        </div>
        <span id={titleId} className="sr-only">
          {t('workspace.yourWorkspaces')}
        </span>
        {body}
      </Modal>
    );
  }

  return (
    <Popover
      reference={reference}
      placement="bottom-start"
      role="dialog"
      aria-labelledby={titleId}
      dismissOnEscape={!renaming}
      onDismiss={(reason) => onClose(reason === 'escape')}
      className="w-[340px] p-2"
      onOpenAutoFocus={() => {
        const rows = list.current?.querySelectorAll<HTMLElement>('button');
        const current = list.current?.querySelector<HTMLElement>(
          'button[aria-current="true"]',
        );
        (current ?? rows?.[0])?.focus();
      }}
    >
      <div
        id={titleId}
        className="text-fg-subtle px-2.5 pt-1.5 pb-1 text-xs font-semibold"
      >
        {t('workspace.switcher')}
      </div>
      {body}
    </Popover>
  );
}

function FooterButton({
  icon,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-fg-default hover:bg-hover focus-visible:ring-info flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-sm focus-visible:ring-2 focus-visible:outline-none"
    >
      <span className="border-edge-default text-fg-muted flex size-7 shrink-0 items-center justify-center rounded-lg border border-dashed">
        {icon}
      </span>
      {children}
    </button>
  );
}

/**
 * The Workspace label as the quick switch's trigger. `children` is its face
 * (the name, an icon, a chevron); the host styles it to fit its header.
 */
export function WorkspaceSwitcherButton({
  label,
  className,
  style,
  children,
}: {
  /** The current Workspace's name, for the button's accessible name. */
  label: string;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('workspace.switcherButton', { workspace: label })}
        onClick={() => setOpen((current) => !current)}
        className={className}
        style={style}
      >
        {children}
      </button>
      {open && trigger.current && (
        <WorkspaceSwitcherPopover
          reference={trigger.current}
          onClose={(restoreFocus) => {
            setOpen(false);
            if (restoreFocus) trigger.current?.focus();
          }}
        />
      )}
    </>
  );
}
