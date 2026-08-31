import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { HUABU_REQUIRED_RESOURCE_IDS, type AgentResource } from '@huabu/shared';

import { listAcpResources } from '@/api/acp';
import { SettingControl } from '@/components/Settings/Common/SettingControl';
import { SettingRow } from '@/components/Settings/Common/SettingRow';

const REQUIRED_RESOURCE_IDS: ReadonlySet<string> = new Set(
  HUABU_REQUIRED_RESOURCE_IDS,
);

interface ProfileResourceFieldProps {
  selectedIds: string[];
  onChange: (resourceIds: string[]) => void;
  disabled?: boolean;
}

export function ProfileResourceField({
  selectedIds,
  onChange,
  disabled = false,
}: ProfileResourceFieldProps) {
  const { t } = useTranslation();
  const [resources, setResources] = useState<AgentResource[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void listAcpResources()
      .then((response) => {
        if (!active) return;
        setResources(response.resources);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(
          cause instanceof Error
            ? cause.message
            : t('settings.resourcesLoadFailed'),
        );
      });
    return () => {
      active = false;
    };
  }, [t]);

  const rows = useMemo(() => {
    const knownIds = new Set(resources.map(({ id }) => id));
    return [
      ...resources,
      ...selectedIds
        .filter((id) => !knownIds.has(id))
        .map((id) => ({
          schemaVersion: 1 as const,
          id,
          name: id,
          provider: '',
          description: t('settings.resourceUnavailable'),
          instructions: '',
        })),
    ];
  }, [resources, selectedIds, t]);

  const selected = new Set(selectedIds);
  return (
    <SettingRow
      title={t('settings.resources')}
      description={t('settings.resourcesHint')}
    >
      <SettingControl>
        <div className="border-edge-default bg-surface flex flex-col rounded border">
          {error ? (
            <p className="text-warning px-2 py-1.5 text-xs" role="status">
              {error}
            </p>
          ) : null}
          {rows.map((resource) => {
            const required = REQUIRED_RESOURCE_IDS.has(resource.id);
            const checked = required || selected.has(resource.id);
            const inputId = `profile-resource-${resource.id}`;
            return (
              <label
                key={resource.id}
                htmlFor={inputId}
                className="border-edge-default flex gap-2 border-b px-2 py-1.5 last:border-b-0"
              >
                <span className="sr-only">{resource.name}</span>
                <input
                  id={inputId}
                  type="checkbox"
                  className="accent-info mt-0.5 h-3.5 w-3.5"
                  checked={checked}
                  disabled={disabled || required || !resource.provider}
                  onChange={(event) => {
                    onChange(
                      event.target.checked
                        ? [...selectedIds, resource.id]
                        : selectedIds.filter((id) => id !== resource.id),
                    );
                  }}
                />
                <span className="min-w-0" aria-hidden="true">
                  <span className="text-fg-default block text-xs">
                    {resource.name}
                    {required ? ` · ${t('settings.resourceRequired')}` : ''}
                  </span>
                  <span className="text-fg-subtle block text-[11px]">
                    {resource.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </SettingControl>
    </SettingRow>
  );
}
