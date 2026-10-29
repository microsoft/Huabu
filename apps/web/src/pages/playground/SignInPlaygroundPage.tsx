// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useSearchParams } from 'react-router-dom';

import { SignInScreen } from '@/components/Shell/SignInGate';

const ENTRA = {
  driver: 'entra',
  issuer: 'https://login.microsoftonline.com/tenant/v2.0',
  authorizationUrl:
    'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize',
  clientId: 'client',
  scopes: [],
};
const AUTH0 = {
  driver: 'auth0',
  issuer: 'https://huabu.example.auth0.com/',
  authorizationUrl: 'https://huabu.example.auth0.com/authorize',
  clientId: 'client',
  scopes: [],
};

/** Each sign-in gate screen with fixed data; `?state=` picks one. */
export default function SignInPlaygroundPage() {
  const [params] = useSearchParams();
  const which = params.get('state') ?? 'signIn';
  if (which === 'noAccess')
    return (
      <SignInScreen
        state={{
          kind: 'noAccess',
          identity: {
            provider: 'bubble',
            principal: {
              principalId: 'carol',
              kind: 'user',
              displayName: 'Carol Example',
            },
            member: false,
            owner: false,
          },
        }}
      />
    );
  return (
    <SignInScreen
      state={{
        kind: 'signIn',
        authenticators: which === 'single' ? [ENTRA] : [ENTRA, AUTH0],
        ...(which === 'error'
          ? { error: 'AADSTS50011: The redirect URI is not registered.' }
          : {}),
      }}
    />
  );
}
