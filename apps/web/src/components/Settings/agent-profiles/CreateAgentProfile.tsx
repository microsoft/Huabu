// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ChevronRight, LoaderCircle, Terminal } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { SettingSection } from '@/components/Settings/Common/SettingSection';

import { CommandProfileForm } from './CommandProfileForm';

import type { AcpAgentCliInfo, ConnectedAgentletDevice } from '@huabu/shared';

export function CreateAgentProfile({
  detectedClis,
  detectionLoaded,
  detectionError,
  onRecheck,
  connectedDevices,
  agentletId,
  onClose,
  onSaved,
}: {
  detectedClis: AcpAgentCliInfo[];
  detectionLoaded: boolean;
  detectionError?: string | null;
  onRecheck?: () => void;
  connectedDevices: ConnectedAgentletDevice[];
  agentletId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState('');
  const [choosing, setChoosing] = useState(true);
  const [visited, setVisited] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const changeRef = useRef<HTMLButtonElement>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  const device = connectedDevices.find(
    (device) => device.agentletId === agentletId,
  );
  const options = [
    ...detectedClis.filter((cli) => cli.id !== 'custom'),
    {
      id: 'custom',
      displayName: t('settings.customCommand'),
      status: 'ready' as const,
    },
  ];
  const select = (id: string) => {
    setSelected(id);
    setVisited((previous) =>
      previous.includes(id) ? previous : [...previous, id],
    );
    setChoosing(false);
    requestAnimationFrame(() => changeRef.current?.focus());
  };
  return (
    <>
      <SettingSection>
        <SettingRow title={t('settings.profileMachine')}>
          <span className="text-sm [overflow-wrap:anywhere]">
            {device?.displayName ?? agentletId}
          </span>
        </SettingRow>
      </SettingSection>
      <h4 className="text-fg-default mt-5 mb-2 text-[13px] font-medium">
        {t('settings.chooseAgent')}
      </h4>
      <div className="border-edge-default overflow-hidden rounded-lg border">
        {choosing ? (
          <div ref={selectionRef} aria-label={t('settings.chooseAgent')}>
            {!detectionLoaded && (
              <p
                role="status"
                className="text-fg-muted flex items-center gap-2 px-3.5 py-3 text-xs"
              >
                <LoaderCircle
                  size={14}
                  className="motion-safe:animate-spin"
                  aria-hidden
                />
                {t('settings.detectingClis')}
              </p>
            )}
            {detectionError && (
              <div className="px-3.5 py-3">
                <p role="alert" className="text-danger text-xs">
                  {detectionError}
                </p>
                <Button variant="outline" size="sm" onClick={onRecheck}>
                  {t('settings.recheckAgent')}
                </Button>
              </div>
            )}
            {options.map((cli) => {
              const lookupFailed =
                'diagnostics' in cli &&
                cli.diagnostics?.some(
                  (diagnostic) => diagnostic.code === 'lookup_failed',
                );
              const status =
                cli.id === 'custom'
                  ? ''
                  : t(
                      lookupFailed
                        ? 'settings.agentCheckFailed'
                        : cli.status === 'ready'
                          ? 'settings.agentConfigurable'
                          : cli.status === 'adapter-missing'
                            ? 'settings.agentAdapterRequired'
                            : 'settings.agentNotDetected',
                    );
              const statusColor =
                lookupFailed || cli.status === 'adapter-missing'
                  ? 'text-fg-default'
                  : cli.status === 'ready'
                    ? 'text-success'
                    : 'text-fg-muted';
              return (
                <div
                  key={cli.id}
                  className="border-edge-default border-b last:border-b-0"
                >
                  <Button
                    variant="ghost"
                    size="field"
                    className="text-fg-default aria-pressed:bg-hover focus-visible:outline-info h-auto min-h-10.5 w-full justify-start gap-2 rounded-none px-3.5 py-2 text-left font-normal focus-visible:outline-2 focus-visible:-outline-offset-2"
                    aria-pressed={selected === cli.id}
                    onClick={() => select(cli.id)}
                  >
                    {cli.id === 'custom' && <Terminal aria-hidden />}
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {cli.displayName}
                    </span>
                    <span className="ml-auto flex max-w-[55%] shrink-0 items-center gap-2.5">
                      {status && (
                        <span className={`${statusColor} text-right text-xs`}>
                          {status}
                        </span>
                      )}
                      <ChevronRight className="text-fg-muted" aria-hidden />
                    </span>
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex min-h-10.5 items-center gap-2 px-3.5 py-2">
            {selected === 'custom' && <Terminal size={16} aria-hidden />}
            <span className="text-[13px] font-medium">
              {options.find((cli) => cli.id === selected)?.displayName ??
                selected}
            </span>
            <Button
              ref={changeRef}
              variant="ghost"
              size="sm"
              className="ml-auto"
              disabled={busy}
              onClick={() => {
                setChoosing(true);
                requestAnimationFrame(() => {
                  const current =
                    selectionRef.current?.querySelector<HTMLButtonElement>(
                      '[aria-pressed="true"]',
                    );
                  current?.focus();
                  current?.scrollIntoView({ block: 'nearest' });
                });
              }}
            >
              {t('settings.changeAgent')}
            </Button>
          </div>
        )}
        {visited.map((id) => (
          <div key={id} hidden={choosing || selected !== id}>
            <CommandProfileForm
              editing={null}
              initialCliId={id}
              embedded
              active={!choosing && selected === id}
              detectedClis={detectedClis}
              detectionLoaded={detectionLoaded}
              detectionError={detectionError}
              onRecheck={onRecheck}
              onBusyChange={setBusy}
              connectedDevices={connectedDevices}
              agentletId={agentletId}
              onClose={onClose}
              onSaved={onSaved}
            />
          </div>
        ))}
      </div>
      {!device && (
        <p role="alert" className="text-danger mt-2 text-xs">
          {t('settings.deviceDetectionDisconnected')}
        </p>
      )}
    </>
  );
}
