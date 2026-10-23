// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ArrowLeft, X } from 'lucide-react';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { SettingSection } from '@/components/Settings/Common/SettingSection';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import { useDeploymentReadinessStore } from '@/store/deploymentReadinessStore';
import { useLLMStore } from '@/store/llmStore';
import {
  useSettingsUiStore,
  type SettingsTabId,
} from '@/store/settingsUiStore';

import { AgentDefaultsSettings } from './agent-profiles/AgentDefaultsSettings';
import {
  ExternalAgentsSettings,
  type ExternalAgentsNavigation,
} from './agent-profiles/ExternalAgentsSettings';
import { DeploymentReadinessNotice } from './DeploymentReadinessNotice';
import { AgentBehaviorSettings } from './sections/AgentBehaviorSettings';
import { ExternalAgentRuntimeSettings } from './sections/ExternalAgentRuntimeSettings';
import { GeneralSettings } from './sections/GeneralSettings';
import { LLMSettings } from './sections/LLMSettings';
import { ServicesSettings } from './sections/ServicesSettings';

/** Identifiers for the settings tabs (left-nav order). */
type SettingsTab = SettingsTabId;

interface TabDef {
  id: SettingsTab;
  /** i18n key for the tab label. */
  labelKey: 'settings.general' | 'settings.agent' | 'settings.services';
}

const TABS: TabDef[] = [
  { id: 'agent', labelKey: 'settings.agent' },
  { id: 'services', labelKey: 'settings.services' },
  { id: 'general', labelKey: 'settings.general' },
];

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Tabbed settings dialog with a desktop rail, compact top navigation in
 * narrow windows, and an independently scrollable content pane.
 *
 * Each tab renders its owned Settings surface:
 *  - **Agent** — Utility Agent, Built-In Pi setup, external Profiles, and behavior
 *  - **Services** — manifest-driven image, search, transcript, and OCR providers
 *  - **General** — application, canvas, input, and update preferences
 *
 * The app version stays in navigation, independent of the active page.
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
  const isAgentTab = activeTab === 'agent' || activeTab === 'builtIn';
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
    if (!isOpen && activeTab === 'builtIn') setActiveTab('agent');
  }, [isOpen, activeTab]);

  useEffect(() => {
    if (!isOpen) return;
    void loadDeploymentReadiness();
  }, [isOpen, loadDeploymentReadiness]);

  // Load each registry only when its owning tab is visible.
  useEffect(() => {
    if (!isOpen) return;
    const targetTab = requestedTab ?? activeTab;
    if (targetTab === 'agent') void acpInit();
    if (targetTab === 'builtIn') {
      void llmInit();
    }
  }, [isOpen, requestedTab, activeTab, llmInit, acpInit]);

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => {
      if (!dialogRef.current?.contains(document.activeElement)) {
        contentHeadingRef.current?.focus();
      }
    }, 0);
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

  useEffect(() => {
    if (isOpen) contentHeadingRef.current?.focus();
  }, [isOpen, activeTab]);

  useEffect(() => {
    if (externalAgentsNavigation) contentHeadingRef.current?.focus();
  }, [externalAgentsNavigation]);

  if (!isOpen) return null;

  const activeLabelKey =
    TABS.find((tab) => tab.id === activeTab)?.labelKey ?? 'settings.general';
  const contentTitle =
    activeTab === 'agent' && externalAgentsNavigation
      ? externalAgentsNavigation.title
      : activeTab === 'builtIn'
        ? t('settings.builtInPi')
        : t(activeLabelKey);

  return (
    <div className="fixed inset-0 top-[var(--window-chrome-height,0px)] z-50 flex items-center justify-center p-3 sm:p-6">
      {/* Backdrop */}
      {/* Backdrop: a soft, token-based frosted scrim (theme-aware) rather
          than a flat dark wash, so it harmonises with the bright title
          bar (when visible) and the white dialog panel. */}
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
        className="animate-in fade-in zoom-in-95 border-edge-default bg-surface shadow-bottom relative flex h-[80dvh] max-h-160 w-full max-w-3xl flex-col overflow-hidden rounded-xl border duration-200 focus:outline-none sm:flex-row"
      >
        {/* Left tab rail */}
        <nav
          aria-labelledby={titleId}
          className="border-edge-default bg-sidebar grid w-full shrink-0 grid-cols-3 gap-0.5 border-b px-3 py-3 sm:flex sm:w-48 sm:flex-col sm:border-r sm:border-b-0"
        >
          <h2
            id={titleId}
            className="text-fg-default col-span-2 row-start-1 mb-2 flex h-7 shrink-0 items-center px-2 text-sm font-semibold"
          >
            {t('settings.title')}
          </h2>
          {TABS.map(({ id, labelKey }) => {
            const active =
              id === activeTab || (id === 'agent' && activeTab === 'builtIn');
            return (
              <Button
                key={id}
                variant="ghost"
                tone="neutral"
                size="md"
                onClick={() => setActiveTab(id)}
                aria-current={active ? 'page' : undefined}
                className={`focus-visible:outline-info min-h-8 w-full justify-center gap-2 rounded-md px-2 py-0 text-center text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 sm:justify-start sm:text-left ${
                  active
                    ? 'bg-sidebar-selected text-fg-default enabled:hover:bg-sidebar-selected font-medium'
                    : 'text-fg-muted enabled:hover:text-fg-default font-normal'
                }`}
              >
                <span className="truncate">{t(labelKey)}</span>
              </Button>
            );
          })}

          {/*
           * App version in the desktop rail footer or mobile title row: a product-wide
           * fact, not a General-tab setting, so it lives here (decoupled
           * from any tab) as a muted signature rather than mixed in with
           * editable preferences. `__APP_VERSION__` is inlined at build
           * time from `apps/desktop/package.json` (see vite.config.ts).
           */}
          <span className="text-fg-muted col-start-3 row-start-1 mb-2 self-center justify-self-end px-2 font-mono text-[11px] select-text sm:mt-auto sm:mb-0 sm:self-auto sm:pt-4">
            v{__APP_VERSION__}
          </span>
        </nav>

        {/* Right content pane */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-[52px] shrink-0 items-center justify-between px-4 py-3 sm:px-5">
            <div className="flex min-w-0 items-center gap-1.5">
              {(activeTab === 'builtIn' ||
                (activeTab === 'agent' && externalAgentsNavigation)) && (
                <Button
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                  iconOnly
                  title={t('settings.backToAgents')}
                  onClick={
                    activeTab === 'builtIn'
                      ? () => setActiveTab('agent')
                      : externalAgentsNavigation?.onBack
                  }
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
            <Button
              variant="ghost"
              tone="neutral"
              size="md"
              iconOnly
              onClick={onClose}
              className="text-fg-subtle enabled:hover:text-fg-default focus-visible:outline-info h-7 w-7 shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2"
              aria-label={t('actions.close')}
            >
              <X size={16} />
            </Button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-0 pb-4 sm:px-5">
            <DeploymentReadinessNotice />
            {activeTab === 'general' && (
              <SettingSection>
                <GeneralSettings />
              </SettingSection>
            )}
            {isAgentTab &&
              (activeTab === 'builtIn' ? (
                <LLMSettings />
              ) : (
                <>
                  <div className="mb-4">
                    <ExternalAgentsSettings
                      onNavigationChange={handleExternalAgentsNavigationChange}
                    />
                  </div>
                  {externalAgentsNavigation ? null : <AgentDefaultsSettings />}
                  {externalAgentsNavigation ? null : (
                    <>
                      <SettingSection
                        title={t('settings.agentBehavior')}
                        collapsible
                        defaultCollapsed
                        keepMounted
                      >
                        <AgentBehaviorSettings />
                      </SettingSection>
                      <SettingSection
                        title={t('settings.externalAgentRuntime')}
                        collapsible
                        defaultCollapsed
                        keepMounted
                      >
                        <ExternalAgentRuntimeSettings />
                      </SettingSection>
                      <SettingSection
                        title={t('settings.builtInPi')}
                        collapsible
                        defaultCollapsed
                        keepMounted
                      >
                        <SettingRow
                          title={t('settings.builtInPiConfiguration')}
                          description={t('settings.builtInPiChatSetup')}
                        >
                          <Button
                            variant="outline"
                            size="field"
                            aria-label={t('settings.builtInPiConfigure')}
                            onClick={() => setActiveTab('builtIn')}
                          >
                            {t('settings.configure')}
                          </Button>
                        </SettingRow>
                      </SettingSection>
                    </>
                  )}
                </>
              ))}
            {activeTab === 'services' && (
              <>
                <p className="text-fg-muted mb-4 px-1 text-xs">
                  {t('settings.servicesDescription')}
                </p>
                <div
                  className="flex flex-col gap-3 [&_section]:mb-0"
                  data-testid="service-sections"
                >
                  <ServicesSettings />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
