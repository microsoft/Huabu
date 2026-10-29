// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AUTH_REQUIRED_EVENT } from '../../api/_client';
import {
  getIdentity,
  IdentityDeniedError,
  listInteractiveAuthenticators,
  signOut,
  startSession,
  type InteractiveAuthenticator,
} from '../../api/identity';
import { API_CONFIG } from '../../config/api';
import { APP_NAME } from '../../config/app';
import { WorkspaceLoadingScreen } from '../../pages/WorkspaceLoadingScreen';
import { useIdentityStore } from '../../store/identityStore';
import { beginLogin, completeLogin } from '../../utils/oidcLogin';
import { Button } from '../Common/Button';

import type { IdentityResponse } from '@huabu/shared';
import type { ReactNode } from 'react';

type GateState =
  | { kind: 'checking' }
  | { kind: 'ready' }
  | {
      kind: 'signIn';
      authenticators: InteractiveAuthenticator[];
      error?: string;
      /** The session lapsed with edits the Server never received. */
      unsavedEdits?: boolean;
      /** The API is on another origin, where the session cookie never goes. */
      crossOrigin?: boolean;
    }
  | { kind: 'noAccess'; identity: IdentityResponse }
  /** The provider refused the account itself, such as a disabled one. */
  | { kind: 'denied' };

/**
 * The session is an HttpOnly cookie for this origin, which an API on any
 * other origin (`VITE_API_BASE`) neither receives nor can set.
 */
function sameOriginApi(): boolean {
  if (!API_CONFIG.BASE_URL) return true;
  return (
    new URL(API_CONFIG.BASE_URL, window.location.href).origin ===
    window.location.origin
  );
}

const PROVIDER_NAMES: Record<string, string> = {
  entra: 'Microsoft Entra ID',
  auth0: 'Auth0',
};

/**
 * Admits the app once the Server knows who is calling. A local deployment
 * resolves at once and renders exactly as before; under Bubble identity a
 * caller without a session signs in through the provider Bubble names, and
 * one without Huabu access is told so instead of meeting failing requests.
 */
export function SignInGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: 'checking' });
  const setIdentity = useIdentityStore((s) => s.setIdentity);
  // Only the latest check may decide: an earlier one can still be waiting
  // on a response from before the session existed.
  const latestCheck = useRef(0);
  // The provider's redirect is consumed once per mount, however often the
  // effect runs, so no check starts before its session does.
  const callback = useRef<Promise<string | undefined>>(undefined);
  // Once the app has run, a lapsed session can strand its unsaved edits.
  const appStarted = useRef(false);

  const check = useCallback(
    async (loginError?: string) => {
      const run = ++latestCheck.current;
      const settle = (next: GateState) => {
        if (run !== latestCheck.current) return;
        if (next.kind === 'ready') appStarted.current = true;
        setState(next);
      };
      let identity: IdentityResponse | null;
      try {
        identity = await getIdentity();
      } catch (error) {
        // An unreachable Server is the app's own error to report, as before.
        settle(
          error instanceof IdentityDeniedError
            ? { kind: 'denied' }
            : { kind: 'ready' },
        );
        return;
      }
      if (identity) {
        if (run !== latestCheck.current) return;
        setIdentity(identity);
        settle(
          identity.member ? { kind: 'ready' } : { kind: 'noAccess', identity },
        );
        return;
      }
      let authenticators: InteractiveAuthenticator[] | null;
      try {
        authenticators = await listInteractiveAuthenticators();
      } catch {
        settle({ kind: 'ready' });
        return;
      }
      // Without Bubble a login prompt belongs to the browser (Basic Auth).
      if (!authenticators) {
        settle({ kind: 'ready' });
        return;
      }
      if (!sameOriginApi()) {
        settle({ kind: 'signIn', authenticators: [], crossOrigin: true });
        return;
      }
      // The provider's redirect leaves the page, and the expired session
      // cannot save on the way out, so say what would be lost.
      const unsavedEdits =
        appStarted.current &&
        (await import('../../store/canvasStore')).hasUnsavedCanvasEdits();
      settle({
        kind: 'signIn',
        authenticators,
        error: loginError,
        unsavedEdits,
      });
    },
    [setIdentity],
  );

  useEffect(() => {
    callback.current ??= (async () => {
      try {
        const token = await completeLogin();
        if (token) await startSession(token);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    void callback.current.then((loginError) => check(loginError));
  }, [check]);

  useEffect(() => {
    const recheck = () => void check();
    window.addEventListener(AUTH_REQUIRED_EVENT, recheck);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, recheck);
  }, [check]);

  if (state.kind === 'ready') return <>{children}</>;
  if (state.kind === 'checking') return <WorkspaceLoadingScreen />;
  return <SignInScreen state={state} />;
}

/** The sign-in and no-access screens, in the Welcome page's frame. */
export function SignInScreen({
  state,
}: {
  state: Exclude<GateState, { kind: 'checking' | 'ready' }>;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<string | null>(null);
  const [signOutFailed, setSignOutFailed] = useState(false);

  const title =
    state.kind === 'signIn'
      ? t('auth.signInTitle', { appName: APP_NAME })
      : t('auth.noAccessTitle');
  const intro =
    state.kind === 'signIn'
      ? t('auth.signInIntro')
      : state.kind === 'denied'
        ? t('auth.deniedIntro', { appName: APP_NAME })
        : t('auth.noAccessIntro', {
            name:
              state.identity.principal.displayName ??
              state.identity.principal.email ??
              state.identity.principal.principalId,
            appName: APP_NAME,
          });

  return (
    <div className="bg-bg-default flex h-full items-center justify-center">
      <div className="w-full max-w-md px-6">
        <div className="mb-10 text-center">
          <img
            src="/favicon.svg"
            alt={APP_NAME}
            className="mx-auto mb-4 h-16 w-16"
          />
          <h1 className="text-fg-default text-2xl font-bold">{title}</h1>
          <p className="text-fg-subtle mt-2 text-sm">{intro}</p>
        </div>

        {state.kind === 'signIn' && state.authenticators.length === 0 ? (
          <p className="text-fg-subtle text-center text-sm" role="status">
            {state.crossOrigin
              ? t('auth.crossOriginUnsupported')
              : t('auth.noSignInMethods')}
          </p>
        ) : state.kind === 'signIn' ? (
          <div className="space-y-2">
            {state.authenticators.map((authenticator) => (
              <Button
                key={`${authenticator.driver}:${authenticator.issuer}`}
                variant="outline"
                tone="neutral"
                size="lg"
                className="w-full"
                disabled={pending !== null}
                onClick={() => {
                  setPending(authenticator.issuer);
                  void beginLogin(authenticator).catch(() => setPending(null));
                }}
              >
                {pending === authenticator.issuer
                  ? t('auth.signingIn')
                  : t('auth.continueWith', {
                      provider:
                        PROVIDER_NAMES[authenticator.driver] ??
                        authenticator.driver,
                    })}
              </Button>
            ))}
          </div>
        ) : (
          <Button
            variant="outline"
            tone="neutral"
            size="lg"
            className="w-full"
            onClick={() => {
              setSignOutFailed(false);
              void signOut().catch(() => setSignOutFailed(true));
            }}
          >
            {t('auth.signOut')}
          </Button>
        )}

        {signOutFailed && (
          <p
            className="text-danger-fg mt-3 text-center text-xs"
            role="alert"
            aria-live="assertive"
          >
            {t('auth.signOutFailed')}
          </p>
        )}

        {state.kind === 'signIn' && state.unsavedEdits && (
          <p className="text-danger-fg mt-3 text-center text-xs" role="alert">
            {t('auth.signInUnsaved')}
          </p>
        )}

        {state.kind === 'signIn' && state.error && (
          <p
            className="text-danger-fg mt-3 text-center text-xs"
            role="alert"
            aria-live="assertive"
          >
            {t('auth.signInFailed', { message: state.error })}
          </p>
        )}
      </div>
    </div>
  );
}
