import { Cpu, LayoutGrid, Plug, Settings2, Sparkles, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AboutSettings } from './AboutSettings';
import { AcpSettings } from './AcpSettings';
import { CanvasSettings } from './CanvasSettings';
import { GeneralSettings } from './GeneralSettings';
import { ImageProviderSettings } from './ImageProviderSettings';
import { IntegrationsSettings } from './IntegrationsSettings';
import { LLMSettings } from './LLMSettings';
import { getElectronBridge } from '../../../hooks/useElectron';
import { useAcpProfilesStore } from '../../../store/acpProfilesStore';
import { useLLMStore } from '../../../store/llmStore';

import type { LucideIcon } from 'lucide-react';

/** Identifiers for the settings tabs (left-nav order). */
type SettingsTab = 'general' | 'models' | 'capabilities' | 'agents' | 'canvas';

interface TabDef {
  id: SettingsTab;
  /** i18n key for the tab label. */
  labelKey:
    | 'settings.general'
    | 'settings.models'
    | 'settings.integrations'
    | 'settings.externalAgents'
    | 'settings.canvas';
  icon: LucideIcon;
}

const TABS: TabDef[] = [
  { id: 'general', labelKey: 'settings.general', icon: Settings2 },
  { id: 'models', labelKey: 'settings.models', icon: Cpu },
  { id: 'capabilities', labelKey: 'settings.integrations', icon: Sparkles },
  { id: 'agents', labelKey: 'settings.externalAgents', icon: Plug },
  { id: 'canvas', labelKey: 'settings.canvas', icon: LayoutGrid },
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
 *  - **General** — language (regular) + version (about)
 *  - **Models** — chat LLM provider + image generation
 *  - **Agent Capabilities** — web search / YouTube transcripts
 *  - **Canvas** — minimap etc.
 */
export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { t } = useTranslation();
  const llmInit = useLLMStore((s) => s.init);
  const acpInit = useAcpProfilesStore((s) => s.init);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  // Load LLM + ACP config lazily when the dialog opens (Models / External
  // Agents tabs). The integrations store self-initialises in its component.
  useEffect(() => {
    if (!isOpen) return;
    void llmInit();
    void acpInit();
  }, [isOpen, llmInit, acpInit]);

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const activeLabelKey =
    TABS.find((tab) => tab.id === activeTab)?.labelKey ?? 'settings.general';

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
        className="animate-in fade-in bg-bg-default/80 absolute inset-0 backdrop-blur-sm duration-200"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="animate-in fade-in zoom-in-95 border-edge-default bg-surface shadow-bottom relative flex h-[80vh] max-h-[640px] w-full max-w-3xl overflow-hidden rounded-xl border duration-200">
        {/* Left tab rail */}
        <nav className="border-edge-default bg-bg-default flex w-48 shrink-0 flex-col gap-0.5 border-r py-3 pr-3">
          <h2 className="text-fg-default mb-2 pr-2 pl-3 text-sm font-semibold">
            {t('settings.title')}
          </h2>
          {TABS.map(({ id, labelKey, icon: Icon }) => {
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
                <Icon size={15} className="shrink-0" />
                <span className="truncate">{t(labelKey)}</span>
              </button>
            );
          })}
        </nav>

        {/* Right content pane */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="border-edge-default flex shrink-0 items-center justify-between border-b px-5 py-3">
            <h3 className="text-fg-default text-sm font-semibold">
              {t(activeLabelKey)}
            </h3>
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
            {activeTab === 'general' && (
              <>
                <GeneralSettings />
                <AboutSettings />
              </>
            )}
            {activeTab === 'models' && (
              <>
                <LLMSettings />
                <ImageProviderSettings />
              </>
            )}
            {activeTab === 'capabilities' && <IntegrationsSettings />}
            {activeTab === 'agents' && <AcpSettings />}
            {activeTab === 'canvas' && <CanvasSettings />}
          </div>
        </div>
      </div>
    </div>
  );
};
