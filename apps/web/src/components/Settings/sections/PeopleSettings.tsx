// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { ResetDeviceCredentials } from './ResetDeviceCredentials';
import {
  getAdmission,
  listPeople,
  resetPersonDeviceCredentials,
  setAutomaticAdmission,
  setPersonMember,
  setPersonWorkspaceRole,
  type AdmissionSettings,
  type Person,
  type WorkspaceRole,
} from '../../../api/people';
import { listWorkspaces } from '../../../api/workspace';
import { useIdentityStore } from '../../../store/identityStore';
import { Button } from '../../Common/Button';
import { Select } from '../../Common/Select';
import { toast } from '../../Common/Toast';
import { Toggle } from '../../Common/Toggle';
import { SettingRow } from '../Common/SettingRow';
import { SettingSection } from '../Common/SettingSection';

import type { WorkspaceDescriptor } from '../../../api/workspace';

const ROLES: WorkspaceRole[] = ['owner', 'editor', 'viewer'];

function personName(person: Person): string {
  const { principal } = person;
  return principal.displayName ?? principal.email ?? principal.principalId;
}

function Badge({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] leading-none font-medium ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * Where a person stands with the service, shown beside their name, and how
 * they got there when automatic admission decided it.
 */
function AccessStatus({ person }: { person: Person }) {
  const { t } = useTranslation();
  const [label, className] = person.admin
    ? [t('people.status.administrator'), 'bg-info-bg text-info-fg']
    : person.member
      ? [t('people.status.admitted'), 'bg-success-bg text-success-fg']
      : person.blocked
        ? [t('people.status.blocked'), 'bg-danger-bg text-danger-fg']
        : person.blocked === null
          ? // The admission record is unreadable, so whether they were
            // removed or are waiting is unknown.
            [t('people.status.noAccess'), 'bg-hover text-fg-muted']
          : [t('people.status.waiting'), 'bg-warning-bg text-warning-fg'];
  return (
    <>
      <Badge className={className}>{label}</Badge>
      {person.member && !person.admin && person.joinedAutomatically && (
        <Badge className="bg-hover text-fg-muted">
          {t('people.status.joinedAutomatically')}
        </Badge>
      )}
    </>
  );
}

/**
 * The owner's switch for admitting everyone who signs in through the
 * configured identity providers, naming those providers so it never promises
 * more than they enforce.
 */
function AutomaticAdmission({
  admission,
  busy,
  onChange,
}: {
  admission: AdmissionSettings;
  busy: boolean;
  onChange: (automatic: boolean) => void;
}) {
  const { t } = useTranslation();
  const providers = admission.providers.map((provider) =>
    t(`people.admission.provider.${provider}`),
  );
  const description =
    providers.length > 0
      ? t('people.admission.description', {
          providers: providers.join(t('people.admission.providerSeparator')),
        })
      : t('people.admission.noProviders');
  return (
    <div className="space-y-1">
      {/* Its own parent, so the section is a last child and drops the
          bottom margin it keeps between sections: the note belongs to it. */}
      <div>
        <SettingSection>
          {/* Padded like the person rows below, so their text lines up. */}
          <SettingRow
            className="px-3"
            title={t('people.admission.title')}
            description={description}
          >
            <Toggle
              label={t('people.admission.title')}
              checked={admission.automatic}
              // Turning it off stays possible, to undo a switch made before the
              // providers changed.
              disabled={
                busy || (providers.length === 0 && !admission.automatic)
              }
              onChange={onChange}
            />
          </SettingRow>
        </SettingSection>
      </div>
      <p className="text-fg-subtle text-xs">
        {t('people.admission.keepsRemoved')}
      </p>
    </div>
  );
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
  // `unavailable` when it has never loaded: People still works without it.
  const [admission, setAdmission] = useState<
    AdmissionSettings | 'unavailable' | null
  >(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceDescriptor[]>([]);
  const [busy, setBusy] = useState(false);
  // Counts loads and saves. A load publishes its answers only while it is the
  // latest, so a slower, older read can never overwrite newer state.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    const latest = () => generation.current === current;
    // The admission setting loads on its own, so the list, each person's
    // Reset devices, and the end of a change, which re-enables every control,
    // neither wait for it nor fail with it.
    void getAdmission().then(
      (next) => {
        if (latest()) setAdmission(next);
      },
      () => {
        if (latest()) setAdmission((shown) => shown ?? 'unavailable');
      },
    );
    const [nextPeople, nextWorkspaces] = await Promise.all([
      listPeople(),
      listWorkspaces(),
    ]);
    if (latest()) {
      setPeople(nextPeople);
      setWorkspaces(nextWorkspaces);
    }
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
      <p className="text-fg-subtle text-xs">{t('people.accessVsWorkspace')}</p>
      {admission === 'unavailable' ? (
        <p className="text-danger-fg text-xs">
          {t('people.admission.loadFailed')}
        </p>
      ) : (
        admission && (
          <AutomaticAdmission
            admission={admission}
            busy={busy}
            onChange={(automatic) =>
              void change(async () => {
                const saved = await setAutomaticAdmission(automatic);
                // Shown as soon as it is saved, and every read begun before
                // the save is dropped, so neither a failed refresh nor an
                // older answer can leave the switch saying the opposite of
                // the policy.
                generation.current += 1;
                setAdmission(saved);
              })
            }
          />
        )
      )}
      <ul className="divide-edge-default border-edge-default @container divide-y rounded-lg border">
        {people.map((person) => {
          const id = person.principal.principalId;
          const held = new Set(person.workspaces.map((w) => w.workspaceId));
          const addable = workspaces.filter((w) => !held.has(w.workspaceId));
          return (
            <li key={id} className="space-y-2 px-3 py-2.5">
              {/* The person's name and email are what an administrator
                  decides on, so they wrap rather than truncate, and in a
                  narrow list the Service access switch moves below them. */}
              <div className="flex flex-col items-start gap-2 @md:flex-row @md:items-center @md:gap-3">
                <div className="w-full min-w-0 @md:w-auto @md:flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-fg-default min-w-0 text-sm [overflow-wrap:anywhere]">
                      {personName(person)}
                    </span>
                    <AccessStatus person={person} />
                  </div>
                  <div className="text-fg-subtle text-xs [overflow-wrap:anywhere]">
                    {person.principal.email && person.principal.displayName
                      ? person.principal.email
                      : id}
                  </div>
                </div>
                <div className="text-fg-muted flex shrink-0 items-center gap-2 text-xs">
                  <span aria-hidden>{t('people.serviceAccess')}</span>
                  <Toggle
                    label={`${t('people.serviceAccess')}: ${personName(person)}`}
                    checked={person.member || person.admin}
                    disabled={busy || person.admin || id === self}
                    onChange={(member) =>
                      void change(() => setPersonMember(id, member))
                    }
                  />
                </div>
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                {addable.length > 0 ? (
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
                ) : (
                  <span />
                )}
                <ResetDeviceCredentials
                  quiet
                  label={t('people.resetDevices')}
                  confirmation={t('people.resetDevicesConfirm', {
                    name: personName(person),
                  })}
                  done={t('people.resetDevicesDone', {
                    name: personName(person),
                  })}
                  onReset={() => resetPersonDeviceCredentials(id)}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
