// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface RemoteServerProbeResult {
  authenticationRequired: boolean;
  realm?: string;
}

export interface BasicAuthCredentials {
  username: string;
  password: string;
}

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function isSameOrigin(url: string, expectedOrigin: string): boolean {
  try {
    return new URL(url).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function isDeploymentReadiness(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const readiness = value as Record<string, unknown>;
  return (
    typeof readiness.bind === 'object' &&
    readiness.bind !== null &&
    typeof readiness.access === 'object' &&
    readiness.access !== null &&
    typeof readiness.owner === 'object' &&
    readiness.owner !== null &&
    typeof readiness.transport === 'object' &&
    readiness.transport !== null &&
    Array.isArray(readiness.issues)
  );
}

export function hasBasicAuthChallenge(header: string | null): boolean {
  return header ? /(?:^|,)\s*Basic(?:\s|$)/i.test(header) : false;
}

function basicAuthRealm(header: string | null): string {
  const match = header?.match(
    /(?:^|,)\s*Basic\s+[^,]*realm=(?:"([^"]*)"|([^,\s]*))/i,
  );
  return match?.[1] || match?.[2] || 'Huabu';
}

export async function probeRemoteServer(
  serverOrigin: string,
  fetchImpl: Fetch = fetch,
  timeoutMs = 10_000,
  credentials?: BasicAuthCredentials,
): Promise<RemoteServerProbeResult> {
  const readinessUrl = new URL('/api/deployment/readiness', serverOrigin);
  let response: Response;
  try {
    response = await fetchImpl(readinessUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      ...(credentials
        ? {
            headers: {
              Authorization: `Basic ${Buffer.from(
                `${credentials.username}:${credentials.password}`,
                'utf8',
              ).toString('base64')}`,
            },
          }
        : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot connect to the remote Huabu Server at ${serverOrigin}: ${detail}`,
    );
  }

  if (response.status === 401) {
    const challenge = response.headers.get('www-authenticate');
    if (!hasBasicAuthChallenge(challenge)) {
      throw new Error(
        `The remote server at ${serverOrigin} returned HTTP 401 without a Basic Auth challenge.`,
      );
    }
    return {
      authenticationRequired: true,
      realm: basicAuthRealm(challenge),
    };
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    const target = location
      ? new URL(location, serverOrigin).origin
      : 'another address';
    throw new Error(
      `The remote server at ${serverOrigin} redirects to ${target}. Set HUABU_PUBLIC_ORIGIN to the final Huabu Server origin instead.`,
    );
  }
  if (response.status === 403) {
    throw new Error(
      `The remote Huabu Server at ${serverOrigin} rejected this host or origin. Check HUABU_ALLOWED_HOSTS and the reverse-proxy Host header.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `The remote server at ${serverOrigin} returned HTTP ${response.status} from /api/deployment/readiness.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      `The remote server at ${serverOrigin} did not return a valid Huabu deployment-readiness response.`,
    );
  }
  if (!isDeploymentReadiness(body)) {
    throw new Error(
      `The remote server at ${serverOrigin} is not a compatible Huabu Server.`,
    );
  }
  return { authenticationRequired: false };
}
