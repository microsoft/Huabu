// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { resolveConfiguredPublicOrigin as resolveOrigin } from '@huabu/client-runtime';

import { getDeploymentEnvironment } from '../../security/deployment-settings.js';

export {
  InvalidPublicOriginError,
  normalizePublicOrigin,
} from '@huabu/client-runtime';

export function resolveConfiguredPublicOrigin(
  env: NodeJS.ProcessEnv = getDeploymentEnvironment(),
): string | undefined {
  return resolveOrigin(env);
}
