// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { FloatingFocusManager, useFloating } from '@floating-ui/react';
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
import {
  beginLogin,
  completeLogin,
  refreshTokens,
  signInWithPopup,
  type SignedInTokens,
} from '../../utils/oidcLogin';
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
  | { kind: 'denied'; providerSignOut: boolean };

/** Bounds for rechecking a running app's session while the Server is unreachable. */
const RECHECK_MIN_MS = 2_000;
const RECHECK_MAX_MS = 30_000;

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
  const originalPrincipal = useRef<string | null>(null);
  const accountChanged = useRef(false);
  const renewing = useRef(false);
  const knownAuthenticators = useRef<InteractiveAuthenticator[]>([]);
  const renewalTimer = useRef<number | undefined>(undefined);
  const recheckTimer = useRef<number | undefined>(undefined);
  const recheckDelay = useRef(RECHECK_MIN_MS);

  /**
   * The Server could not say who is calling (a restart or a network blip), so
   * the cover stays up; ask again with backoff instead of waiting for a 401
   * that a stalled app never makes. Sign-in methods are fetched again too,
   * for a page that started from a session cookie and never listed them.
   */
  const recheckLater = useCallback(() => {
    window.clearTimeout(recheckTimer.current);
    recheckTimer.current = window.setTimeout(
      () => window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)),
      recheckDelay.current,
    );
    recheckDelay.current = Math.min(recheckDelay.current * 2, RECHECK_MAX_MS);
  }, []);

  /**
   * Hand fresh tokens to the Server, and renew them a minute before they
   * expire while this page holds a refresh token.
   */
  const adopt = useCallback(async (tokens: SignedInTokens) => {
    await startSession(tokens.accessToken);
    window.clearTimeout(renewalTimer.current);
    const expiresIn = tokens.expiresIn;
    if (
      typeof expiresIn === 'number' &&
      Number.isFinite(expiresIn) &&
      expiresIn > 90
    )
      renewalTimer.current = window.setTimeout(
        () => window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)),
        Math.min((expiresIn - 60) * 1000, 2 ** 31 - 1),
      );
  }, []);
  useEffect(
    () => () => {
      window.clearTimeout(renewalTimer.current);
      window.clearTimeout(recheckTimer.current);
    },
    [],
  );

  const check = useCallback(
    async (loginError?: string) => {
      if (accountChanged.current) return false;
      const run = ++latestCheck.current;
      const needsVerification =
        appStarted.current &&
        useIdentityStore.getState().identity?.provider === 'bubble';
      const settle = (next: GateState) => {
        if (run !== latestCheck.current) return;
        if (next.kind === 'ready') appStarted.current = true;
        setState((prior) =>
          next.kind === 'signIn' && prior.kind === 'signIn' && !loginError
            ? { ...next, error: next.error ?? prior.error }
            : next,
        );
      };
      let identity: IdentityResponse | null;
      try {
        identity = await getIdentity();
      } catch (error) {
        if (error instanceof IdentityDeniedError) {
          settle({ kind: 'denied', providerSignOut: error.providerSignOut });
          return;
        }
        // A running Bubble app stays covered until its principal is verified.
        // Local deployments keep their existing connection-error handling.
        if (!needsVerification) {
          settle({ kind: 'ready' });
          return;
        }
        recheckLater();
        if (knownAuthenticators.current.length === 0) {
          const listed = await listInteractiveAuthenticators().catch(
            () => null,
          );
          if (listed) knownAuthenticators.current = listed;
        }
        settle({
          kind: 'signIn',
          authenticators: knownAuthenticators.current,
          error:
            loginError ??
            (error instanceof Error ? error.message : String(error)),
        });
        return;
      }
      window.clearTimeout(recheckTimer.current);
      recheckDelay.current = RECHECK_MIN_MS;
      if (identity) {
        if (run !== latestCheck.current) return false;
        const principal = identity.principal.principalId;
        if (
          originalPrincipal.current &&
          originalPrincipal.current !== principal
        ) {
          accountChanged.current = true;
          window.clearTimeout(renewalTimer.current);
          setState({ kind: 'checking' });
          window.location.reload();
          return false;
        }
        originalPrincipal.current = principal;
        setIdentity(identity);
        settle(
          identity.member ? { kind: 'ready' } : { kind: 'noAccess', identity },
        );
        return identity.member;
      }
      let authenticators: InteractiveAuthenticator[] | null;
      try {
        authenticators = await listInteractiveAuthenticators();
      } catch {
        if (needsVerification) recheckLater();
        settle(
          needsVerification
            ? {
                kind: 'signIn',
                authenticators: knownAuthenticators.current,
                error: loginError,
              }
            : { kind: 'ready' },
        );
        return;
      }
      if (authenticators && run === latestCheck.current)
        knownAuthenticators.current = authenticators;
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
    [setIdentity, recheckLater],
  );

  /** Every recovery verifies the original principal before retrying saves. */
  const recover = useCallback(async () => {
    if (await check()) await resend();
  }, [check]);

  useEffect(() => {
    callback.current ??= (async () => {
      try {
        const tokens = await completeLogin();
        if (tokens) await adopt(tokens);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    void callback.current.then((loginError) => check(loginError));
  }, [check, adopt]);

  useEffect(() => {
    // A lapsed session renews in place when this page holds a refresh token;
    // whatever it refused is then sent again.
    const recheck = () => {
      if (renewing.current || accountChanged.current) return;
      renewing.current = true;
      void (async () => {
        try {
          const tokens = appStarted.current ? await refreshTokens() : null;
          if (tokens) await adopt(tokens);
          else renewing.current = false;
          await recover();
        } catch (error) {
          await check(error instanceof Error ? error.message : String(error));
        } finally {
          renewing.current = false;
        }
      })();
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, recheck);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, recheck);
  }, [check, adopt, recover]);

  /** Sign in again without leaving the page, then resend what was refused. */
  const signInInPlace = useCallback(
    async (authenticator: InteractiveAuthenticator) => {
      try {
        await adopt(await signInWithPopup(authenticator));
        await recover();
      } catch (error) {
        await check(error instanceof Error ? error.message : String(error));
      }
    },
    [adopt, check, recover],
  );

  const overlay = state.kind === 'signIn' && appStarted.current;
  const { refs, context } = useFloating({ open: overlay });
  if (state.kind === 'checking') return <WorkspaceLoadingScreen />;
  if (state.kind === 'ready' || (appStarted.current && state.kind === 'signIn'))
    return (
      <>
        <div className="contents" inert={overlay}>
          {children}
        </div>
        {overlay && state.kind === 'signIn' && (
          <FloatingFocusManager
            context={context}
            restoreFocus
            outsideElementsInert
            closeOnFocusOut={false}
          >
            <div
              ref={refs.setFloating}
              role="dialog"
              aria-modal="true"
              aria-labelledby="session-sign-in-title"
              tabIndex={-1}
              className="bg-bg-default/95 fixed inset-0 z-[1000]"
            >
              <SignInScreen state={state} onSignIn={signInInPlace} />
            </div>
          </FloatingFocusManager>
        )}
      </>
    );
  return <SignInScreen state={state} />;
}

async function resend(): Promise<void> {
  const { resendUnsavedCanvasEdits } = await import('../../store/canvasStore');
  await resendUnsavedCanvasEdits();
}

/** The sign-in and no-access screens, in the Welcome page's frame. */
export function SignInScreen({
  state,
  onSignIn,
}: {
  state: Exclude<GateState, { kind: 'checking' | 'ready' }>;
  /** Sign in without leaving the page; the provider's redirect otherwise. */
  onSignIn?: (authenticator: InteractiveAuthenticator) => Promise<void>;
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
          <h1
            id="session-sign-in-title"
            className="text-fg-default text-2xl font-bold"
          >
            {title}
          </h1>
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
                  void (onSignIn ?? beginLogin)(authenticator).then(
                    () => {
                      if (onSignIn) setPending(null);
                    },
                    () => setPending(null),
                  );
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
              void signOut({
                providerSignOut:
                  state.kind === 'noAccess'
                    ? state.identity.providerSignOut
                    : state.providerSignOut,
              }).catch(() => setSignOutFailed(true));
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

        {state.kind === 'signIn' && state.unsavedEdits && !onSignIn && (
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
