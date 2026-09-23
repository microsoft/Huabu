// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export type IdentityConfig =
  | { provider: 'local'; username?: string; password?: string }
  | { provider: 'bubble'; baseUrl: string };

export function resolveIdentityConfig(
  env: NodeJS.ProcessEnv = process.env,
): IdentityConfig {
  const provider = env.HUABU_IDENTITY_PROVIDER ?? 'local';
  if (provider === 'local') {
    if (env.HUABU_BUBBLE_URL)
      throw new Error(
        'HUABU_BUBBLE_URL requires HUABU_IDENTITY_PROVIDER=bubble',
      );
    if (
      Boolean(env.HUABU_BASIC_AUTH_USER) !== Boolean(env.HUABU_BASIC_AUTH_PASS)
    ) {
      throw new Error(
        'HUABU_BASIC_AUTH_USER and HUABU_BASIC_AUTH_PASS must be configured together',
      );
    }
    return {
      provider,
      username: env.HUABU_BASIC_AUTH_USER,
      password: env.HUABU_BASIC_AUTH_PASS,
    };
  }
  if (provider !== 'bubble')
    throw new Error('HUABU_IDENTITY_PROVIDER must be local or bubble');
  if (env.HUABU_BASIC_AUTH_USER || env.HUABU_BASIC_AUTH_PASS) {
    throw new Error(
      'Bubble identity cannot be combined with HUABU_BASIC_AUTH_USER or HUABU_BASIC_AUTH_PASS',
    );
  }
  return { provider, baseUrl: validateBubbleUrl(env.HUABU_BUBBLE_URL) };
}

export function validateBubbleUrl(raw: string | undefined): string {
  let url: URL;
  try {
    url = new URL(raw ?? '');
  } catch {
    throw new Error('HUABU_BUBBLE_URL must be an absolute Bubble base URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'HUABU_BUBBLE_URL requires HTTPS (or loopback HTTP), without credentials, query, or fragment',
    );
  }
  return url.toString().replace(/\/$/, '');
}
