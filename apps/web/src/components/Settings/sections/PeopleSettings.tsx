// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  listPeople,
  setPersonMember,
  setPersonWorkspaceRole,
  type Person,
  type WorkspaceRole,
} from '../../../api/people';
import { listWorkspaces } from '../../../api/workspace';
import { useIdentityStore } from '../../../store/identityStore';
import { Button } from '../../Common/Button';
import { Select } from '../../Common/Select';
import { toast } from '../../Common/Toast';
import { Toggle } from '../../Common/Toggle';

import type { WorkspaceDescriptor } from '../../../api/workspace';

const ROLES: WorkspaceRole[] = ['owner', 'editor', 'viewer'];

function personName(person: Person): string {
  const { principal } = person;
  return principal.displayName ?? principal.email ?? principal.principalId;
}

/**
 * Who may use this Huabu, and with which Workspace roles. Shown to
 * administrators of a Bubble deployment; changes apply on each person's
 * next request.
 */
export function PeopleSettings() {
  const { t } = useTranslation();
  const self = useIdentityStore((s) => s.identity?.principal.principalId);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceDescriptor[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [nextPeople, nextWorkspaces] = await Promise.all([
      listPeople(),
      listWorkspaces(),
    ]);
    setPeople(nextPeople);
    setWorkspaces(nextWorkspaces);
  }, []);

  useEffect(() => {
    void load().catch(() => toast(t('people.loadFailed'), { tone: 'danger' }));
  }, [load, t]);

  const change = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : t('people.saveFailed'), {
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  };

  const workspaceName = useMemo(() => {
    const names = new Map(workspaces.map((w) => [w.workspaceId, w.name]));
    return (workspaceId: string) => names.get(workspaceId) ?? workspaceId;
  }, [workspaces]);

  const roleOptions = ROLES.map((role) => ({
    value: role,
    label: t(`people.role.${role}`),
  }));

  if (!people)
    return <p className="text-fg-subtle text-sm">{t('people.loading')}</p>;

  return (
    <div className="space-y-3">
      <p className="text-fg-subtle text-xs">{t('people.intro')}</p>
      <ul className="divide-edge-default border-edge-default divide-y rounded-lg border">
        {people.map((person) => {
          const id = person.principal.principalId;
          const held = new Set(person.workspaces.map((w) => w.workspaceId));
          const addable = workspaces.filter((w) => !held.has(w.workspaceId));
          return (
            <li key={id} className="space-y-2 px-3 py-2.5">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-fg-default truncate text-sm">
                    {personName(person)}
                  </div>
                  <div className="text-fg-subtle truncate text-xs">
                    {person.admin
                      ? t('people.administrator')
                      : person.principal.email && person.principal.displayName
                        ? person.principal.email
                        : id}
                  </div>
                </div>
                <Toggle
                  label={t('people.access')}
                  checked={person.member || person.admin}
                  disabled={busy || person.admin || id === self}
                  onChange={(member) =>
                    void change(() => setPersonMember(id, member))
                  }
                />
              </div>
              {person.workspaces.length > 0 && (
                <ul className="space-y-1">
                  {person.workspaces.map(({ workspaceId, role }) => (
                    <li key={workspaceId} className="flex items-center gap-2">
                      <span className="text-fg-muted min-w-0 flex-1 truncate text-xs">
                        {workspaceName(workspaceId)}
                      </span>
                      <Select
                        size="sm"
                        options={roleOptions}
                        value={role}
                        disabled={busy}
                        ariaLabel={t('people.roleIn', {
                          workspace: workspaceName(workspaceId),
                        })}
                        onChange={(next) =>
                          void change(() =>
                            setPersonWorkspaceRole(id, workspaceId, next),
                          )
                        }
                      />
                      <Button
                        variant="ghost"
                        iconOnly
                        size="sm"
                        disabled={busy}
                        title={t('people.removeRole')}
                        onClick={() =>
                          void change(() =>
                            setPersonWorkspaceRole(id, workspaceId, null),
                          )
                        }
                      >
                        <X size={14} />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {addable.length > 0 && (
                <Select
                  size="sm"
                  variant="ghost"
                  options={addable.map((w) => ({
                    value: w.workspaceId,
                    label: w.name,
                  }))}
                  value=""
                  placeholder={t('people.addToWorkspace')}
                  disabled={busy}
                  onChange={(workspaceId) =>
                    void change(() =>
                      setPersonWorkspaceRole(id, workspaceId, 'viewer'),
                    )
                  }
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
