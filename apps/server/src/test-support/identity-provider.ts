// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createMasterKeyBubbleAuthenticator } from '@octostaff/bubble';

import type { BubbleAuthenticator } from '@octostaff/sdk';

/** The issuer every test sign-in names, as an Entra or Auth0 token's `iss` does. */
export const TEST_ISSUER = 'https://idp.test/';

/**
 * A Bubble verifier standing in for an Entra or Auth0 sign-in, beside the
 * master key. `Bearer idp:<subject>` signs in as that subject with
 * {@link TEST_ISSUER}, as Bubble's OIDC drivers report a verified token;
 * `Bearer idp-bot:<subject>` does so as a bot. Every other credential goes to
 * the master key `master-secret`, acting as `admin` unless the request names
 * another principal in `x-bubble-principal-id`.
 */
export function signInAuthenticator(): BubbleAuthenticator {
  const masterKey = createMasterKeyBubbleAuthenticator({
    masterKey: 'master-secret',
    defaultPrincipalId: 'admin',
  });
  return {
    authenticate(request) {
      const signedIn = request.authorization?.match(
        /^Bearer (idp|idp-bot):(\S+)$/,
      );
      if (!signedIn) return masterKey.authenticate(request);
      const [, kind, subject] = signedIn;
      return {
        principalId: subject!,
        subject,
        issuer: TEST_ISSUER,
        token: `${kind}:${subject}`,
        kind: kind === 'idp-bot' ? 'bot' : 'user',
        displayName: subject,
      };
    },
  };
}

/** Request headers for `subject` signing in through the identity provider. */
export function signIn(subject: string): { authorization: string } {
  return { authorization: `Bearer idp:${subject}` };
}
