// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

export const agentChangeReviewConfigSchema = z
  .object({
    autoAcceptSpaceChanges: z.boolean(),
  })
  .strict();

export type AgentChangeReviewConfig = z.infer<
  typeof agentChangeReviewConfigSchema
>;
