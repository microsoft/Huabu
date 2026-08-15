// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ArrowLeft, X } from 'lucide-react';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { SettingSection } from '@/components/Settings/Common/SettingSection';
import { getElectronBridge } from '@/hooks/useElectron';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import { useDeploymentReadinessStore } from '@/store/deploymentReadinessStore';
import { useLLMStore } from '@/store/llmStore';
import { useSettingsUiStore } from '@/store/settingsUiStore';

import {
  ExternalAgentsSettings,
  type ExternalAgentsNavigation,
} from './agent-team/ExternalAgentsSettings';
import { DeploymentReadinessNotice } from './DeploymentReadinessNotice';
import { GeneralSettings } from './sections/GeneralSettings';
import { ImageProviderSettings } from './sections/ImageProviderSettings';
import { IntegrationsSettings } from './sections/IntegrationsSettings';
import { LLMSettings } from './sections/LLMSettings';

/** Identifiers for the settings tabs (left-nav order). */
type SettingsTab = 'general' | 'huabuAgent' | 'agents';

interface TabDef {
  id: SettingsTab;
  /** i18n key for the tab label. */
  labelKey:
    | 'settings.general'
    | 'settings.huabuAgent'
    | 'settings.externalAgents';
}

const TABS: TabDef[] = [
  { id: 'huabuAgent', labelKey: 'settings.huabuAgent' },
  { id: 'agents', labelKey: 'settings.externalAgents' },
  { id: 'general', labelKey: 'settings.general' },
];

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Tabbed settings dialog. A centered modal (same overlay pattern as
 * `ShortcutsModal`) with a left-hand tab rail and a scrollable content
 * pane, so the panel height stays fixed as more settings are added.
 *
 * Each tab renders the existing self-contained `*Settings` components:
 *  - **General** — language and canvas display preferences
 *  - **Huabu Agent** — chat LLM (required) + optional capabilities
 *    (image generation, web search, YouTube transcripts)
 *  - **External Agents** — ACP profile management
 *
 * The app version sits at the bottom of the left tab rail (a product-wide
 * fact, decoupled from any single tab).
 */
export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { t } = useTranslation();
  const llmInit = useLLMStore((s) => s.init);
  const acpInit = useAcpProfilesStore((s) => s.init);
  const loadDeploymentReadiness = useDeploymentReadinessStore((s) => s.load);
  const requestedTab = useSettingsUiStore((s) => s.requestedTab);
  const clearRequestedTab = useSettingsUiStore((s) => s.clearRequestedTab);
  const [activeTab, setActiveTab] = useState<SettingsTab>(TABS[0].id);
  const [externalAgentsNavigation, setExternalAgentsNavigation] =
    useState<ExternalAgentsNavigation | null>(null);
  const titleId = useId();
  const contentHeadingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const handleExternalAgentsNavigationChange = useCallback(
    (navigation: ExternalAgentsNavigation | null) => {
      setExternalAgentsNavigation(navigation);
    },
    [],
  );

  useEffect(() => {
    if (externalAgentsNavigation) contentHeadingRef.current?.focus();
  }, [externalAgentsNavigation]);

  // Deep-link support: a caller (e.g. the chat "Add agent" row) can ask
  // to open Settings on a specific tab via `settingsUiStore.open(tab)`.
  // Apply it once per open, then clear it so a later plain open() keeps
  // the tab the user last viewed.
  useEffect(() => {
    if (isOpen && requestedTab) {
      setActiveTab(requestedTab);
      clearRequestedTab();
    }
  }, [isOpen, requestedTab, clearRequestedTab]);

  useEffect(() => {
    if (!isOpen) return;
    void loadDeploymentReadiness();
  }, [isOpen, loadDeploymentReadiness]);

  // Load each registry only when its owning tab is visible.
  useEffect(() => {
    if (!isOpen) return;
    if (activeTab === 'huabuAgent') void llmInit();
    if (activeTab === 'agents') void acpInit();
  }, [isOpen, activeTab, llmInit, acpInit]);

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => dialogRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const openDialogs = document.querySelectorAll(
        '[role="dialog"][aria-modal="true"]',
      );
      if (openDialogs.length === 1) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKey);
      previouslyFocusedRef.current?.focus();
      previouslyFocusedRef.current = null;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const activeLabelKey =
    TABS.find((tab) => tab.id === activeTab)?.labelKey ?? 'settings.general';
  const contentTitle =
    activeTab === 'agents' && externalAgentsNavigation
      ? externalAgentsNavigation.title
      : t(activeLabelKey);

  // In the Electron shell keep the custom title bar (`WindowChrome`)
  // fully visible above the modal: offset the overlay below the
  // title-bar strip so the backdrop never covers it. Otherwise the OS
  // caption-button overlay stays opaque while the HTML chrome is dimmed,
  // leaving a visibly half-covered, "incomplete" header.
  const titleBarInset = getElectronBridge()?.titleBarHeight ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={titleBarInset ? { top: titleBarInset } : undefined}
    >
      {/* Backdrop */}
      {/* Backdrop: a soft, token-based frosted scrim (theme-aware) rather
          than a flat dark wash, so it harmonises with the bright title
          bar left uncovered above and the white dialog panel. */}
      <div
        role="presentation"
        className="animate-in fade-in bg-bg-default/80 absolute inset-0 backdrop-blur-sm duration-200"
        onClick={onClose}
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="animate-in fade-in zoom-in-95 border-edge-default bg-surface shadow-bottom relative flex h-[80vh] max-h-160 w-full max-w-3xl overflow-hidden rounded-xl border duration-200 focus:outline-none"
      >
        {/* Left tab rail */}
        <nav className="border-edge-default bg-bg-default flex w-48 shrink-0 flex-col gap-0.5 border-r py-3 pr-3">
          <h2
            id={titleId}
            className="text-fg-default mb-2 pr-2 pl-3 text-sm font-semibold"
          >
            {t('settings.title')}
          </h2>
          {TABS.map(({ id, labelKey }) => {
            const active = id === activeTab;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2 border-l-2 py-1.5 pr-2 pl-3 text-left text-xs transition-colors ${
                  active
                    ? 'border-info text-fg-default font-medium'
                    : 'text-fg-muted hover:text-fg-default border-transparent'
                }`}
              >
                <span className="truncate">{t(labelKey)}</span>
              </button>
            );
          })}

          {/*
           * App version pinned to the bottom of the rail: a product-wide
           * fact, not a General-tab setting, so it lives here (decoupled
           * from any tab) as a muted signature rather than mixed in with
           * editable preferences. `__APP_VERSION__` is inlined at build
           * time from `apps/desktop/package.json` (see vite.config.ts).
           */}
          <span className="text-fg-subtle mt-auto px-3 pt-2 font-mono text-[11px] select-text">
            v{__APP_VERSION__}
          </span>
        </nav>

        {/* Right content pane */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="border-edge-default flex shrink-0 items-center justify-between border-b px-5 py-3">
            <div className="flex min-w-0 items-center gap-1.5">
              {activeTab === 'agents' && externalAgentsNavigation && (
                <Button
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                  iconOnly
                  title={t('settings.backToAgents')}
                  onClick={externalAgentsNavigation.onBack}
                >
                  <ArrowLeft />
                </Button>
              )}
              <h3
                ref={contentHeadingRef}
                tabIndex={-1}
                className="text-fg-default truncate text-sm font-semibold outline-none"
              >
                {contentTitle}
              </h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-fg-muted hover:bg-hover hover:text-fg-default rounded-md p-1 transition-colors"
              aria-label={t('actions.close')}
            >
              <X size={18} />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <DeploymentReadinessNotice />
            {activeTab === 'general' && (
              <SettingSection>
                <GeneralSettings />
              </SettingSection>
            )}
            {activeTab === 'huabuAgent' && (
              <>
                <LLMSettings />
                <ImageProviderSettings />
                <IntegrationsSettings />
              </>
            )}
            {activeTab === 'agents' && (
              <ExternalAgentsSettings
                onNavigationChange={handleExternalAgentsNavigationChange}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
