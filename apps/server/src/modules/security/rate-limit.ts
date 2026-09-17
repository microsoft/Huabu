// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export const GLOBAL_RATE_LIMIT_MAX = 1000;
export const GLOBAL_RATE_LIMIT_WINDOW = '1 minute';

export const GLOBAL_RATE_LIMIT_OPTIONS = {
  global: true,
  max: GLOBAL_RATE_LIMIT_MAX,
  timeWindow: GLOBAL_RATE_LIMIT_WINDOW,
  errorResponseBuilder: (
    _request: unknown,
    context: { statusCode: number },
  ) => ({
    statusCode: context.statusCode,
    message: 'Rate limit exceeded',
    code: 'rate_limit_exceeded',
  }),
} as const;
