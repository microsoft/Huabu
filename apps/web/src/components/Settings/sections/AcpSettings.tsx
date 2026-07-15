/**
 * External-agent settings section in the Settings popover.
 *
 * The section presents two stacked surfaces:
 *
 *  1. **Daemon health** — an inline status pill that's invisible on
 *     the happy path (`online: true`, no lastError). When the
 *     supervisor flips to `online: false` with a non-empty
 *     `lastError`, an amber banner appears with the error text + a
 *     **Restart worker** button. The supervisor auto-restarts with
 *     exponential backoff on its own; the manual button is the
 *     escape hatch when backoff has stretched too long or the user
 *     just fixed the underlying problem (e.g. installed agentlet on
 *     PATH).
 *
 *  2. **Profile list** — list + CRUD entry points for user-configured
 *     external agents. Each profile is a stable spawn recipe `{cli,
 *     command, cwd, autoRestart}` that the daemon launches on demand.
 *     Profiles persist across restarts; sessions follow the
 *     profileId, not the (volatile) agentlet agentId. The add/edit
 *     form itself lives in `./ProfileEditor` (shared with the chat
 *     panel's "Add agent" menu).
 *
 * **No more pairing terminal paste**: in daemon mode the server owns
 * the daemon lifecycle and the token never crosses the HTTP
 * boundary. The user only sees profiles + the optional troubleshoot
 * banner.
 */

import { AlertTriangle, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { deleteAcpProfile, restartAcpAgentlet } from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { Loading } from '@/components/Common/Loading';
import { Modal } from '@/components/Common/Modal';
import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { toast } from '@/components/Common/Toast';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';

import { ProfileEditorForm, useDetectedClis } from './ProfileEditor';

import type {
  AcpAgentProfile,
  AcpAgentletStatus,
  AcpCommandProfileView,
  AgentProfileView,
} from '@sediment/shared';

type DeletableProfile = AcpCommandProfileView | AcpAgentProfile;

function profileAlias(profile: DeletableProfile): string {
  return 'alias' in profile ? profile.alias : profile.displayName;
}

function isCommandProfile(
  profile: AgentProfileView,
): profile is AcpCommandProfileView {
  return !('preparation' in profile);
}

// ── Agentlet health banner ────────────────────────────────────────────

interface AgentletHealthBannerProps {
  agentlet: AcpAgentletStatus | null;
  onRestart: () => Promise<void>;
  restarting: boolean;
}

/**
 * Inline amber banner shown only when the agentlet supervisor is in a
 * known-failed state. The happy path (`online: true`, no error) renders
 * nothing so the section stays compact.
 */
const AgentletHealthBanner: React.FC<AgentletHealthBannerProps> = ({
  agentlet,
  onRestart,
  restarting,
}) => {
  const { t } = useTranslation();
  if (!agentlet) return null;
  if (agentlet.online && !agentlet.lastError) return null;

  const nextRestartInSec = agentlet.nextRestartAt
    ? Math.max(0, Math.ceil((agentlet.nextRestartAt - Date.now()) / 1000))
    : null;

  return (
    <div className="border-warning-light/60 bg-warning-light/15 mb-3 flex items-start gap-2 rounded-md border px-3 py-2">
      <AlertTriangle className="text-warning mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-fg-default text-xs font-medium">
          {t('settings.workerOffline')}
        </p>
        {agentlet.lastError && (
          <p className="text-fg-muted mt-0.5 text-[11px] leading-snug wrap-break-word">
            {agentlet.lastError}
          </p>
        )}
        {nextRestartInSec !== null && nextRestartInSec > 0 && (
          <p className="text-fg-subtle mt-0.5 text-[11px] leading-snug">
            {t('settings.nextAutoRetry', { seconds: nextRestartInSec })}
          </p>
        )}
      </div>
      <Button
        variant="outline"
        tone="info"
        size="sm"
        onClick={() => void onRestart()}
        disabled={restarting}
        title={t('settings.forceRestartWorker')}
        className="shrink-0"
      >
        <RefreshCw
          size={12}
          className={restarting ? 'animate-spin' : undefined}
        />
        <span>
          {restarting ? t('settings.restarting') : t('settings.restartWorker')}
        </span>
      </Button>
    </div>
  );
};

// ── Top-level section ────────────────────────────────────────────────

/**
 * `AcpSettings` — section rendered inside the Settings popover that
 * exposes the user's external-agent profiles + the daemon health
 * banner. The store loads its initial snapshot lazily; SettingsPopover
 * fires `init()` when the popover opens.
 */
export const AcpSettings: React.FC = () => {
  const { t } = useTranslation();
  const allProfiles = useAcpProfilesStore((s) => s.profiles);
  const legacyProfiles = useAcpProfilesStore((s) => s.legacyProfiles);
  const profiles = allProfiles.filter(isCommandProfile);
  const agentlet = useAcpProfilesStore((s) => s.agentlet);
  const loaded = useAcpProfilesStore((s) => s.loaded);
  const error = useAcpProfilesStore((s) => s.error);
  const refresh = useAcpProfilesStore((s) => s.refresh);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AcpCommandProfileView | null>(null);
  const { detectedClis, loaded: detectionLoaded } = useDetectedClis(editorOpen);
  const [restarting, setRestarting] = useState(false);
  // Destructive confirmation uses a `Modal` rather than `window.confirm` so
  // the dialog matches the rest of the app's UX (see `CanvasListPage` for
  // the same pattern). `pendingDelete` holds the profile awaiting
  // confirmation; `isDeleting` blocks the modal during the network call so
  // accidental backdrop / Escape dismissals don't strand the request.
  const [pendingDelete, setPendingDelete] = useState<DeletableProfile | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const confirmDeleteButtonRef = useRef<HTMLButtonElement>(null);

  // Surface fetch errors as transient toasts so the user notices even
  // if the section isn't scrolled into view. We deliberately ignore
  // any error that was already cached before this component mounted —
  // most commonly the workspace-not-configured 503 the store hit when
  // Settings was opened on the WorkspaceSetupPage. The store wipes
  // such errors on the next `workspace-changed` event, but the user
  // might re-open Settings before that fires; replaying a stale
  // message would be more confusing than helpful.
  const lastToastedRef = useRef<Error | null>(error);
  useEffect(() => {
    if (error && error !== lastToastedRef.current) {
      toast(error.message, { tone: 'danger' });
      lastToastedRef.current = error;
    }
  }, [error]);

  const handleNew = useCallback(() => {
    setEditing(null);
    setEditorOpen(true);
  }, []);

  const handleEdit = useCallback((profile: AcpCommandProfileView) => {
    setEditing(profile);
    setEditorOpen(true);
  }, []);

  const handleDelete = useCallback((profile: DeletableProfile) => {
    // Open the confirmation modal — the actual delete runs from
    // `confirmDelete` once the user clicks through. Profiles often have
    // non-trivial cwd config and re-typing them is annoying, so we want a
    // deliberate confirmation step.
    //
    // Profiles are templates: deleting one removes it from the menu and
    // prevents new threads from binding, but threads that already
    // snapshotted the recipe (v3+ records) keep running unchanged. The
    // modal copy below makes that explicit so users aren't surprised when
    // an open chat keeps responding after they delete the profile.
    setPendingDelete(profile);
  }, []);

  const closeDeleteModal = useCallback(() => {
    if (isDeleting) return;
    setPendingDelete(null);
  }, [isDeleting]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setIsDeleting(true);
    try {
      await deleteAcpProfile(pendingDelete.id);
      toast(t('settings.profileDeleted'), { tone: 'success' });
      await refresh();
      setPendingDelete(null);
    } catch (err) {
      toast(
        err instanceof Error ? err.message : t('settings.profileDeleteFailed'),
        {
          tone: 'danger',
        },
      );
    } finally {
      setIsDeleting(false);
    }
  }, [pendingDelete, refresh, t]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      const next = await restartAcpAgentlet();
      // Pull a fresh snapshot so the banner reflects the new state
      // (and the profile-list runtime flags update).
      await refresh();
      if (next.online) {
        toast(t('settings.workerRestarted'), { tone: 'success' });
      }
    } catch (err) {
      toast(
        err instanceof Error ? err.message : t('settings.workerRestartFailed'),
        {
          tone: 'danger',
        },
      );
    } finally {
      setRestarting(false);
    }
  }, [refresh, t]);

  const handleSaved = useCallback(async () => {
    await refresh();
  }, [refresh]);

  return (
    <>
      {/*
       * Daemon banner sits OUTSIDE the rounded section card on purpose:
       * (a) when the banner returns null we render nothing at all
       *     (no wrapper, no empty padding), and
       * (b) when it does show, the amber alert reads as a section-level
       *     warning rather than a torn-looking first row inside the card.
       */}
      <AgentletHealthBanner
        agentlet={agentlet}
        onRestart={handleRestart}
        restarting={restarting}
      />

      <SettingSection>
        {legacyProfiles.length > 0 && (
          <>
            {legacyProfiles.map((profile) => (
              <SettingRow
                key={profile.id}
                title={profile.displayName}
                description={t('settings.legacyAgentTeamProfilesDescription')}
              >
                <Button
                  variant="ghost"
                  tone="danger"
                  size="sm"
                  iconOnly
                  title={t('settings.deleteProfile')}
                  onClick={() => handleDelete(profile)}
                >
                  <Trash2 size={12} />
                </Button>
              </SettingRow>
            ))}
          </>
        )}
        {profiles.length === 0 ? (
          <SettingRow
            title={t('settings.noAgents')}
            description={t('settings.noAgentsDescription')}
          >
            <Button
              variant="outline"
              tone="info"
              size="sm"
              onClick={handleNew}
              disabled={!loaded}
            >
              <Plus size={12} />
              <span>{t('settings.addAgent')}</span>
            </Button>
          </SettingRow>
        ) : (
          <>
            {profiles.map((profile) => (
              <SettingRow key={profile.id} title={profile.alias}>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    tone="neutral"
                    size="sm"
                    iconOnly
                    title={t('settings.editProfile')}
                    onClick={() => handleEdit(profile)}
                  >
                    <Pencil size={12} />
                  </Button>
                  <Button
                    variant="ghost"
                    tone="danger"
                    size="sm"
                    iconOnly
                    title={t('settings.deleteProfile')}
                    onClick={() => handleDelete(profile)}
                  >
                    <Trash2 size={12} />
                  </Button>
                </div>
              </SettingRow>
            ))}
            <SettingRow
              title={t('settings.addAnotherAgent')}
              description={t('settings.addAnotherAgentDescription')}
            >
              <Button
                variant="outline"
                tone="info"
                size="sm"
                onClick={handleNew}
                disabled={!loaded}
              >
                <Plus size={12} />
                <span>{t('settings.addAgent')}</span>
              </Button>
            </SettingRow>
          </>
        )}
      </SettingSection>

      {/*
       * Inline add/edit form: opening the editor expands it *below* the
       * list (a "new row" pattern) instead of drilling in or stacking a
       * second modal — the profile list stays visible for context. The
       * chat panel's "Add agent" menu still uses `ProfileEditorModal`
       * since it has no host surface of its own.
       */}
      {editorOpen && (
        <div className="mt-3 flex flex-col gap-2">
          <h4 className="text-fg-muted px-1 text-xs font-medium">
            {editing
              ? t('settings.editExternalAgent')
              : t('settings.newExternalAgent')}
          </h4>
          <div className="border-edge-default bg-surface ring-edge-default/50 rounded-md p-4 shadow-sm ring-1">
            <ProfileEditorForm
              editing={editing}
              detectedClis={detectedClis}
              detectionLoaded={detectionLoaded}
              onClose={() => setEditorOpen(false)}
              onSaved={handleSaved}
            />
          </div>
        </div>
      )}

      {/*
       * Confirmation modal for destructive profile deletion. Mirrors the
       * `CanvasListPage` delete dialog so the app speaks with one voice
       * for destructive actions — no `window.confirm` anywhere.
       */}
      <Modal
        isOpen={pendingDelete !== null}
        title={t('settings.deleteExternalAgentTitle')}
        description={
          pendingDelete ? (
            <Trans
              i18nKey="settings.deleteExternalAgentDescription"
              values={{ name: profileAlias(pendingDelete) }}
              components={{
                name: <span className="text-fg-default font-medium" />,
              }}
            />
          ) : null
        }
        onClose={closeDeleteModal}
        initialFocusRef={confirmDeleteButtonRef}
        closeOnBackdropClick={!isDeleting}
        closeOnEscape={!isDeleting}
        footer={
          <>
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={closeDeleteModal}
              disabled={isDeleting}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              ref={confirmDeleteButtonRef}
              variant="solid"
              tone="danger"
              size="sm"
              onClick={() => void confirmDelete()}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <Loading
                  layout="inline"
                  size="sm"
                  className="text-fg-inverse"
                />
              ) : (
                t('actions.delete')
              )}
            </Button>
          </>
        }
      />
    </>
  );
};
