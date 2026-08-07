// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import 'i18next';

import type common from './resources/en/common.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      common: typeof common;
      agentTeam: Record<string, string>;
    };
  }
}
