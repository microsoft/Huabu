// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Download, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  deleteAcpResource,
  importAcpResource,
  listAcpResources,
  refreshAcpResource,
  scanAcpResourceRefresh,
  scanAcpResources,
  updateAcpResource,
} from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { Modal } from '@/components/Common/Modal';
import { TextArea } from '@/components/Common/TextArea';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import { SettingSection } from '@/components/Settings/Common/SettingSection';

import type {
  AgentResource,
  AgentResourceImportCandidate,
} from '@huabu/shared';

interface CandidateCustomization {
  displayName: string;
  userContent: string;
}

interface ResourceEditorProps {
  resource: AgentResource;
  manageable: boolean;
  onChanged: (resource: AgentResource) => void;
  onDeleted: (id: string) => void;
}

function ResourceEditor({
  resource,
  manageable,
  onChanged,
  onDeleted,
}: ResourceEditorProps) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(resource.displayName ?? '');
  const [userContent, setUserContent] = useState(resource.userContent);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshCandidate, setRefreshCandidate] =
    useState<AgentResourceImportCandidate | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setDisplayName(resource.displayName ?? '');
    setUserContent(resource.userContent);
  }, [resource]);

  const save = async () => {
    setSaving(true);
    try {
      const result = await updateAcpResource(resource.id, {
        displayName: displayName.trim() || null,
        userContent,
      });
      onChanged(result.resource);
      toast(t('settings.resourceSaved'), { tone: 'success' });
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : t('settings.resourceSaveFailed'),
        {
          tone: 'danger',
        },
      );
    } finally {
      setSaving(false);
    }
  };

  const scanRefresh = async () => {
    setRefreshing(true);
    try {
      const result = await scanAcpResourceRefresh(resource.id);
      setRefreshCandidate(result.candidates[0] ?? null);
      if (!result.candidates.length) {
        toast(t('settings.resourceRefreshNotFound'), { tone: 'warning' });
      }
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : t('settings.resourceRefreshFailed'),
        { tone: 'danger' },
      );
    } finally {
      setRefreshing(false);
    }
  };

  const applyRefresh = async () => {
    if (!refreshCandidate) return;
    setRefreshing(true);
    try {
      const result = await refreshAcpResource(
        resource.id,
        refreshCandidate.sourceRevision,
      );
      onChanged(result.resource);
      setRefreshCandidate(null);
      toast(t('settings.resourceRefreshed'), { tone: 'success' });
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : t('settings.resourceRefreshFailed'),
        { tone: 'danger' },
      );
    } finally {
      setRefreshing(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await deleteAcpResource(resource.id);
      setConfirmDelete(false);
      onDeleted(resource.id);
      toast(t('settings.resourceDeleted'), { tone: 'success' });
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : t('settings.resourceDeleteFailed'),
        { tone: 'danger' },
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="border-edge-default bg-surface space-y-3 rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-fg-default truncate text-sm font-medium">
            {resource.displayName ?? resource.name}
          </h4>
          <p className="text-fg-subtle text-[11px]">
            {resource.name} · {resource.id} · {resource.provider}
          </p>
        </div>
        {manageable ? (
          <div className="flex shrink-0 gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing || saving}
              onClick={() => void scanRefresh()}
            >
              <RefreshCw />
              {t('settings.refreshFromSource')}
            </Button>
            <Button
              variant="ghost"
              tone="danger"
              size="sm"
              iconOnly
              title={t('actions.delete')}
              disabled={saving}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 />
            </Button>
          </div>
        ) : null}
      </div>

      <details>
        <summary className="text-fg-muted cursor-pointer text-xs">
          {t('settings.importedContent')}
        </summary>
        <pre className="border-edge-default bg-bg-default text-fg-muted mt-2 max-h-48 overflow-auto rounded border p-2 text-[11px] whitespace-pre-wrap">
          {resource.sourceContent}
        </pre>
      </details>

      <label className="block space-y-1">
        <span className="text-fg-muted text-xs">
          {t('settings.resourceDisplayName')}
        </span>
        <TextInput
          className="w-full"
          value={displayName}
          placeholder={resource.name}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-fg-muted text-xs">
          {t('settings.resourceUserContent')}
        </span>
        <TextArea
          className="w-full"
          value={userContent}
          placeholder={t('settings.resourceUserContentPlaceholder')}
          onChange={(event) => setUserContent(event.target.value)}
        />
      </label>
      <div className="flex justify-end">
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? t('settings.saving') : t('actions.save')}
        </Button>
      </div>

      {refreshCandidate ? (
        <div className="border-info bg-info-bg space-y-2 rounded-md border p-2">
          <p className="text-info text-xs font-medium">
            {t('settings.resourceRefreshPreview')}
          </p>
          <pre className="border-edge-default bg-surface text-fg-muted max-h-40 overflow-auto rounded border p-2 text-[11px] whitespace-pre-wrap">
            {refreshCandidate.sourceContent}
          </pre>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRefreshCandidate(null)}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={refreshing}
              onClick={() => void applyRefresh()}
            >
              {t('settings.applyRefresh')}
            </Button>
          </div>
        </div>
      ) : null}

      <Modal
        isOpen={confirmDelete}
        title={t('settings.deleteResourceTitle')}
        description={t('settings.deleteResourceDescription', {
          name: resource.displayName ?? resource.name,
        })}
        onClose={() => setConfirmDelete(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(false)}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              tone="danger"
              size="sm"
              disabled={saving}
              onClick={() => void remove()}
            >
              {t('actions.delete')}
            </Button>
          </div>
        }
      />
    </article>
  );
}

export function AgentResourcesSettings() {
  const { t } = useTranslation();
  const [resources, setResources] = useState<AgentResource[]>([]);
  const [manageableResourceIds, setManageableResourceIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const [rootPath, setRootPath] = useState('');
  const [candidates, setCandidates] = useState<AgentResourceImportCandidate[]>(
    [],
  );
  const [customizations, setCustomizations] = useState<
    Record<string, CandidateCustomization>
  >({});
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listAcpResources();
      setResources(result.resources);
      setManageableResourceIds(new Set(result.manageableResourceIds ?? []));
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : t('settings.resourcesLoadFailed'),
        { tone: 'danger' },
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const scan = async () => {
    setScanning(true);
    try {
      const result = await scanAcpResources({ rootPath });
      setCandidates(result.candidates);
      setCustomizations(
        Object.fromEntries(
          result.candidates.map((candidate) => [
            candidate.sourcePath,
            { displayName: '', userContent: '' },
          ]),
        ),
      );
      if (!result.candidates.length) {
        toast(t('settings.noSkillsFound'), { tone: 'warning' });
      }
      if (result.diagnostics.length) {
        toast(
          t('settings.skillScanDiagnostics', {
            count: result.diagnostics.length,
          }),
          { tone: 'warning' },
        );
      }
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t('settings.skillScanFailed'),
        {
          tone: 'danger',
        },
      );
    } finally {
      setScanning(false);
    }
  };

  const importCandidate = async (candidate: AgentResourceImportCandidate) => {
    setImportingId(candidate.sourcePath);
    try {
      const customization = customizations[candidate.sourcePath] ?? {
        displayName: '',
        userContent: '',
      };
      const result = await importAcpResource({
        id: candidate.id,
        sourcePath: candidate.sourcePath,
        expectedRevision: candidate.sourceRevision,
        ...(customization.displayName.trim()
          ? { displayName: customization.displayName }
          : {}),
        userContent: customization.userContent,
      });
      setResources((current) =>
        [...current, result.resource].sort((a, b) => a.id.localeCompare(b.id)),
      );
      setCandidates((current) =>
        current.filter((item) => item.sourcePath !== candidate.sourcePath),
      );
      toast(t('settings.resourceImported'), { tone: 'success' });
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : t('settings.resourceImportFailed'),
        {
          tone: 'danger',
        },
      );
    } finally {
      setImportingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <SettingSection title={t('settings.importSkills')}>
        <div className="space-y-3 p-3">
          <p className="text-fg-subtle text-xs">
            {t('settings.importSkillsDescription')}
          </p>
          <div className="flex gap-2">
            <TextInput
              mono
              className="min-w-0 flex-1"
              value={rootPath}
              placeholder={t('settings.skillFolderPlaceholder')}
              onChange={(event) => setRootPath(event.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!rootPath.trim() || scanning}
              onClick={() => void scan()}
            >
              <Search />
              {scanning ? t('settings.scanning') : t('settings.scanFolder')}
            </Button>
          </div>

          {candidates.map((candidate) => {
            const customization = customizations[candidate.sourcePath] ?? {
              displayName: '',
              userContent: '',
            };
            return (
              <div
                key={candidate.sourcePath}
                className="border-edge-default space-y-2 rounded-md border p-2"
              >
                <div>
                  <p className="text-fg-default text-xs font-medium">
                    {candidate.name}
                  </p>
                  <p className="text-fg-subtle truncate font-mono text-[11px]">
                    {candidate.sourcePath}
                  </p>
                </div>
                <TextInput
                  className="w-full"
                  value={customization.displayName}
                  placeholder={t('settings.resourceDisplayNameOptional')}
                  onChange={(event) =>
                    setCustomizations((current) => ({
                      ...current,
                      [candidate.sourcePath]: {
                        ...customization,
                        displayName: event.target.value,
                      },
                    }))
                  }
                />
                <TextArea
                  className="w-full"
                  value={customization.userContent}
                  placeholder={t('settings.resourceUserContentPlaceholder')}
                  onChange={(event) =>
                    setCustomizations((current) => ({
                      ...current,
                      [candidate.sourcePath]: {
                        ...customization,
                        userContent: event.target.value,
                      },
                    }))
                  }
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={importingId === candidate.sourcePath}
                    onClick={() => void importCandidate(candidate)}
                  >
                    <Download />
                    {t('actions.import')}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </SettingSection>

      <SettingSection title={t('settings.managedResources')}>
        <div className="space-y-3 p-3">
          {loading ? (
            <p className="text-fg-subtle text-xs">
              {t('settings.loadingResources')}
            </p>
          ) : resources.length ? (
            resources.map((resource) => (
              <ResourceEditor
                key={resource.id}
                resource={resource}
                manageable={manageableResourceIds.has(resource.id)}
                onChanged={(changed) =>
                  setResources((current) =>
                    current.map((item) =>
                      item.id === changed.id ? changed : item,
                    ),
                  )
                }
                onDeleted={(id) =>
                  setResources((current) =>
                    current.filter((item) => item.id !== id),
                  )
                }
              />
            ))
          ) : (
            <p className="text-fg-subtle text-xs">
              {t('settings.noResources')}
            </p>
          )}
        </div>
      </SettingSection>
    </div>
  );
}
